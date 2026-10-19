// telnyx-webhook: delivery status updates from Telnyx. A Telnyx 200 on
// /v2/messages only means the API accepted the message; the carrier verdict
// (delivered, or rejected: unregistered sender, no 10DLC campaign attached,
// handset unreachable) arrives here on message.finalized. This function moves
// "accepted" reminders to their true final state: "sent" on delivered,
// "failed" with the carrier error otherwise. A failed brief (created_by
// 'brief-engine') also fires a desk email so a morning text never drops
// silently.
// Auth: shared secret in the ?key= query param of the webhook URL, entered on
// the Telnyx messaging profile (owner action when Telnyx goes live).
// TODO: verify Telnyx ed25519 webhook signatures once the account is live.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHARED_KEY = Deno.env.get("REMINDERS_KEY") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!SHARED_KEY || url.searchParams.get("key") !== SHARED_KEY) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const evt = await req.json().catch(() => ({}));
    const data = evt?.data ?? {};
    if (data.event_type !== "message.finalized") {
      return Response.json({ ok: true, ignored: data.event_type ?? null });
    }
    const p = data.payload ?? {};
    const providerId = p.id;
    if (!providerId) return Response.json({ error: "no message id" }, { status: 400 });
    const toStatus = Array.isArray(p.to) ? p.to[0]?.status : undefined;
    const delivered = toStatus === "delivered";
    const errText = Array.isArray(p.errors) && p.errors.length
      ? p.errors.map((e) => `${e.code ?? ""} ${e.title ?? ""} ${e.detail ?? ""}`.trim()).join("; ").slice(0, 500)
      : `telnyx status: ${toStatus ?? "unknown"}`;

    const { data: rows, error } = await supabase
      .from("reminders")
      .update(delivered
        ? { status: "sent", sent_at: new Date().toISOString(), error: null }
        : { status: "failed", error: errText })
      .eq("provider_id", providerId)
      .eq("status", "accepted")
      .select("id, created_by, recipient");
    if (error) return Response.json({ error: error.message }, { status: 500 });

    const r = rows?.[0];
    if (r && !delivered && r.created_by === "brief-engine") {
      // a customer's or the owner's morning brief failed: make noise, don't drop silently
      const note = fetch("https://formsubmit.co/ajax/nick@breakerops.com", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Referer: "https://www.breakerops.com/admin/" },
        body: JSON.stringify({
          _subject: "BreakerOps brief delivery FAILED",
          reminder_id: r.id,
          recipient: r.recipient,
          error: errText,
          time: new Date().toISOString(),
          _template: "table",
        }),
      }).catch(() => {});
      try { (globalThis as any).EdgeRuntime?.waitUntil?.(note); } catch (_) { /* ignore */ }
    }
    return Response.json({ ok: true, updated: rows?.length ?? 0 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
