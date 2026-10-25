// billing-webhook: NONLIVE SCAFFOLD. Fail-closed in every mode:
//   No config at all            -> 503, zero DB writes.
//   STRIPE_WEBHOOK_SECRET set   -> stripe mode: the Stripe-Signature header is
//                                  verified (stripe-signature.ts, official
//                                  manual scheme) BEFORE any parsing, logging
//                                  or DB touch. Unverified or malformed
//                                  requests get 400 and are NEVER logged - no
//                                  attacker-chosen payload reaches the ledger.
//   BILLING_MODE=placeholder    -> local test mode, STILL authenticated: the
//                                  request must carry X-Billing-Webhook-Token
//                                  matching PLACEHOLDER_WEBHOOK_TOKEN. Mode
//                                  enabled without the token configured is a
//                                  misconfiguration -> 503, not open access.
//                                  Wrong/missing token -> 401, never logged.
// Payload minimization: by default only a minimal envelope (provider, event
// id, event type, livemode, created, business_id) is stored - never the raw
// financial payload. Full-body storage exists behind BILLING_STORE_RAW_PAYLOAD=1
// for local debugging ONLY; that opt-in is NOT APPROVED for any deployed
// environment and must stay unset outside local tests.
// Parser note: v1 signatures are compared byte-exact as sent; Stripe sends
// canonical lowercase hex. A sender deviating (uppercase hex, odd spacing)
// fails closed - intentional, no canonicalization churn.
// Idempotency: provider+provider_event_id pre-check, plus a 23505 arm. The
// pre-check alone is racy; this handler DEPENDS on the unique-index migration
// candidate (dedupe, sha256 3cc426b2...) being applied before it is treated
// as correct under concurrent redelivery. Packaging must pin that pairing.
// Still zero state transitions: no event-type mapping is approved, so nothing
// here can activate, cancel or charge. No Stripe account, keys or prices
// exist; this is verification plumbing, not payment readiness.
//
// createBillingWebhookHandler takes injected deps so the ACTUAL handler is
// integration-testable off the edge runtime (billing-webhook-tests.ts).
import { verifyStripeSignature } from "./stripe-signature.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BillingWebhookEnv {
  get(key: string): string | undefined;
}

// minimal structural subset of the supabase-js client used here
export interface BillingWebhookStore {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): {
        eq(col: string, val: string): {
          limit(n: number): Promise<{ data: unknown[] | null }>;
        };
      };
    };
    insert(row: Record<string, unknown>): Promise<{ error: { code?: string; message?: string } | null }>;
  };
}

function tokenEqual(a: string, b: string): boolean {
  // length-independent-ish compare for the local placeholder token: compare
  // over the longer length so short-circuit timing leaks nothing useful
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i % x.length] ?? 0) ^ (y[i % y.length] ?? 0);
  return diff === 0 && a.length > 0;
}

async function logEvent(
  store: BillingWebhookStore,
  businessId: string | null,
  provider: string,
  eventId: string | null,
  type: string,
  payload: unknown,
) {
  if (eventId) {
    const { data: dup } = await store
      .from("billing_events").select("id")
      .eq("provider", provider).eq("provider_event_id", eventId).limit(1);
    if (dup && dup.length > 0) return { duplicate: true };
  }
  const row = {
    business_id: businessId, provider, provider_event_id: eventId,
    event_type: type, payload,
  };
  let { error } = await store.from("billing_events").insert(row);
  // well-formed but unknown business_id (FK 23503): keep the money event,
  // file it unassigned and flagged - never map it to another business and
  // never fail the delivery with an untrusted-FK 500
  if (error && error.code === "23503" && businessId) {
    const retry = await store.from("billing_events").insert({
      ...row, business_id: null,
      payload: { ...(typeof payload === "object" && payload !== null ? payload : { raw: true }),
                 business_id_unresolved: true },
    });
    error = retry.error;
  }
  // race-safe arm of the dedupe: with the unique index in place, a
  // concurrent redelivery loses the insert - that IS a duplicate, not an error
  if (error) {
    if (error.code === "23505") return { duplicate: true };
    return { error: "event storage failed" }; // generic: never echo raw DB errors
  }
  return { duplicate: false };
}

