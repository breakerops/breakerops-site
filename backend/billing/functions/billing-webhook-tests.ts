// billing-webhook-tests.ts: LOCAL handler-level integration tests for the
// ACTUAL billing-webhook handler (createBillingWebhookHandler), plus
// signature-scheme vectors. Run: tsx billing-webhook-tests.ts
// Signatures are built with node:crypto HMAC - an independent implementation
// from the WebCrypto verifier under test. The store stub enforces the
// provider+provider_event_id unique rule the way the dedupe migration will,
// so the 23505 race arm is exercised for real. No live anything.
import { createHmac } from "node:crypto";
import { verifyStripeSignature } from "./stripe-signature.ts";
import { createBillingWebhookHandler } from "./billing-webhook.ts";

let passed = 0;
function ok(cond: boolean, name: string) {
  if (!cond) { console.error(`FAIL: ${name}`); process.exit(1); }
  passed++; console.log(`ok ${passed} - ${name}`);
}

const SECRET = "whsec_testsecret_localonly";
const sign = (t: number, raw: string, secret = SECRET) =>
  createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
const hdr = (t: number, raw: string, extra = "") =>
  `t=${t},v1=${sign(t, raw)}${extra}`;
const NOW = Math.floor(Date.now() / 1000);

// --- signature scheme vectors ---
const raw = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { metadata: {} } } });
ok((await verifyStripeSignature(raw, hdr(NOW, raw), SECRET)).ok, "valid single v1 accepted");
const decoy = `t=${NOW},v1=${"a".repeat(64)},v1=${sign(NOW, raw)},v1=${"b".repeat(64)}`;
ok((await verifyStripeSignature(raw, decoy, SECRET)).ok, "rotation header: valid v1 among decoys accepted");
const allBad = `t=${NOW},v1=${"a".repeat(64)},v1=${"b".repeat(64)}`;
ok(!(await verifyStripeSignature(raw, allBad, SECRET)).ok, "all-decoy v1 rejected");
ok((await verifyStripeSignature(raw, hdr(NOW - 299, raw), SECRET)).ok, "timestamp at -299s inside tolerance");
ok(!(await verifyStripeSignature(raw, hdr(NOW - 301, raw), SECRET)).ok, "timestamp at -301s rejected");
ok(!(await verifyStripeSignature(raw, hdr(NOW + 301, raw), SECRET)).ok, "future timestamp +301s rejected");
ok(!(await verifyStripeSignature(raw + " ", hdr(NOW, raw), SECRET)).ok, "mutated raw body rejected (trailing space)");
ok(!(await verifyStripeSignature(raw, "", SECRET)).ok, "missing header rejected");
ok(!(await verifyStripeSignature(raw, `t=${NOW},v0=${"c".repeat(64)}`, SECRET)).ok, "v0-only header rejected");
ok(!(await verifyStripeSignature(raw, `t=notanumber,v1=${"a".repeat(64)}`, SECRET)).ok, "non-numeric timestamp rejected");
ok(!(await verifyStripeSignature(raw, hdr(NOW, raw, ",v0=9".repeat(3)), "whsec_wrong")).ok, "wrong secret rejected");

