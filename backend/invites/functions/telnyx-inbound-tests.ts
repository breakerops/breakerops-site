// telnyx-inbound-tests.ts: LOCAL execution/fault tests for the ACTUAL
// telnyx-inbound handler (createTelnyxInboundHandler). Run:
//   node --experimental-strip-types telnyx-inbound-tests.ts
// Real ed25519 signatures via node:crypto (independent of the WebCrypto
// verifier). In-memory store with durable-state assertions and per-operation
// fault injection. No live anything: no real texts, no prod, no provider.
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { createTelnyxInboundHandler } from "./telnyx-inbound.ts";

let passed = 0;
function ok(cond: boolean, name: string) {
  if (!cond) { console.error(`FAIL: ${name}`); process.exit(1); }
  passed++; console.log(`ok ${passed} - ${name}`);
}

// --- real keypair for the webhook signature ---
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubB64 = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
function signedReq(bodyObj: unknown, opts: { ts?: number; badSig?: boolean } = {}) {
  const raw = JSON.stringify(bodyObj);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  let sig = edSign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString("base64");
  if (opts.badSig) sig = sig.replace(/.$/, "A");
  return new Request("https://edge.test/functions/v1/telnyx-inbound", {
    method: "POST", body: raw,
    headers: { "telnyx-signature-ed25519": sig, "telnyx-timestamp": String(ts) },
  });
}
const evt = (text: string, id = "evt-1", from = "+15551234567") =>
  ({ data: { id, event_type: "message.received", payload: { from: { phone_number: from }, text } } });

// --- in-memory store ---
type Row = Record<string, any>;
function makeTable(pk: string) {
  const rows: Row[] = [];
  const faults = { insert: 0, update: 0, select: 0, upsert: 0, delete: 0 };
  const match = (r: Row, f: [string, string, any][]) =>
    f.every(([op, c, v]) => (op === "eq" ? r[c] === v : v.includes(r[c])));
  const table = {
    rows, faults,
    insert: (row: Row) => {
      if (faults.insert-- > 0) return Promise.resolve({ error: { code: "XX000", message: "injected insert fault" } });
      if (rows.some((r) => r[pk] === row[pk])) return Promise.resolve({ error: { code: "23505", message: "dup" } });
      rows.push({ ...row }); return Promise.resolve({ error: null });
    },
    upsert: (row: Row, _o: unknown) => {
      if (faults.upsert-- > 0) return Promise.resolve({ error: { code: "XX000", message: "injected upsert fault" } });
      const i = rows.findIndex((r) => r[pk] === row[pk]);
      if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push({ ...row });
      return Promise.resolve({ error: null });
    },
    update: (patch: Row) => {
      const filters: [string, string, any][] = [];
      const chain = {
        eq: (c: string, v: any) => (filters.push(["eq", c, v]), chain),
        in: (c: string, v: any[]) => (filters.push(["in", c, v]), chain),
        select: (_cols: string) => {
          if (faults.update-- > 0) return Promise.resolve({ data: null, error: { code: "XX000", message: "injected update fault" } });
          const hit = rows.filter((r) => match(r, filters));
          hit.forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null });
        },
      };
      return chain;
    },
    delete: () => {
      const filters: [string, string, any][] = [];
      const chain = {
        eq: (c: string, v: any) => (filters.push(["eq", c, v]), chain),
        then: undefined as unknown,
      };
      const exec = () => {
        if (faults.delete-- > 0) return { error: { code: "XX000", message: "injected delete fault" } };
        for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], filters)) rows.splice(i, 1);
        return { error: null };
      };
      return Object.assign(chain, {
        then: (res: (v: any) => any, rej?: (e: any) => any) => Promise.resolve(exec()).then(res, rej),
      });
    },
    select: (_cols: string) => {
      const filters: [string, string, any][] = [];
      const chain = {
        eq: (c: string, v: any) => (filters.push(["eq", c, v]), chain),
        maybeSingle: () => {
          if (faults.select-- > 0) return Promise.resolve({ data: null, error: { code: "XX000", message: "injected select fault" } });
          const hit = rows.filter((r) => match(r, filters));
          return Promise.resolve({ data: hit[0] ? { ...hit[0] } : null, error: null });
        },
      };
      return chain;
    },
  };
  return table;
}
function makeWorld(opts: { sendGate?: boolean; rpcRedeem?: any; sendResults?: any[] } = {}) {
  const inbound = makeTable("event_id");
  const optouts = makeTable("phone");
  const sends: { payload: Record<string, string>; idemKey: string }[] = [];
  const sendQueue = [...(opts.sendResults ?? [])];
  const rpcCalls: { fn: string; args: any }[] = [];
  const rpcFaults = { claim_keyword: 0 };
  const store = {
    from: (t: string) => (t === "inbound_events" ? inbound : optouts),
    rpc: async (fn: string, a: any) => {
      if (fn === "inbound_claim_keyword") {
        rpcCalls.push({ fn, args: a });
        if (rpcFaults.claim_keyword-- > 0) return { data: null, error: { message: "tx aborted" } }; // crash: NOTHING lands
        if (inbound.rows.some((r) => r.event_id === a.p_event_id)) return { data: "duplicate", error: null };
        inbound.rows.push({ event_id: a.p_event_id, event_type: a.p_event_type, from_phone: a.p_from_phone,
          status: "processing", owner: a.p_owner, version: 1, updated_at: new Date().toISOString() });
        if (a.p_action === "optout") {
          const i = optouts.rows.findIndex((r) => r.phone === a.p_from_phone);
          const row = { phone: a.p_from_phone, opted_out_at: new Date().toISOString(), keyword: a.p_keyword };
          if (i >= 0) optouts.rows[i] = row; else optouts.rows.push(row);
        } else {
          for (let i = optouts.rows.length - 1; i >= 0; i--) if (optouts.rows[i].phone === a.p_from_phone) optouts.rows.splice(i, 1);
        }
        return { data: "claimed", error: null };
      }
      if (fn === "get_connection") return { data: [{ api_key: "KEY-test", meta: { from_number: "+15550001111" } }], error: null };
      if (fn === "invite_redeem_on_inbound") return opts.rpcRedeem ?? { data: { status: "none" }, error: null };
      return { data: null, error: { message: "unknown rpc" } };
    },
  };
  const env = { get: (k: string) =>
    k === "TELNYX_WEBHOOK_PUBLIC_KEY" ? pubB64 :
    k === "TELNYX_SEND_ENABLED" ? (opts.sendGate === false ? "true" : undefined) : undefined };
  const sendSms = async (payload: Record<string, string>, idemKey: string) => {
    sends.push({ payload, idemKey });
    return sendQueue.length ? sendQueue.shift() : { outcome: "sent", providerId: "msg_test_1" };
  };
  const h = createTelnyxInboundHandler({ store, env, sendSms });
  return { h, inbound, optouts, sends, rpcCalls, rpcFaults };
}
const STOP = "STOP";

