// reminders-send: called every minute by pg_cron. Claims due reminders and
// delivers them through one channel interface: log, email (Resend), sms (Telnyx).
// Adding or swapping a channel touches only sendVia().
// SMS config lives server-side in private.connections (provider 'telnyx': api key,
// meta.from_number, optional meta.messaging_profile_id), entered at /admin.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHARED_KEY = Deno.env.get("REMINDERS_KEY") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { global: { headers: { "x-reminders-key": SHARED_KEY } } }
);

type SendResult = { ok: boolean; providerId?: string; error?: string; uncertain?: boolean };

async function sendVia(channel: string, to: string, body: string): Promise<SendResult> {
  if (channel === "log") {
    console.log("REMINDER", to, body);
    return { ok: true, providerId: "log" };
  }
  if (channel === "email") {
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return { ok: false, error: "email provider not configured" };
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "BreakerOps <auth@breakerops.com>",
          to, subject: "BreakerOps reminder", text: body,
        }),
      });
      if (res.ok) return { ok: true, providerId: (await res.json()).id };
      return { ok: false, error: `resend ${res.status}` };        // clear rejection: retryable later
    } catch (e) {
      return { ok: false, uncertain: true, error: String(e) };    // unknown network outcome
    }
  }
  if (channel === "sms") {
    const { data: rows, error: cerr } = await supabase.rpc("get_connection", { p_provider: "telnyx" });
    const conn = rows?.[0];
    if (cerr || !conn?.api_key) return { ok: false, error: "sms provider not configured" };
    const from = conn.meta?.from_number;
    if (!from) return { ok: false, error: "sms sender number not configured" };
    try {
      const payload: Record<string, string> = { from, to, text: body };
      if (conn.meta?.messaging_profile_id) payload.messaging_profile_id = conn.meta.messaging_profile_id;
      const res = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, providerId: j?.data?.id };
      return { ok: false, error: `telnyx ${res.status}: ${JSON.stringify(j?.errors ?? j).slice(0, 300)}` };
    } catch (e) {
      return { ok: false, uncertain: true, error: String(e) };
    }
  }
  return { ok: false, error: "unknown channel" };
}

Deno.serve(async (req) => {
  if (!SHARED_KEY || req.headers.get("x-reminders-key") !== SHARED_KEY) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: due, error } = await supabase.rpc("claim_due_reminders", { batch_size: 25 });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const r of due ?? []) {
    const out = await sendVia(r.recipient_channel, r.recipient, r.body);
    const patch = out.ok
      ? { status: "sent", provider_id: out.providerId, sent_at: new Date().toISOString(), error: null }
      : out.uncertain
        ? { status: "uncertain", error: out.error }   // held for review, never silently retried
        : { status: "failed", error: out.error };
    await supabase.from("reminders").update(patch).eq("id", r.id);
    results.push({ id: r.id, ...patch });
  }
  return Response.json({ claimed: due?.length ?? 0, results });
});