// --- handler integration: in-memory store with the unique rule armed ---
type Row = { business_id: string | null; provider: string; provider_event_id: string | null; event_type: string; payload: unknown };
function makeStore() {
  const rows: Row[] = [];
  let inserts = 0, selects = 0;
  const store = {
    from: (_t: string) => ({
      select: (_c: string) => ({
        eq: (c1: string, v1: string) => ({
          eq: (c2: string, v2: string) => ({
            limit: async (_n: number) => {
              selects++;
              return { data: rows.filter((r) => (r as never)[c1] === v1 && (r as never)[c2] === v2) };
            },
          }),
        }),
      }),
      insert: async (row: Row) => {
        inserts++;
        if (row.provider_event_id &&
            rows.some((r) => r.provider === row.provider && r.provider_event_id === row.provider_event_id)) {
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        rows.push(row);
        return { error: null };
      },
    }),
  };
  return { store, rows, counts: () => ({ inserts, selects }) };
}
const req = (body: string, headers: Record<string, string>) =>
  new Request("https://edge.test/functions/v1/billing-webhook", { method: "POST", body, headers });

// 13: no config at all -> fail closed, zero DB contact
{
  const { store, counts } = makeStore();
  const h = createBillingWebhookHandler({ store, env: { get: () => undefined } });
  const r = await h(req(raw, {}));
  ok(r.status === 503 && counts().inserts === 0 && counts().selects === 0, "no config -> 503, zero DB contact");
}
// 14: stripe mode, bad signature -> 400, zero DB contact (no ledger write before verification)
{
  const { store, counts } = makeStore();
  const env = { get: (k: string) => (k === "STRIPE_WEBHOOK_SECRET" ? SECRET : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const r = await h(req(raw, { "Stripe-Signature": `t=${NOW},v1=${"d".repeat(64)}` }));
  ok(r.status === 400 && counts().inserts === 0 && counts().selects === 0, "bad signature -> 400, zero DB contact");
}
// 15: stripe mode, valid -> logged once; redelivery is a duplicate; raw payload NOT stored by default
{
  const { store, rows } = makeStore();
  const env = { get: (k: string) => (k === "STRIPE_WEBHOOK_SECRET" ? SECRET : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const signedBody = JSON.stringify({ id: "evt_42", type: "invoice.paid", livemode: false, created: NOW,
    data: { object: { metadata: { business_id: "biz-1" }, secret_marker: "RAW_CARD_4242" } } });
  const r1 = await h(req(signedBody, { "Stripe-Signature": hdr(NOW, signedBody) }));
  const j1 = await r1.json();
  const r2 = await h(req(signedBody, { "Stripe-Signature": hdr(NOW, signedBody) }));
  const j2 = await r2.json();
  ok(r1.status === 200 && j1.verified === true && j1.duplicate === false, "valid stripe event logged");
  ok(j2.duplicate === true && rows.length === 1, "redelivery deduped, exactly one row");
  ok(rows[0].provider === "stripe" && rows[0].provider_event_id === "evt_42" && rows[0].event_type === "invoice.paid",
    "envelope fields stored correctly");
  ok(!JSON.stringify(rows[0].payload).includes("RAW_CARD_4242"), "raw financial payload NOT stored by default");
}
// 17: raw storage is opt-in only
{
  const { store, rows } = makeStore();
  const env = { get: (k: string) => (k === "STRIPE_WEBHOOK_SECRET" ? SECRET : k === "BILLING_STORE_RAW_PAYLOAD" ? "1" : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const signedBody = JSON.stringify({ id: "evt_raw", type: "invoice.paid", data: { object: { secret_marker: "RAW_CARD_4242" } } });
  await h(req(signedBody, { "Stripe-Signature": hdr(NOW, signedBody) }));
  ok(JSON.stringify(rows[0].payload).includes("RAW_CARD_4242"), "BILLING_STORE_RAW_PAYLOAD=1 opt-in stores full body");
}
// 18: verified but malformed JSON -> 400, nothing logged
{
  const { store, counts } = makeStore();
  const env = { get: (k: string) => (k === "STRIPE_WEBHOOK_SECRET" ? SECRET : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const bad = "not json";
  const r = await h(req(bad, { "Stripe-Signature": hdr(NOW, bad) }));
  ok(r.status === 400 && counts().inserts === 0, "verified-but-malformed -> 400, nothing logged");
}
// 19: placeholder mode without token configured -> 503 (misconfig is closed, not open)
{
  const { store, counts } = makeStore();
  const env = { get: (k: string) => (k === "BILLING_MODE" ? "placeholder" : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const r = await h(req(JSON.stringify({ type: "test.event" }), {}));
  ok(r.status === 503 && counts().inserts === 0, "placeholder without token -> 503");
}
// 20: placeholder with token, wrong header -> 401, nothing logged
{
  const { store, counts } = makeStore();
  const env = { get: (k: string) => (k === "BILLING_MODE" ? "placeholder" : k === "PLACEHOLDER_WEBHOOK_TOKEN" ? "tok_local" : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const r = await h(req(JSON.stringify({ type: "test.event" }), { "X-Billing-Webhook-Token": "wrong" }));
  ok(r.status === 401 && counts().inserts === 0, "placeholder wrong token -> 401, nothing logged");
}
// 21: placeholder with token, right header -> logged, minimal payload by default
{
  const { store, rows } = makeStore();
  const env = { get: (k: string) => (k === "BILLING_MODE" ? "placeholder" : k === "PLACEHOLDER_WEBHOOK_TOKEN" ? "tok_local" : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const r = await h(req(JSON.stringify({ id: "ph_1", type: "test.event", debug_blob: "SENSITIVE_MARKER" }),
    { "X-Billing-Webhook-Token": "tok_local" }));
  ok(r.status === 200 && rows.length === 1 && !JSON.stringify(rows[0].payload).includes("SENSITIVE_MARKER"),
    "placeholder authed + minimized by default");
}
// 22: race arm - a redelivery that slips past the pre-check still loses on 23505
{
  const { store, rows } = makeStore();
  const env = { get: (k: string) => (k === "STRIPE_WEBHOOK_SECRET" ? SECRET : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const signedBody = JSON.stringify({ id: "evt_race", type: "invoice.paid", data: { object: {} } });
  const [a, b] = await Promise.all([
    h(req(signedBody, { "Stripe-Signature": hdr(NOW, signedBody) })),
    h(req(signedBody, { "Stripe-Signature": hdr(NOW, signedBody) })),
  ]);
  const js = [await a.json(), await b.json()];
  ok(a.status === 200 && b.status === 200 && rows.length === 1 && js.some((j) => j.duplicate === true),
    "concurrent redelivery: one insert wins, loser armed as duplicate, both 200");
}


// 24: well-formed but UNKNOWN business_id -> FK arm logs unassigned+flagged, 200, no 500
{
  const rows: Row[] = [];
  const store = {
    from: (_t: string) => ({
      select: (_c: string) => ({ eq: (_a: string, _b: string) => ({ eq: (_c2: string, _d: string) => ({ limit: async (_n: number) => ({ data: [] }) }) }) }),
      insert: async (row: Row) => {
        if (row.business_id) return { error: { code: "23503", message: "insert or update on table violates foreign key constraint" } };
        rows.push(row); return { error: null };
      },
    }),
  };
  const env = { get: (k: string) => (k === "STRIPE_WEBHOOK_SECRET" ? SECRET : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const b = JSON.stringify({ id: "evt_fk", type: "invoice.paid", data: { object: { metadata: { business_id: "11111111-2222-3333-4444-555555555555" } } } });
  const r = await h(req(b, { "Stripe-Signature": hdr(NOW, b) }));
  const j = await r.json();
  ok(r.status === 200 && j.ok === true && rows.length === 1 && rows[0].business_id === null &&
     JSON.stringify(rows[0].payload).includes("business_id_unresolved"),
    "unknown business_id: logged unassigned + flagged, no untrusted-FK 500");
}
// 25: non-UUID business_id metadata is dropped before any DB write; errors are generic
{
  const { store, rows } = makeStore();
  const env = { get: (k: string) => (k === "STRIPE_WEBHOOK_SECRET" ? SECRET : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const b = JSON.stringify({ id: "evt_shape", type: "invoice.paid", data: { object: { metadata: { business_id: "not-a-uuid; drop table" } } } });
  const r = await h(req(b, { "Stripe-Signature": hdr(NOW, b) }));
  ok(r.status === 200 && rows.length === 1 && rows[0].business_id === null &&
     JSON.stringify(rows[0].payload).includes("business_id_unresolved"),
    "non-UUID business_id dropped, flagged, logged");
}
// 26: storage failure returns generic error, never raw DB text
{
  const store = {
    from: (_t: string) => ({
      select: (_c: string) => ({ eq: (_a: string, _b: string) => ({ eq: (_c2: string, _d: string) => ({ limit: async (_n: number) => ({ data: [] }) }) }) }),
      insert: async (_row: Row) => ({ error: { code: "XX000", message: "connection to server at \"10.0.0.5\", port 5432 failed: FATAL: password authentication failed" } }),
    }),
  };
  const env = { get: (k: string) => (k === "STRIPE_WEBHOOK_SECRET" ? SECRET : undefined) };
  const h = createBillingWebhookHandler({ store, env });
  const b = JSON.stringify({ id: "evt_err", type: "invoice.paid", data: { object: {} } });
  const r = await h(req(b, { "Stripe-Signature": hdr(NOW, b) }));
  const j = await r.json();
  ok(r.status === 500 && j.error === "event storage failed" && !JSON.stringify(j).includes("10.0.0.5"),
    "storage failure: generic 500, no raw DB error echo");
}

console.log(`all ${passed} checks passed`);