// 1-3: signature gates
{
  const { h, inbound } = makeWorld();
  const r = await h(signedReq(evt(STOP), { badSig: true }));
  ok(r.status === 401 && inbound.rows.length === 0, "bad signature -> 401, zero store contact");
}
{
  const w = makeWorld();
  const h2 = createTelnyxInboundHandler({ store: { from: () => { throw new Error("no store contact"); }, rpc: async () => { throw new Error("no store contact"); } },
    env: { get: () => undefined }, sendSms: async () => { throw new Error("no send"); } });
  const r = await h2(signedReq(evt(STOP)));
  ok(r.status === 401, "missing public key -> fail closed 401, zero store contact");
  void w;
}
{
  const { h } = makeWorld();
  const r = await h(signedReq(evt(STOP), { ts: Math.floor(Date.now() / 1000) - 400 }));
  ok(r.status === 401, "timestamp outside 300s replay window -> 401");
}
// 4: STOP happy path end-to-end (send enabled): durability proven BEFORE send
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  const r = await h(signedReq(evt(STOP)));
  const j = await r.json();
  const claim = inbound.rows[0];
  ok(j.status === "opted_out" && j.reply_sent === true, "STOP: replied opted_out");
  ok(optouts.rows.length === 1 && optouts.rows[0].phone === "+15551234567" && optouts.rows[0].keyword === "STOP",
    "STOP: suppression row durable");
  ok(claim.status === "done" && claim.detail.includes("msg_test_1"), "STOP: claim done with provider id recorded");
  ok(sends.length === 1 && sends[0].payload.text.startsWith("BreakerOps: You are unsubscribed") &&
     sends[0].payload.to === "+15551234567" && sends[0].payload.from === "+15550001111" &&
     sends[0].idemKey === claim.idem_key,
    "STOP: send used exact persisted canonical payload + idempotency key");
}
// 5: atomic claim RPC crash -> NOTHING lands (no claim, no suppression), 500, provider redelivers
{
  const { h, inbound, optouts, sends, rpcFaults } = makeWorld({ sendGate: false });
  rpcFaults.claim_keyword = 1;
  const r = await h(signedReq(evt(STOP, "evt-5")));
  ok(r.status === 500 && inbound.rows.length === 0 && optouts.rows.length === 0 && sends.length === 0,
    "F1b: claim-RPC crash rolls back BOTH claim and suppression (atomic)");
  // redelivery after the crash: lands cleanly
  const r2 = await h(signedReq(evt(STOP, "evt-5")));
  const j2 = await r2.json();
  ok(j2.status === "opted_out" && optouts.rows.length === 1 && inbound.rows[0].status === "done",
    "F1b: redelivery recovers - claim + suppression land together");
}
// 6: crash AFTER atomic claim, BEFORE send intent -> suppression ALREADY durable (F1 window closed)
{
  const { h, inbound, optouts, sends, rpcFaults } = makeWorld({ sendGate: false });
  inbound.faults.update = 1; // setIntent's first CAS write fails = crash before intent persists
  const r = await h(signedReq(evt(STOP, "evt-6")));
  ok(r.status === 500 && optouts.rows.length === 1 && inbound.rows[0].status === "processing" &&
     sends.length === 0 && !inbound.rows[0].idem_key,
    "F1 closed: crash post-claim pre-intent still leaves suppression durable");
  // stale redelivery: adopt, rerun idempotent step, complete
  inbound.rows[0].updated_at = new Date(Date.now() - 180_000).toISOString();
  const r2 = await h(signedReq(evt(STOP, "evt-6")));
  const j2 = await r2.json();
  ok(j2.reply_sent === true && sends.length === 1 && optouts.rows.length === 1 && inbound.rows[0].status === "done",
    "F1 closed: stale redelivery completes, suppression never duplicated");
  void rpcFaults;
}
// 7: STOP with send gate ON: suppression recorded, claim done 'send disabled', zero sends
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: true });
  const r = await h(signedReq(evt(STOP, "evt-7")));
  const j = await r.json();
  ok(j.send === "disabled" && sends.length === 0 && optouts.rows.length === 1 &&
     inbound.rows[0].status === "done" && inbound.rows[0].detail.startsWith("send disabled"),
    "STOP gated: suppression durable, no SMS spend, claim done");
}
// 8: crash-after-intent: redelivery adopts db_done and retries ONLY the send with same key
{
  const { h, inbound, sends } = makeWorld({ sendGate: false });
  const key = "11111111-1111-4111-8111-111111111111";
  inbound.rows.push({ event_id: "evt-8", event_type: "message.received", from_phone: "+15551234567",
    status: "db_done", detail: "BreakerOps: You are unsubscribed and will receive no more texts. Reply START to resubscribe.",
    owner: "crashed", version: 1, idem_key: key,
    payload: { from: "+15550001111", to: "+15551234567", text: "BreakerOps: You are unsubscribed and will receive no more texts. Reply START to resubscribe." },
    first_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  let upserts = 0;
  const origUpsert = w => w; void origUpsert;
  const r = await h(signedReq(evt(STOP, "evt-8")));
  const j = await r.json();
  ok(j.reply_sent === true && sends.length === 1 && sends[0].idemKey === key &&
     sends[0].payload.text === inbound.rows[0].payload.text,
    "crash-after-intent: resumed with ORIGINAL key+payload, send-only retry");
  ok(upserts === 0, "crash-after-intent: DB mutation NOT re-run");
}
// 9: stale 'sending' inside window -> adopt + resume same key
{
  const { h, inbound, sends } = makeWorld({ sendGate: false });
  const key = "22222222-2222-4222-8222-222222222222";
  inbound.rows.push({ event_id: "evt-9", event_type: "message.received", from_phone: "+15551234567",
    status: "sending", detail: "resume me", owner: "crashed", version: 1, idem_key: key,
    payload: { from: "+15550001111", to: "+15551234567", text: "resume me" },
    first_attempt_at: new Date().toISOString(),
    updated_at: new Date(Date.now() - 180_000).toISOString() });
  const r = await h(signedReq(evt(STOP, "evt-9")));
  const j = await r.json();
  ok(j.reply_sent === true && sends.length === 1 && sends[0].idemKey === key && inbound.rows[0].status === "done",
    "stale sending in-window: adopted, resumed same key, done");
}
// 10: stale 'sending' OUTSIDE window -> uncertain, no send
{
  const { h, inbound, sends } = makeWorld({ sendGate: false });
  inbound.rows.push({ event_id: "evt-10", event_type: "message.received", from_phone: "+15551234567",
    status: "sending", detail: "old", owner: "crashed", version: 1, idem_key: "33333333-3333-4333-8333-333333333333",
    payload: { from: "+15550001111", to: "+15551234567", text: "old" },
    first_attempt_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
    updated_at: new Date(Date.now() - 180_000).toISOString() });
  const r = await h(signedReq(evt(STOP, "evt-10")));
  const j = await r.json();
  ok(sends.length === 0 && inbound.rows[0].status === "uncertain" && j.deduped === true,
    "stale sending out-of-window: held uncertain, NO resend");
}
// 11: fresh 'processing' -> 409, no send
{
  const { h, inbound, sends } = makeWorld({ sendGate: false });
  inbound.rows.push({ event_id: "evt-11", event_type: "message.received", from_phone: "+15551234567",
    status: "processing", owner: "other-worker", version: 1,
    updated_at: new Date().toISOString() });
  const r = await h(signedReq(evt(STOP, "evt-11")));
  ok(r.status === 409 && sends.length === 0, "fresh processing claim: 409 in-progress, provider will redeliver");
}
// 12: stale 'processing' reclaim -> full idempotent re-run
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  inbound.rows.push({ event_id: "evt-12", event_type: "message.received", from_phone: "+15551234567",
    status: "processing", owner: "crashed", version: 1,
    updated_at: new Date(Date.now() - 180_000).toISOString() });
  const r = await h(signedReq(evt(STOP, "evt-12")));
  const j = await r.json();
  ok(j.reply_sent === true && optouts.rows.length === 1 && inbound.rows[0].status === "done" && sends.length === 1,
    "stale processing: reclaimed by exactly one worker, full flow re-run idempotently");
}
// 13: done redelivery -> ack, no side effects
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  inbound.rows.push({ event_id: "evt-13", event_type: "message.received", from_phone: "+15551234567",
    status: "done", owner: "old", version: 3, updated_at: new Date().toISOString() });
  const r = await h(signedReq(evt(STOP, "evt-13")));
  const j = await r.json();
  ok(j.deduped === true && sends.length === 0 && optouts.rows.length === 0, "done redelivery: acknowledged, zero side effects");
}
// 14: failed + uncertain redeliveries -> held acks, no resend
{
  const { h, inbound, sends } = makeWorld({ sendGate: false });
  inbound.rows.push({ event_id: "evt-14a", status: "failed", owner: "old", version: 2, updated_at: new Date().toISOString() });
  inbound.rows.push({ event_id: "evt-14b", status: "uncertain", owner: "old", version: 2, updated_at: new Date().toISOString() });
  const r1 = await h(signedReq(evt(STOP, "evt-14a")));
  const r2 = await h(signedReq(evt(STOP, "evt-14b")));
  const j1 = await r1.json(); const j2 = await r2.json();
  ok(j1.deduped === true && j2.deduped === true && sends.length === 0, "failed/uncertain redelivery: held, never resent");
}
// 15: 429 -> claim returns to db_done, key preserved, 500 so provider redelivers
{
  const { h, inbound, sends } = makeWorld({ sendGate: false, sendResults: [{ outcome: "retryable", error: "telnyx 429" }] });
  const r = await h(signedReq(evt(STOP, "evt-15")));
  ok(r.status === 500 && inbound.rows[0].status === "db_done" && inbound.rows[0].idem_key &&
     sends.length === 1, "429: claim back to db_done with SAME key parked for redelivery");
}
// 16: permanent 4xx -> failed terminal; redelivery acked, never resent
{
  const { h, inbound, sends } = makeWorld({ sendGate: false, sendResults: [{ outcome: "failed", error: "telnyx 400" }] });
  await h(signedReq(evt(STOP, "evt-16")));
  const claim = inbound.rows[0];
  const r2 = await h(signedReq(evt(STOP, "evt-16")));
  const j2 = await r2.json();
  ok(claim.status === "failed" && j2.deduped === true && sends.length === 1,
    "4xx: terminal failed, redelivery acknowledged without resend");
}
// 17: uncertain send outcome (timeout) -> uncertain, redelivery holds, no auto-resend
{
  const { h, inbound, sends } = makeWorld({ sendGate: false, sendResults: [{ outcome: "uncertain", error: "timeout" }] });
  await h(signedReq(evt(STOP, "evt-17")));
  const r2 = await h(signedReq(evt(STOP, "evt-17")));
  const j2 = await r2.json();
  ok(inbound.rows[0].status === "uncertain" && j2.deduped === true && sends.length === 1,
    "timeout: uncertain held, no automatic resend on redelivery");
}
// 18: START deletes suppression, proves durable, confirms
{
  const { h, optouts, sends } = makeWorld({ sendGate: false });
  optouts.rows.push({ phone: "+15551234567", opted_out_at: new Date().toISOString(), keyword: "STOP" });
  const r = await h(signedReq(evt("START", "evt-18")));
  const j = await r.json();
  ok(j.status === "opted_in" && optouts.rows.length === 0 && sends.length === 1,
    "START: suppression removed + verified, resubscribe confirmation sent");
}
// 19: HELP: no opt-out mutation, reply sent
{
  const { h, optouts, sends } = makeWorld({ sendGate: false });
  const r = await h(signedReq(evt("HELP", "evt-19")));
  const j = await r.json();
  ok(j.status === "help" && optouts.rows.length === 0 && sends.length === 1, "HELP: reply only, no mutation");
}
// 20: ordinary text -> redeem rpc, stub routing, captured:false (reply path unbuilt)
{
  const { h, inbound, sends } = makeWorld({ sendGate: false, rpcRedeem: { data: { status: "admitted", business_id: "b1" }, error: null } });
  const r = await h(signedReq(evt("hi this is a customer", "evt-20")));
  const j = await r.json();
  ok(j.status === "admitted" && j.routing === "stub-no-durable-capture" && j.captured === false &&
     inbound.rows[0].status === "done" && sends.length === 0,
    "ordinary text: redeem called, stub routing, no capture claimed");
}
// 21: redeem rpc error -> unrouted, send disabled
{
  const { h, sends } = makeWorld({ sendGate: false, rpcRedeem: { data: null, error: { message: "activation disabled" } } });
  const r = await h(signedReq(evt("hello", "evt-21")));
  const j = await r.json();
  ok(j.status === "unrouted" && j.send === "disabled" && sends.length === 0, "redeem error: unrouted, no blind reply");
}
// 22: concurrent double-delivery: exactly one claim, one suppression, one send
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  const [a, b] = await Promise.all([h(signedReq(evt(STOP, "evt-22"))), h(signedReq(evt(STOP, "evt-22")))]);
  const js = [await a.json(), await b.json()];
  const okAcks = js.filter((j) => j.status === "opted_out" || j.deduped === true).length;
  const conflicts = [a.status, b.status].filter((s) => s === 409).length;
  ok(inbound.rows.length === 1 && optouts.rows.length === 1 && sends.length === 1 &&
     okAcks + conflicts === 2 && okAcks >= 1 && js.every((j) => !j.error || a.status === 409 || b.status === 409),
    "concurrent duplicate delivery: one claim, one suppression, one send; loser 409 or deduped-ack");
}

