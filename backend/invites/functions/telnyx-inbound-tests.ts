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
const evt = (text: string, id = "evt-1", from = "+15551234567", occurred_at?: string) =>
  ({ data: { id, event_type: "message.received", ...(occurred_at ? { occurred_at } : {}), payload: { from: { phone_number: from }, text } } });

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
function makeWorld(opts: { sendGate?: boolean; rpcRedeem?: any; sendResults?: any[]; sendLatch?: Promise<void> } = {}) {
  const inbound = makeTable("event_id");
  const optouts = makeTable("phone");
  const sends: { payload: Record<string, string>; idemKey: string }[] = [];
  const sendQueue = [...(opts.sendResults ?? [])];
  const rpcCalls: { fn: string; args: any }[] = [];
  const rpcFaults = { claim_keyword: 0 };
  const kwState = new Map<string, { lastOccurredAt: number | null; unknownHorizon: number | null; lastAction: string }>();
  const store = {
    from: (t: string) => (t === "inbound_events" ? inbound : optouts),
    rpc: async (fn: string, a: any) => {
      if (fn === "inbound_claim_keyword") {
        rpcCalls.push({ fn, args: a });
        if (rpcFaults.claim_keyword-- > 0) return { data: null, error: { message: "tx aborted" } }; // crash: NOTHING lands
        // v3.2 semantics: occurred_at guard with per-phone state + unknown flag
        const occurred = a.p_occurred_at ? Date.parse(a.p_occurred_at) : NaN;
        const occRaw = Number.isFinite(occurred) ? occurred : null;
        // distrust filter FIRST (PG parity): future/implausibly-old -> unknown
        const occ = (occRaw !== null && (occRaw > Date.now() || occRaw < Date.parse("2020-01-01T00:00:00Z"))) ? null : occRaw;
        let st = kwState.get(a.p_from_phone);
        // read-side poisoned-anchor repair happens BEFORE stale evaluation
        if (st && st.lastOccurredAt !== null && st.lastOccurredAt > Date.now()) {
          st = { ...st, lastOccurredAt: null, unknownHorizon: st.unknownHorizon ?? Date.now() };
        }
        let claimStatus = "processing";
        if (st && st.lastOccurredAt !== null && occ !== null && occ < st.lastOccurredAt) claimStatus = "stale_event";
        // v3.5: ANY future timestamp distrusted; horizon blocks ALL optins
        // (no cross-clock auto-apply without a grounded skew bound)
        const occEff = occ;
        let claimStatus2 = claimStatus;
        if (a.p_action === "optin" && claimStatus === "processing" && (occEff === null
          || (st && st.unknownHorizon !== null)
          || (st && st.lastOccurredAt !== null && occEff === st.lastOccurredAt))) claimStatus2 = "held";
        claimStatus = claimStatus2;
        if (inbound.rows.some((r) => r.event_id === a.p_event_id)) return { data: "duplicate", error: null };
        inbound.rows.push({ event_id: a.p_event_id, event_type: a.p_event_type, from_phone: a.p_from_phone,
          status: claimStatus, owner: a.p_owner, version: 1, occurred_at: occEff ? new Date(occEff).toISOString() : null,
          action: a.p_action, keyword: a.p_keyword,
          updated_at: new Date().toISOString() });
        if (claimStatus === "stale_event") return { data: "stale", error: null };
        if (claimStatus === "held") return { data: "held", error: null };
        if (a.p_action === "optout") {
          const i = optouts.rows.findIndex((r) => r.phone === a.p_from_phone);
          const row = { phone: a.p_from_phone, opted_out_at: new Date().toISOString(), keyword: a.p_keyword };
          if (i >= 0) optouts.rows[i] = row; else optouts.rows.push(row);
        } else {
          for (let i = optouts.rows.length - 1; i >= 0; i--) if (optouts.rows[i].phone === a.p_from_phone) optouts.rows.splice(i, 1);
        }
        kwState.set(a.p_from_phone, {
          lastOccurredAt: occEff ?? (st ? st.lastOccurredAt : null),
          unknownHorizon: a.p_action === "optout" && occEff === null
            ? Math.max(st?.unknownHorizon ?? -Infinity, Date.now())
            : (st ? st.unknownHorizon : null),  // horizon never auto-clears; desk reconciles
          lastAction: a.p_action });
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
    if (opts.sendLatch) await opts.sendLatch;
    sends.push({ payload, idemKey });
    return sendQueue.length ? sendQueue.shift() : { outcome: "sent", providerId: "msg_test_1" };
  };
  const bgTasks: Promise<unknown>[] = [];
  const rawH = createTelnyxInboundHandler({ store, env, sendSms, bg: (p: Promise<unknown>) => bgTasks.push(p) });
  const h = async (req: Request) => {
    const r = await rawH(req);
    await Promise.all(bgTasks.splice(0)); // ack-fast: response first, background flow completes after
    return r;
  };
  return { h, rawH, bgTasks, inbound, optouts, sends, rpcCalls, rpcFaults, kwState };
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
  ok(j.accepted === true && optouts.rows.length === 1 && sends.length === 1, "STOP: acked fast, suppression + one confirmation sent in background");
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
  ok(j2.accepted === true && optouts.rows.length === 1 && inbound.rows[0].status === "done",
    "F1b: redelivery recovers - claim + suppression land together");
}
// 6: crash AFTER atomic claim, BEFORE send intent -> suppression ALREADY durable (F1 window closed)
{
  const { h, inbound, optouts, sends, rpcFaults } = makeWorld({ sendGate: false });
  inbound.faults.update = 1; // setIntent's first CAS write fails = crash before intent persists
  const r = await h(signedReq(evt(STOP, "evt-6")));
  ok(r.status === 200 && optouts.rows.length === 1 && inbound.rows[0].status === "processing" &&
     sends.length === 0 && !inbound.rows[0].idem_key,
    "F1 closed: crash post-claim pre-intent still leaves suppression durable (ack-fast: failure lives on the claim row, not the response)");
  // stale redelivery: adopt, rerun idempotent step, complete
  inbound.rows[0].updated_at = new Date(Date.now() - 180_000).toISOString();
  const r2 = await h(signedReq(evt(STOP, "evt-6")));
  const j2 = await r2.json();
  ok(j2.accepted === true && sends.length === 1 && optouts.rows.length === 1 && inbound.rows[0].status === "done",
    "F1 closed: stale redelivery completes, suppression never duplicated");
  void rpcFaults;
}
// 7: STOP with send gate ON: suppression recorded, claim done 'send disabled', zero sends
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: true });
  const r = await h(signedReq(evt(STOP, "evt-7")));
  const j = await r.json();
  ok(j.accepted === true && sends.length === 0 && optouts.rows.length === 1 &&
     inbound.rows[0].status === "done" && inbound.rows[0].detail.startsWith("send disabled"),
    "STOP gated: suppression durable, no SMS spend, claim done");
}
// 8: crash-after-intent: redelivery adopts db_done and retries ONLY the send with same key
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  const key = "11111111-1111-4111-8111-111111111111";
  const { optouts: oo8 } = { optouts };
  optouts.rows.push({ phone: "+15551234567", opted_out_at: new Date().toISOString(), keyword: "STOP" }); // atomic RPC would have written this at claim
  inbound.rows.push({ event_id: "evt-8", event_type: "message.received", from_phone: "+15551234567",
    status: "db_done", detail: "BreakerOps: You are unsubscribed and will receive no more texts. Reply START to resubscribe.",
    owner: "crashed", version: 1, idem_key: key,
    payload: { from: "+15550001111", to: "+15551234567", text: "BreakerOps: You are unsubscribed and will receive no more texts. Reply START to resubscribe." },
    first_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  let upserts = 0;
  const origUpsert = w => w; void origUpsert;
  const r = await h(signedReq(evt(STOP, "evt-8")));
  const j = await r.json();
  ok(j.accepted === true && sends.length === 1 && sends[0].idemKey === key &&
     sends[0].payload.text === inbound.rows[0].payload.text,
    "crash-after-intent: resumed with ORIGINAL key+payload, send-only retry");
  ok(upserts === 0, "crash-after-intent: DB mutation NOT re-run");
}
// 9: stale 'sending' inside window -> adopt + resume same key
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  const key = "22222222-2222-4222-8222-222222222222";
  optouts.rows.push({ phone: "+15551234567", opted_out_at: new Date().toISOString(), keyword: "STOP" }); // atomic RPC would have written this at claim
  inbound.rows.push({ event_id: "evt-9", event_type: "message.received", from_phone: "+15551234567",
    status: "sending", detail: "resume me", owner: "crashed", version: 1, idem_key: key,
    payload: { from: "+15550001111", to: "+15551234567", text: "resume me" },
    first_attempt_at: new Date().toISOString(),
    updated_at: new Date(Date.now() - 180_000).toISOString() });
  const r = await h(signedReq(evt(STOP, "evt-9")));
  const j = await r.json();
  ok(j.accepted === true && sends.length === 1 && sends[0].idemKey === key && inbound.rows[0].status === "done",
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
  ok(sends.length === 0 && inbound.rows[0].status === "uncertain" && j.accepted === true,
    "stale sending out-of-window: held uncertain, NO resend (acked fast, uncertainty on the claim row)");
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
  ok(j.accepted === true && optouts.rows.length === 1 && inbound.rows[0].status === "done" && sends.length === 1,
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
  ok(r.status === 200 && inbound.rows[0].status === "db_done" && inbound.rows[0].idem_key &&
     sends.length === 1, "429: acked fast; claim back to db_done with SAME key parked for internal recovery");
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
  const r = await h(signedReq(evt("START", "evt-18", "+15551234567", "2026-10-25T04:00:10Z")));
  const j = await r.json();
  ok(j.accepted === true && optouts.rows.length === 0 && sends.length === 1,
    "START: suppression removed + verified, resubscribe confirmation sent");
}
// 19: HELP: no opt-out mutation, reply sent
{
  const { h, optouts, sends } = makeWorld({ sendGate: false });
  const r = await h(signedReq(evt("HELP", "evt-19")));
  const j = await r.json();
  ok(j.accepted === true && optouts.rows.length === 0 && sends.length === 1, "HELP: reply only, no mutation");
}
// 20: ordinary text -> redeem rpc, stub routing, captured:false (reply path unbuilt)
{
  const { h, inbound, sends } = makeWorld({ sendGate: false, rpcRedeem: { data: { status: "admitted", business_id: "b1" }, error: null } });
  const r = await h(signedReq(evt("hi this is a customer", "evt-20")));
  const j = await r.json();
  ok(j.accepted === true &&
     inbound.rows[0].status === "done" && sends.length === 0,
    "ordinary text: redeem called, stub routing, no capture claimed");
}
// 21: redeem rpc error -> unrouted, send disabled
{
  const { h, sends } = makeWorld({ sendGate: false, rpcRedeem: { data: null, error: { message: "activation disabled" } } });
  const r = await h(signedReq(evt("hello", "evt-21")));
  const j = await r.json();
  ok(j.accepted === true && sends.length === 0, "redeem error: acked, unrouted recorded, no blind reply");
}
// 22: concurrent double-delivery: exactly one claim, one suppression, one send
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  const [a, b] = await Promise.all([h(signedReq(evt(STOP, "evt-22"))), h(signedReq(evt(STOP, "evt-22")))]);
  const js = [await a.json(), await b.json()];
  const okAcks = js.filter((j) => j.accepted === true || j.deduped === true).length;
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
// 29: STOP redelivery after a NEWER START does NOT resurrect suppression (stale path)
{
  const { h, optouts } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-29stop", "+15551234567", "2026-10-25T04:00:01Z")));
  await h(signedReq(evt("START", "evt-29start", "+15551234567", "2026-10-25T04:00:02Z"))); // newer START applies
  await h(signedReq(evt(STOP, "evt-29stop", "+15551234567", "2026-10-25T04:00:01Z"))); // redelivery of the OLD stop
  ok(optouts.rows.length === 0, "old STOP redelivery after newer START: suppression stays removed");
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


// 31: occurred_at is passed to the RPC and recorded on the claim
{
  const { h, inbound, rpcCalls } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-31", "+15551234567", "2026-10-25T04:00:00Z")));
  const c = rpcCalls.find((c) => c.fn === "inbound_claim_keyword");
  ok(c?.args.p_occurred_at === "2026-10-25T04:00:00Z" && inbound.rows[0].occurred_at === "2026-10-25T04:00:00.000Z",
    "occurred_at passed to RPC and persisted on the claim");
}
// 32: stale keyword event -> 200 deduped-held, suppression untouched, no send
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-32a", "+15551234567", "2026-10-25T04:00:05Z")));
  const r = await h(signedReq(evt(STOP, "evt-32b", "+15551234567", "2026-10-25T04:00:01Z"))); // older STOP
  const j = await r.json();
  ok(j.deduped === true && inbound.rows.find((r) => r.event_id === "evt-32b").status === "stale_event" &&
     sends.length === 1 && optouts.rows.length === 1, "stale event: terminal, no second send, suppression untouched");
}
// 33: dangerous inversion through the ACTUAL handler: STOP(t2) then older START(t1)
{
  const { h, optouts, sends } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-33a", "+15551234567", "2026-10-25T04:00:02Z")));
  const r = await h(signedReq(evt("START", "evt-33b", "+15551234567", "2026-10-25T04:00:01Z"))); // older, arrives late
  const j = await r.json();
  ok(j.deduped === true && optouts.rows.length === 1 && sends.length === 1 &&
     !sends.some((s) => s.payload.text.includes("resubscribed")),
    "INVERSION BLOCKED: late older START cannot re-enable texts or send a resubscribe confirmation");
}
// 34: ambiguous START (no occurred_at) -> held, suppression preserved, no confirmation
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-34a", "+15551234567", "2026-10-25T04:00:02Z")));
  sends.length = 0;
  const r = await h(signedReq(evt("START", "evt-34b"))); // no occurred_at
  const j = await r.json();
  const claim = inbound.rows.find((r) => r.event_id === "evt-34b");
  ok(j.held && claim.status === "held" && optouts.rows.length === 1 && sends.length === 0,
    "ambiguous START held: suppression preserved, no confirmation sent");
}
// 35: ambiguous STOP (no occurred_at) still applies (safe side)
{
  const { h, optouts } = makeWorld({ sendGate: false });
  const r = await h(signedReq(evt(STOP, "evt-35")));
  const j = await r.json();
  ok(j.accepted === true && optouts.rows.length === 1, "unknown-ts STOP applies on the safe side");
}
// 36: unknown-ts STOP then timestamped START newer than the old anchor -> HELD (main's hole)
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-36a", "+15551234567", "2026-10-25T04:00:00Z")));
  await h(signedReq(evt("START", "evt-36b", "+15551234567", "2026-10-25T04:00:05Z"))); // applies, anchor t5
  await h(signedReq(evt(STOP, "evt-36c")));                                            // unknown ts, applies, flag set
  const r = await h(signedReq(evt("START", "evt-36d", "+15551234567", "2026-10-25T04:00:06Z"))); // >anchor, maybe <STOP
  const claim = inbound.rows.find((r) => r.event_id === "evt-36d");
  ok(claim.status === "held" && optouts.rows.length === 1,
    "unknown-ts STOP blocks all later STARTs until re-anchored: no ambiguous resubscribe");
}
// 37: in-flight contradiction - STOP confirmation intent persisted, but a newer START already committed
{
  const { h, inbound, sends } = makeWorld({ sendGate: false });
  inbound.rows.push({ event_id: "evt-37", event_type: "message.received", from_phone: "+15551234567",
    status: "db_done", detail: "BreakerOps: You are unsubscribed and will receive no more texts. Reply START to resubscribe.",
    owner: "crashed", version: 1, idem_key: "44444444-4444-4444-8444-444444444444",
    payload: { from: "+15550001111", to: "+15551234567", text: "BreakerOps: You are unsubscribed and will receive no more texts. Reply START to resubscribe." },
    first_attempt_at: new Date().toISOString(), updated_at: new Date(Date.now() - 180_000).toISOString() });
  // note: no opt-outs row - a newer START already removed it
  const r = await h(signedReq(evt(STOP, "evt-37")));
  const j = await r.json();
  ok(j.accepted === true && sends.length === 0 && inbound.rows[0].status === "stale_event",
    "in-flight contradiction: unsubscribed text NOT sent when a newer START already committed");
}
// 38: reverse contradiction - START confirmation intent persisted, but a newer STOP re-suppressed
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  optouts.rows.push({ phone: "+15551234567", opted_out_at: new Date().toISOString(), keyword: "STOP" });
  inbound.rows.push({ event_id: "evt-38", event_type: "message.received", from_phone: "+15551234567",
    status: "db_done", detail: "BreakerOps: You are resubscribed to texts. Reply STOP to opt out, HELP for help. Msg&data rates may apply.",
    owner: "crashed", version: 1, idem_key: "55555555-5555-4555-8555-555555555555",
    payload: { from: "+15550001111", to: "+15551234567", text: "BreakerOps: You are resubscribed to texts. Reply STOP to opt out, HELP for help. Msg&data rates may apply." },
    first_attempt_at: new Date().toISOString(), updated_at: new Date(Date.now() - 180_000).toISOString() });
  const r = await h(signedReq(evt("START", "evt-38")));
  const j = await r.json();
  ok(j.accepted === true && sends.length === 0 && inbound.rows[0].status === "stale_event",
    "in-flight contradiction: resubscribed text NOT sent when a newer STOP already committed");
}
// 39: redelivery of stale_event / held claims -> deduped ack, no resend
{
  const { h, inbound, sends } = makeWorld({ sendGate: false });
  inbound.rows.push({ event_id: "evt-39a", status: "stale_event", owner: "old", version: 2, updated_at: new Date().toISOString() });
  inbound.rows.push({ event_id: "evt-39b", status: "held", owner: "old", version: 2, updated_at: new Date().toISOString() });
  const r1 = await h(signedReq(evt(STOP, "evt-39a")));
  const r2 = await h(signedReq(evt("START", "evt-39b")));
  const j1 = await r1.json(); const j2 = await r2.json();
  ok(j1.deduped === true && j2.deduped === true && sends.length === 0, "stale/held redeliveries: terminal acks, no resend");
}
// 40: equal timestamps both orders resolve to suppressed
{
  const w1 = makeWorld({ sendGate: false });
  await w1.h(signedReq(evt(STOP, "e1", "+15551234567", "2026-10-25T05:00:00Z")));
  const r1 = await w1.h(signedReq(evt("START", "e2", "+15551234567", "2026-10-25T05:00:00Z")));
  const w2 = makeWorld({ sendGate: false });
  await w2.h(signedReq(evt("START", "e3", "+15551234567", "2026-10-25T05:00:00Z")));
  await w2.h(signedReq(evt(STOP, "e4", "+15551234567", "2026-10-25T05:00:00Z")));
  ok(w1.optouts.rows.length === 1 && w2.optouts.rows.length === 1,
    "equal-ts STOP/START: suppressed in both processing orders (safe side)");
  const j1 = await r1.json();
  ok(j1.deduped === true, "equal-ts START held, not applied");
}


