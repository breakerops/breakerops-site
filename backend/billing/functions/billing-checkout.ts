// billing-checkout: NONLIVE PLACEHOLDER. Creates no real Stripe sessions.
// Behavior: without BILLING_MODE=placeholder it answers 503 "billing not
// configured" for every request. With BILLING_MODE=placeholder (never set in
// production) it records a draft billing_profiles row intent and returns a
// fake session URL under example.invalid so UI wiring can be tested end to
// end without touching a processor. No keys, no money, no promises.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (Deno.env.get("BILLING_MODE") !== "placeholder") {
    return Response.json(
      { ok: false, error: "billing not configured: no payment processor is connected; nothing was charged or created" },
      { status: 503 },
    );
  }
  // Placeholder mode: local wiring test only.
  const { business_id } = await req.json().catch(() => ({}));
  if (!business_id) return Response.json({ ok: false, error: "business_id required" }, { status: 400 });
  const { error } = await supabase.from("billing_profiles").upsert(
    { business_id, status: "draft", updated_at: new Date().toISOString() },
    { onConflict: "business_id" },
  );
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({
    ok: true,
    placeholder: true,
    checkout_url: "https://example.invalid/placeholder-checkout",
    note: "NONLIVE placeholder session. No processor was contacted; nothing can be charged.",
  });
});