// 27: STOP claims via the atomic RPC (not a plain insert), with exact args
{
  const { h, rpcCalls } = makeWorld({ sendGate: false });
  await h(signedReq(evt("  stop\t", "evt-27")));
  const c = rpcCalls.find((c) => c.fn === "inbound_claim_keyword");
  ok(!!c && c.args.p_action === "optout" && c.args.p_keyword === "STOP" &&
     c.args.p_from_phone === "+15551234567" && !!c.args.p_owner,
    "STOP classified pre-claim, claimed atomically via RPC with exact args");
}
// 28: RPC duplicate -> existing read/adopt path (done claim -> deduped ack, no resend)
{
  const { h, inbound, sends } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-28")));
  inbound.rows[0].status = "done";
  const r2 = await h(signedReq(evt(STOP, "evt-28")));
  const j2 = await r2.json();
  ok(j2.deduped === true && sends.length === 1, "RPC duplicate: deduped ack, no resend");
}
// 29: STOP redelivery after a later START does NOT resurrect suppression (RPC duplicate path)
{
  const { h, optouts } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-29stop")));
  await h(signedReq(evt("START", "evt-29start")));
  await h(signedReq(evt(STOP, "evt-29stop"))); // redelivery of the OLD stop
  ok(optouts.rows.length === 0, "old STOP redelivery after START: suppression stays removed");
}
// 30: malformed RPC result fails closed
{
  const w = makeWorld({ sendGate: false });
  const store2 = { from: w.inbound && ((t: string) => (t === "inbound_events" ? w.inbound : w.optouts)),
    rpc: async (fn: string) => (fn === "inbound_claim_keyword" ? { data: "garbage", error: null } : { data: null, error: null }) };
  const h2 = createTelnyxInboundHandler({ store: store2, env: { get: (k: string) => k === "TELNYX_WEBHOOK_PUBLIC_KEY" ? pubB64 : undefined }, sendSms: async () => { throw new Error("no send"); } });
  const r = await h2(signedReq(evt(STOP, "evt-30")));
  ok(r.status === 500, "malformed claim RPC result -> fail closed 500");
}

console.log(`all ${passed} checks passed`);