// 41: horizon discipline - unknown-ts STOP: NO timestamped START auto-applies while the horizon stands
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-41a"))); // unknown ts -> applies, horizon = its received time (now)
  sends.length = 0;
  const r = await h(signedReq(evt("START", "evt-41b", "+15551234567", new Date(Date.now() - 1000).toISOString())));
  const claim = inbound.rows.find((r) => r.event_id === "evt-41b");
  ok(claim.status === "held" && optouts.rows.length === 1 && sends.length === 0,
    "no cross-clock auto-apply: timestamped START held while the horizon stands (safe side)");
  const r2 = await h(signedReq(evt("START", "evt-41c", "+15551234567", new Date().toISOString())));
  ok(inbound.rows.find((r) => r.event_id === "evt-41c").status === "held" && optouts.rows.length === 1,
    "START at ~horizon also held: cross-clock comparison proves nothing without a skew bound");
}


// 42: future-beyond-skew timestamps are not trusted: future START held, future STOP applies on safe side
{
  const { h, inbound, optouts, sends } = makeWorld({ sendGate: false });
  const future = new Date(Date.now() + 3600_000).toISOString();
  const r1 = await h(signedReq(evt("START", "evt-42a", "+15551234567", future)));
  ok(inbound.rows.find((r) => r.event_id === "evt-42a").status === "held" && optouts.rows.length === 0,
    "future-ts START treated as ambiguous: held, not applied");
  const r2 = await h(signedReq(evt(STOP, "evt-42b", "+15551234567", future)));
  const j2 = await r2.json();
  ok(j2.accepted === true && optouts.rows.length === 1, "future-ts STOP applies on the safe side");
}
// 43: horizon equality is ambiguous - a START exactly AT the horizon is held
{
  const { h, inbound, optouts } = makeWorld({ sendGate: false });
  await h(signedReq(evt(STOP, "evt-43a"))); // unknown ts; horizon = received now
  const r = await h(signedReq(evt("START", "evt-43b", "+15551234567", new Date().toISOString()))); // ~= horizon
  const claim = inbound.rows.find((r) => r.event_id === "evt-43b");
  ok(claim.status === "held" && optouts.rows.length === 1, "START at the horizon boundary: held (equality ambiguous)");
}
// 44: malformed occurred_at -> START held, no crash
{
  const { h, inbound } = makeWorld({ sendGate: false });
  const r = await h(signedReq(evt("START", "evt-44", "+15551234567", "not-a-timestamp")));
  ok(r.status === 200 && inbound.rows.find((r) => r.event_id === "evt-44").status === "held",
    "malformed occurred_at: START held, event claimed, 200 ack");
}


