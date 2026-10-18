// reminders-send: called every minute by pg_cron. Claims due reminders and
// delivers them through one channel interface: log, email (Resend), sms (Twilio).
// Adding or swapping a channel touches only sendVia().
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHARED_KEY = Deno.env.get("REMINDERS_KEY") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
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
    const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const token = Deno.env.get("TWILIO_AUTH_TOKEN");
    const from = Deno.env.get("TWILIO_FROM");
    if (!sid || !token || !from) return { ok: false, error: "sms provider not configured" };
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: "Basic " + btoa(`${sid}:${token}`),
                   "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
      });
      if (res.ok) return { ok: true, providerId: (await res.json()).sid };
      return { ok: false, error: `twilio ${res.status}` };
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
