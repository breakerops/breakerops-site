// reminders-send: called every minute by pg_cron. Claims due reminders and
// delivers them through one channel interface: log, email (Resend), sms (Telnyx).
// Adding or swapping a channel touches only sendVia().
// SMS config lives server-side in private.connections (provider 'telnyx': api key,
// meta.from_number, optional meta.messaging_profile_id), entered at /admin.
// SMS truth: a Telnyx 200 only means the API accepted the message. Carrier
// rejections (unregistered sender, no 10DLC campaign attached) arrive later on
// the delivery webhook, so sms rows go to "accepted" until telnyx-webhook
// confirms. Rows stuck "accepted" over 15 minutes are swept to "uncertain".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHARED_KEY = Deno.env.get("REMINDERS_KEY") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { global: { headers: { "x-reminders-key": SHARED_KEY } } }
);

// One reply envelope, no application-level SMS fan-out. Preserve all facts:
// if it will exceed two SMS segments, reject for rewriting; never truncate.
function mergeReply(value: any): string {
  if (Array.isArray(value)) return value.map(mergeReply).filter(Boolean).join(" ");
  if (value && typeof value === "object") return mergeReply(value.text ?? value.content ?? value.messages ?? "");
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function fitsReply(text: string): boolean {
  const gsm = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const ext = "^{}\\[~]|€";
  let units = 0;
  for (const char of text) {
    if (gsm.includes(char)) units++;
    else if (ext.includes(char)) units += 2;
    else return text.length <= 134; // 2 concatenated UCS-2 segments
  }
  return units <= 306; // 2 concatenated GSM-7 segments
}

type SendResult = { ok: boolean; accepted?: boolean; providerId?: string; error?: string; uncertain?: boolean };

function currentPreviewLinks(body: string): string {
  return body.replace(/\b(?:https?:\/\/)?(?:www\.)?breakerops\.com(?:\/[^\s<>"']*)?/gi, (raw) => {
    const suffix = raw.match(/[.,!;)]+$/)?.[0] || "";
    const clean = suffix ? raw.slice(0, -suffix.length) : raw;
    try {
      const url = new URL(/^https?:/.test(clean) ? clean : "https://" + clean);
      url.searchParams.set("v", "2");
      return url.toString() + suffix;
    } catch { return raw; }
  });
}

async function sendVia(channel: string, to: string, body: string): Promise<SendResult> {
  body = currentPreviewLinks(body);
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
    body = mergeReply(body);
    if (!body || !fitsReply(body)) return { ok: false, error: "reply_needs_shortening: one reply, at most two SMS segments; nothing sent" };
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
      // 200 = accepted by Telnyx, NOT delivered. telnyx-webhook finalizes.
      if (res.ok) return { ok: true, accepted: true, providerId: j?.data?.id };
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
  // Sweep: sms rows the carrier never finalized within 15 minutes. Held for
  // review like other uncertain outcomes - never silently retried.
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await supabase.from("reminders")
    .update({ status: "uncertain", error: "no carrier delivery confirmation within 15 minutes" })
    .eq("status", "accepted")
    .lt("accepted_at", cutoff);

  const { data: due, error } = await supabase.rpc("claim_due_reminders", { batch_size: 25 });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results = [];
  for (const r of due ?? []) {
    const out = await sendVia(r.recipient_channel, r.recipient, r.body);
    const patch = out.ok
      ? out.accepted
        ? { status: "accepted", provider_id: out.providerId, accepted_at: new Date().toISOString(), error: null }
        : { status: "sent", provider_id: out.providerId, sent_at: new Date().toISOString(), error: null }
      : out.uncertain
        ? { status: "uncertain", error: out.error }   // held for review, never silently retried
        : { status: "failed", error: out.error };
    await supabase.from("reminders").update(patch).eq("id", r.id);
    results.push({ id: r.id, ...patch });
  }
  return Response.json({ claimed: due?.length ?? 0, results });
});
