// telnyx-inbound: inbound SMS from the BreakerOps number. NOT DEPLOYED yet.
// This is the missing inbound half of the Matt conversation path (the deployed
// telnyx-webhook only handles delivery receipts).
//
// SENDER IDENTITY IS NOT TRUSTED UNTIL THE WEBHOOK IS SIGNATURE-VERIFIED.
// SMS sender numbers can be spoofed; admission, routing, and any business
// action depend on the from-phone only after the Telnyx ed25519 signature
// checks out. When TELNYX_WEBHOOK_PUBLIC_KEY is unset this handler refuses
// to admit or route (fails closed) - there is no "trust the number anyway" mode.
//
// Flow per inbound text (after verification + replay check):
//   1. Normalize the sender phone.
//   2. invite_redeem_on_inbound: admit a phone holding a valid invitation
//      (creates their separate business), recognize an admitted phone, or
//      return 'none' for the public lead path.
//   3. Route by status. ALL outbound replies are gated: unless
//      TELNYX_SEND_ENABLED=true, nothing is sent. No SMS spend, no prospect
//      contact without authority.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Telnyx signs `${timestamp}|${rawBody}` with ed25519; verify with the account's
// public key (owner pastes it into this secret when the account goes live).
// Untested against a live account until then - treat first live test as verification.
async function verifyTelnyx(req: Request, rawBody: string): Promise<boolean> {
  const b64 = Deno.env.get("TELNYX_WEBHOOK_PUBLIC_KEY");
  if (!b64) return false;
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts = req.headers.get("telnyx-timestamp");
  if (!sig || !ts) return false;
  // replay window: reject events older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
      { name: "Ed25519" }, false, ["verify"],
    );
    const data = new TextEncoder().encode(`${ts}|${rawBody}`);
    const signature = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data);
  } catch {
    return false;
  }
}

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
}

function normalizePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (/^\+\d{8,15}$/.test(raw)) return raw;
  return null;
}

// Compliance auto-replies (STOP/START/HELP) are carrier-required responses,
// not marketing. They use the same Telnyx connection as reminders-send and
// are gated by TELNYX_SEND_ENABLED like every other outbound text.
async function sendSms(to: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const { data: rows, error: cerr } = await supabase.rpc("get_connection", { p_provider: "telnyx" });
  const conn = rows?.[0];
  if (cerr || !conn?.api_key || !conn?.meta?.from_number) return { ok: false, error: "sms provider not configured" };
  try {
    const payload: Record<string, string> = { from: conn.meta.from_number, to, text };
    if (conn.meta?.messaging_profile_id) payload.messaging_profile_id = conn.meta.messaging_profile_id;
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok ? { ok: true } : { ok: false, error: `telnyx ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

Deno.serve(async (req) => {
  const rawBody = await req.text();
  if (!(await verifyTelnyx(req, rawBody))) {
    // fail closed: no admission, no routing, no desk note leak about contents
    return json({ error: "unverified" }, 401);
  }
  try {
    const evt = JSON.parse(rawBody || "{}");
    const data = evt?.data ?? {};
    if (data.event_type !== "message.received") {
      return json({ ok: true, ignored: data.event_type ?? null });
    }
    const p = data.payload ?? {};
    const from = normalizePhone(p?.from?.phone_number ?? p?.from ?? "");
    const text = String(p?.text ?? "").slice(0, 1000);
    if (!from) return json({ error: "no sender" }, 400);

    const gated = Deno.env.get("TELNYX_SEND_ENABLED") !== "true";

    // STOP/START/HELP per the published sms-terms. These short-circuit all
    // other routing; the confirmation text is the "one final text" the terms
    // promise. Opt-out rows are honored by reminders-send before every send.
    const kw = text.trim().toUpperCase().replace(/\s+/g, " ");
    if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(kw)) {
      await supabase.from("sms_opt_outs").upsert(
        { phone: from, opted_out_at: new Date().toISOString(), keyword: kw },
        { onConflict: "phone" }
      );
      const reply = "BreakerOps: You are unsubscribed and will receive no more texts. Reply START to resubscribe.";
      const sent = gated ? { ok: false, error: "send disabled" } : await sendSms(from, reply);
      return json({ ok: true, status: "opted_out", send: gated ? "disabled" : "enabled", reply_sent: sent.ok, reply_error: sent.error ?? null });
    }
    if (["START", "UNSTOP"].includes(kw)) {
      await supabase.from("sms_opt_outs").delete().eq("phone", from);
      const reply = "BreakerOps: You are resubscribed to texts. Reply STOP to opt out, HELP for help. Msg&data rates may apply.";
      const sent = gated ? { ok: false, error: "send disabled" } : await sendSms(from, reply);
      return json({ ok: true, status: "opted_in", send: gated ? "disabled" : "enabled", reply_sent: sent.ok, reply_error: sent.error ?? null });
    }
    if (kw === "HELP") {
      const reply = "BreakerOps: morning day text + reminders you ask for. Reply STOP to opt out. Msg&data rates may apply. Help: matt@breakerops.com";
      const sent = gated ? { ok: false, error: "send disabled" } : await sendSms(from, reply);
      return json({ ok: true, status: "help", send: gated ? "disabled" : "enabled", reply_sent: sent.ok, reply_error: sent.error ?? null });
    }

    const { data: admission, error } = await supabase.rpc("invite_redeem_on_inbound", { p_phone: from });
    if (error) {
      // activation disabled or a data problem: log for the desk, never reply blindly
      return json({ ok: true, status: "unrouted", reason: String(error.message || error), send: "disabled" });
    }
    const status = admission?.status ?? "none";
    // Routing, all concierge until the Matt handler is built:
    //  admitted -> welcome text from Matt + notify the inviter (both gated)
    //  member   -> Matt conversation (desk today)
    //  none     -> existing public lead path (desk notification)
    return json({ ok: true, status, send: gated ? "disabled" : "enabled", preview: text.slice(0, 80) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
