// billing-webhook: NONLIVE SCAFFOLD. Two modes:
//   BILLING_MODE=placeholder  - current behavior: trusts nothing, logs the
//                               posted body to billing_events with
//                               provider='placeholder', changes no state.
//   STRIPE_WEBHOOK_SECRET set - verifies the Stripe-Signature header per the
//                               official manual scheme (stripe-signature.ts)
//                               BEFORE anything else; unverified requests get
//                               400 and are NOT logged (no attacker-chosen
//                               payload reaches the ledger). Verified events
//                               are logged with provider='stripe' and STILL
//                               change no state: no event-type mapping is
//                               approved, so nothing here can activate,
//                               cancel or charge. This is verification
//                               plumbing, not payment readiness: no Stripe
//                               account, keys or prices exist.
// Idempotency (official guidance): provider+provider_event_id is the dedupe
// key; an already-logged event gets 200 so retries stop. The unique index
// that makes this race-safe is a separate migration candidate, not applied.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyStripeSignature } from "./stripe-signature.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function logEvent(businessId: string | null, provider: string, eventId: string | null, type: string, payload: unknown) {
  if (eventId) {
    const { data: dup } = await supabase
      .from("billing_events").select("id")
      .eq("provider", provider).eq("provider_event_id", eventId).limit(1);
    if (dup && dup.length > 0) return { duplicate: true };
  }
  const { error } = await supabase.from("billing_events").insert({
    business_id: businessId, provider, provider_event_id: eventId,
    event_type: type, payload,
  });
  // race-safe arm of the dedupe: with the unique index in place, a
  // concurrent redelivery loses the insert - that IS a duplicate, not an error
  if (error) {
    if ((error as { code?: string }).code === "23505") return { duplicate: true };
    return { error: error.message };
  }
  return { duplicate: false };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (secret) {
    // Live-shaped path: verify first, log verified events, change nothing.
    const rawBody = await req.text();
    const verdict = await verifyStripeSignature(rawBody, req.headers.get("Stripe-Signature") ?? "", secret);
    if (!verdict.ok) {
      return Response.json({ ok: false, error: "signature verification failed" }, { status: 400 });
    }
    const body = JSON.parse(rawBody);
    if (typeof body?.type !== "string") {
      return Response.json({ ok: false, error: "verified but malformed event" }, { status: 400 });
    }
    const r = await logEvent(body?.data?.object?.metadata?.business_id ?? null, "stripe", body.id ?? null, body.type, body);
    if (r.error) return Response.json({ ok: false, error: r.error }, { status: 500 });
    return Response.json({ ok: true, verified: true, duplicate: r.duplicate, note: "logged only; no state changed" });
  }

  if (Deno.env.get("BILLING_MODE") !== "placeholder") {
    return Response.json(
      { ok: false, error: "billing webhook not configured: unsigned events are never processed" },
      { status: 503 },
    );
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.type !== "string") {
    return Response.json({ ok: false, error: "expected {type, business_id?}" }, { status: 400 });
  }
  const r = await logEvent(body.business_id ?? null, "placeholder", body.id ?? null, body.type, body);
  if (r.error) return Response.json({ ok: false, error: r.error }, { status: 500 });
  return Response.json({ ok: true, placeholder: true, duplicate: r.duplicate, note: "logged only; no state changed" });
});