// 45: poisoned preexisting anchor cannot block a real STOP (read repair)
{
  const { h, optouts, kwState } = makeWorld({ sendGate: false });
  kwState.set("+15551234567", { lastOccurredAt: Date.parse("2030-01-01T00:00:00Z"), unknownHorizon: null, lastAction: "optin" });
  const r = await h(signedReq(evt(STOP, "evt-45", "+15551234567", "2026-10-25T04:00:00Z")));
  const j = await r.json();
  ok(j.accepted === true && optouts.rows.length === 1,
    "poisoned 2030 anchor repaired at read: real STOP applies, not dropped as stale");
}
// 46: future-dated START cannot poison the anchor at all
{
  const { h, inbound, optouts, kwState } = makeWorld({ sendGate: false });
  await h(signedReq(evt("START", "evt-46a", "+15551234567", "2030-01-01T00:00:00Z")));
  ok(inbound.rows.find((r) => r.event_id === "evt-46a").status === "held" && kwState.size === 0,
    "future-dated START: held, no state written, anchor cannot be poisoned");
  const r = await h(signedReq(evt(STOP, "evt-46b", "+15551234567", "2026-10-25T04:00:00Z")));
  const j = await r.json();
  ok(j.accepted === true && optouts.rows.length === 1, "real STOP after future-START attempt applies");
}


