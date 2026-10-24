// billing-webhook: NONLIVE PLACEHOLDER. There is no Stripe signing secret, so
// this endpoint TRUSTS NOTHING: it never updates billing_profiles, never
// activates anything, and answers 503 unless BILLING_MODE=placeholder. In
// placeholder mode it appends the posted body to billing_events with
// provider='placeholder' purely so payload-shape handling can be exercised
// with local mocks. Real activation requires Jake's entity/registration
// decision and a verified signing secret before any status can leave 'draft'.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
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
  const { error } = await supabase.from("billing_events").insert({
    business_id: body.business_id ?? null,
    provider: "placeholder",
    provider_event_id: body.id ?? null,
    event_type: body.type,
    payload: body,
  });
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true, placeholder: true, note: "logged only; no state changed" });
});