export function createBillingWebhookHandler(deps: { store: BillingWebhookStore; env: BillingWebhookEnv }) {
  const { store, env } = deps;
  return async function handle(req: Request): Promise<Response> {
    const storeRaw = env.get("BILLING_STORE_RAW_PAYLOAD") === "1";
    const secret = env.get("STRIPE_WEBHOOK_SECRET");

    if (secret) {
      // stripe mode: verify FIRST. Nothing is parsed, logged or written
      // before the signature check passes.
      const rawBody = await req.text();
      const verdict = await verifyStripeSignature(
        rawBody, req.headers.get("Stripe-Signature") ?? "", secret,
      );
      if (!verdict.ok) {
        return Response.json({ ok: false, error: "signature verification failed" }, { status: 400 });
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return Response.json({ ok: false, error: "verified but malformed event" }, { status: 400 });
      }
      if (typeof body?.type !== "string") {
        return Response.json({ ok: false, error: "verified but malformed event" }, { status: 400 });
      }
      const obj = (body?.data as { object?: { metadata?: { business_id?: string } } } | undefined)?.object;
      // untrusted metadata: accept only a well-formed UUID, never echo or
      // guess a mapping. A non-UUID value is dropped, never mapped across.
      const rawBiz = obj?.metadata?.business_id;
      const businessId = typeof rawBiz === "string" && UUID_RE.test(rawBiz) ? rawBiz : null;
      const bizUnresolved = businessId === null && rawBiz != null;
      const payload = storeRaw
        ? body
        : { id: body.id ?? null, type: body.type, livemode: body.livemode ?? null, created: body.created ?? null,
            ...(bizUnresolved ? { business_id_unresolved: true } : {}) };
      const r = await logEvent(store, businessId, "stripe", (body.id as string) ?? null, body.type, payload);
      if (r.error) return Response.json({ ok: false, error: "event storage failed" }, { status: 500 });
      return Response.json({ ok: true, verified: true, duplicate: r.duplicate, note: "logged only; no state changed" });
    }

    // placeholder mode: local test lane, still authenticated and minimized
    if (env.get("BILLING_MODE") !== "placeholder") {
      return Response.json(
        { ok: false, error: "billing webhook not configured: unsigned events are never processed" },
        { status: 503 },
      );
    }
    const token = env.get("PLACEHOLDER_WEBHOOK_TOKEN");
    if (!token) {
      return Response.json(
        { ok: false, error: "placeholder mode misconfigured: PLACEHOLDER_WEBHOOK_TOKEN required" },
        { status: 503 },
      );
    }
    if (!tokenEqual(req.headers.get("X-Billing-Webhook-Token") ?? "", token)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await req.json().catch(() => null);
    if (!body || typeof body.type !== "string") {
      return Response.json({ ok: false, error: "expected {type, business_id?}" }, { status: 400 });
    }
    const payload = storeRaw ? body : { id: body.id ?? null, type: body.type };
    const r = await logEvent(store, body.business_id ?? null, "placeholder", body.id ?? null, body.type, payload);
    if (r.error) return Response.json({ ok: false, error: "event storage failed" }, { status: 500 });
    return Response.json({ ok: true, placeholder: true, duplicate: r.duplicate, note: "logged only; no state changed" });
  };
}

// Edge wiring (Deno only). Dynamic import keeps the module loadable off-edge
// for the handler integration tests; in Node this block never executes.
if ((globalThis as { Deno?: { serve: unknown; env: BillingWebhookEnv } }).Deno) {
  const DenoRef = (globalThis as { Deno: { serve: (h: (r: Request) => Promise<Response>) => void; env: BillingWebhookEnv } }).Deno;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  const store = createClient(
    DenoRef.env.get("SUPABASE_URL")!,
    DenoRef.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  ) as unknown as BillingWebhookStore;
  DenoRef.serve(createBillingWebhookHandler({ store, env: DenoRef.env }));
}