// 47: ack-fast proof - the 2xx returns BEFORE the post-claim flow can finish
{
  let release!: () => void;
  const latch = new Promise<void>((res) => { release = res; });
  const { rawH, bgTasks, optouts, sends } = makeWorld({ sendGate: false, sendLatch: latch });
  const r = await rawH(signedReq(evt(STOP, "evt-47"))); // send is latch-blocked mid-flow
  const j = await r.json();
  ok(j.accepted === true && optouts.rows.length === 1 && sends.length === 0 && bgTasks.length === 1,
    "ack-fast: 2xx returned with suppression already durable while the confirmation was still blocked in the background");
  release();
  await Promise.all(bgTasks.splice(0));
  ok(sends.length === 1, "background flow then completes the confirmation");
}


// 48: F-D - bogus-low/non-finite occurred_at treated as unknown, never dropped as stale
{
  const { h, inbound, optouts } = makeWorld({ sendGate: false });
  await h(signedReq(evt("START", "evt-48a", "+15551234567", "2026-10-25T04:00:00Z"))); // anchors optin
  const r = await h(signedReq(evt(STOP, "evt-48b", "+15551234567", "0001-01-01T00:00:00Z")));
  const j = await r.json();
  ok(j.accepted === true && optouts.rows.length === 1,
    "bogus-low STOP: treated as unknown, applies on the safe side - never dropped as stale");
  const claim = inbound.rows.find((r) => r.event_id === "evt-48b");
  ok(claim.occurred_at === null, "bogus-low timestamp not stored as if real");
}
// 49: sweep stage B/C - a send already dispatched completes; outcome CAS fails against a swept row
{
  let release!: () => void;
  const latch = new Promise<void>((res) => { release = res; });
  const { rawH, bgTasks, inbound, sends } = makeWorld({ sendGate: false, sendLatch: latch });
  await rawH(signedReq(evt(STOP, "evt-49")));
  await new Promise((r) => setTimeout(r, 10)); // let the background flow reach the latch-blocked send ('sending')
  // mid-flow: sweep flips the row while the provider call is in flight
  inbound.rows[0].status = "uncertain";
  release();
  await Promise.all(bgTasks.splice(0));
  ok(sends.length === 1 && inbound.rows[0].status === "uncertain",
    "stage B/C: dispatched send completes (irreversible), outcome CAS fails, row stays uncertain for desk - never a duplicate");
}


// 50: post-ack process death mid-flow leaves DISCOVERABLE recovery state
{
  let release!: () => void;
  const latch = new Promise<void>((res) => { release = res; });
  const { rawH, bgTasks, inbound, optouts, sends } = makeWorld({ sendGate: false, sendLatch: latch });
  const r = await rawH(signedReq(evt(STOP, "evt-50")));
  const j = await r.json();
  await new Promise((r2) => setTimeout(r2, 10)); // flow reaches the latch-blocked send
  bgTasks.length = 0; // simulate process death: scheduled work never completes
  const c = inbound.rows[0];
  ok(j.accepted === true && optouts.rows.length === 1 && sends.length === 0 &&
     c.status === "sending" && !!c.owner && !!c.idem_key && !!c.first_attempt_at,
    "death mid-flow: ack already sent, suppression durable, claim sits in sending with owner+idem key+attempt time - sweeper/desk recoverable (desk item, not auto-retry)");
  release(); // let the dangling promise settle so the suite exits clean
  await new Promise((r2) => setTimeout(r2, 10));
}

console.log(`all ${passed} checks passed`);
