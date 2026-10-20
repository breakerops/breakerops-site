// telnyx-inbound: inbound SMS from the BreakerOps number. NOT DEPLOYED yet.
// This is the missing inbound half of the Matt conversation path (the deployed
// telnyx-webhook only handles delivery receipts). On each inbound text:
//   1. Normalize the sender phone.
//   2. invite_redeem_on_inbound: admit a phone holding a valid invitation
//      (creates their separate business), recognize an admitted phone, or
//      return 'none' for the public lead path.
//   3. Route by status. ALL outbound replies are gated: unless
//      TELNYX_SEND_ENABLED=true and Telnyx credentials are set, nothing is
//      sent and the message is only logged for the desk. No SMS spend,
//      no prospect contact without authority.
// Auth: shared secret in the ?key= query param, same pattern as telnyx-webhook.
// TODO: verify Telnyx ed25519 signatures once the account is live.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!Deno.env.get("REMINDERS_KEY") || url.searchParams.get("key") !== Deno.env.get("REMINDERS_KEY")) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const evt = await req.json().catch(() => ({}));
    const data = evt?.data ?? {};
    if (data.event_type !== "message.received") {
      return json({ ok: true, ignored: data.event_type ?? null });
    }
    const p = data.payload ?? {};
    const from = normalizePhone(p?.from?.phone_number ?? p?.from ?? "");
    const text = String(p?.text ?? "").slice(0, 1000);
    if (!from) return json({ error: "no sender" }, 400);

    const { data: admission, error } = await supabase.rpc("invite_redeem_on_inbound", { p_phone: from });
    const gated = Deno.env.get("TELNYX_SEND_ENABLED") !== "true";
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
