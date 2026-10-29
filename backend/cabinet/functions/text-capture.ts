// BreakerOps cabinet text-capture (Dan backend, slice 1)
// Receives an inbound text event, durably commits the immutable source record,
// resolves tenant + job, records an unbilled extra or enqueues a resolution
// question, and ONLY THEN acknowledges. Duplicate provider deliveries make one
// record (unique business_id+provider+provider_message_id).
//
// Matt's contract encoded:
//  - identity: tenant resolved ONLY via verified phone_identities.phone; never
//    via business id, sender name, or message text. Wrong/unknown tenant
//    rejects BEFORE any capture row references it.
//  - idempotency: duplicate delivery => one record, safe re-ack.
//  - opt-out: sms_opt_outs checked before ANY reply dispatch. Slice 1 replies
//    are owner-only acks ("filed..."), never customer sends.
//  - ack only after durable commit.
//  - outbound/scheduled brief/email intake/money movement: NOT here.
//
// Auth: x-reminders-key shared secret (same pattern as reminders-send).
// Telnyx signature verification is enforced once TELNYX_PUBLIC_KEY is set;
// wiring Telnyx -> this function is a separate, explicit step (phone-identity
// decision pending).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Shared webhook secret + Telnyx signing public key live in private.config
// (service-role read; never passes through operator context). Env vars are a
// fallback for local testing only.
let cfgCache: Record<string, string> | null = null;
async function cfg(sb: any, key: string): Promise<string> {
  if (!cfgCache) cfgCache = {};
  if (!(key in cfgCache)) {
    const { data } = await sb.rpc('webhook_config', { p_key: key });
    cfgCache[key] = (data as string) || Deno.env.get(key.toUpperCase()) || '';
  }
  return cfgCache[key];
}

const PARSER_VERSION = 'parse-v1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function verifyTelnyx(req: Request, raw: string, pubKey: string): Promise<boolean> {
  if (!pubKey) return false; // not wired -> not trusted
  // Telnyx ed25519 signature over `${timestamp}|${rawBody}`
  try {
    const sig = req.headers.get('telnyx-signature-ed25519') ?? '';
    const ts = req.headers.get('telnyx-timestamp') ?? '';
    if (!sig || !ts) return false;
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(pubKey), (c) => c.charCodeAt(0)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const data = new TextEncoder().encode(`${ts}|${raw}`);
    const sigBytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify('Ed25519', key, sigBytes, data);
  } catch {
    return false;
  }
}

// parse-v1: deliberately small. Recognizes an unbilled-extra shape only:
//   "<job hint>, <what>, $<amount>" e.g. "Miller job, added outlet, $180"
// Anything else -> unresolved (one question via resolution_queue).
// Price is captured only when the owner typed it - never invented.
function parse(body: string) {
  const m = body.match(/^\s*([^,]+?)\s*,\s*(.+?)(?:\s*,?\s*\$(\d+(?:\.\d{1,2})?))?\s*$/);
  if (!m) return { kind: 'other', output: { raw: body }, confidence: 0 };
  const [, jobHint, what, amount] = m;
  const hasPrice = amount !== undefined;
  return {
    kind: 'extra',
    output: {
      job_hint: jobHint.trim(),
      description: what.trim(),
      amount_cents: hasPrice ? Math.round(parseFloat(amount) * 100) : null,
    },
    confidence: hasPrice ? 0.7 : 0.5,
  };
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const raw = await req.text();
  const sb = createClient(SB_URL, SB_KEY);
  const remindersKey = await cfg(sb, 'reminders_key');
  if (remindersKey && req.headers.get('x-reminders-key') !== remindersKey) {
    return json({ error: 'unauthorized' }, 401);
  }

  let event: any;
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }

  // Shape: { provider, provider_message_id, from_phone, to_phone, body, received_at?, attachments? }
  const provider = String(event.provider ?? 'telnyx');
  const providerMessageId = String(event.provider_message_id ?? '');
  const fromPhone = String(event.from_phone ?? '');
  const body = String(event.body ?? '');
  if (!providerMessageId || !fromPhone) return json({ error: 'missing identity fields' }, 400);

  if (provider === 'telnyx' && !(await verifyTelnyx(req, raw, await cfg(sb, 'telnyx_public_key')))) {
    return json({ error: 'unverified signature' }, 401);
  }

  // 1. Resolve tenant via VERIFIED phone identity only.
  const { data: ids, error: idErr } = await sb
    .from('phone_identities')
    .select('business_id, verified_at')
    .eq('phone', fromPhone)
    .not('verified_at', 'is', null);
  if (idErr) return json({ error: 'identity lookup failed' }, 500);
  if (!ids || ids.length === 0) {
    return json({ ok: false, reason: 'unknown_or_unverified_phone' }, 200); // no capture, no ack of filing
  }
  if (ids.length > 1) {
    // ambiguous tenant mapping: refuse rather than risk cross-tenant capture
    return json({ error: 'ambiguous_phone_identity' }, 409);
  }
  const businessId = ids[0].business_id;

  // 2. Opt-out check (before any reply dispatch; capture still proceeds).
  const { data: opt } = await sb
    .from('sms_opt_outs').select('phone').eq('phone', fromPhone).maybeSingle();

  // 3. Idempotent durable commit of the immutable source. ignoreDuplicates:
  // a replayed provider delivery inserts NOTHING and returns no row, and we
  // stop there - one capture, no duplicated extras/resolutions, no re-ack.
  const { data: msgRows, error: msgErr } = await sb
    .from('inbound_messages')
    .upsert({
      business_id: businessId,
      provider,
      provider_message_id: providerMessageId,
      channel: 'sms',
      from_phone: fromPhone,
      to_phone: event.to_phone ?? null,
      body,
      payload: event,
      received_at: event.received_at ?? new Date().toISOString(),
    }, { onConflict: 'business_id,provider,provider_message_id', ignoreDuplicates: true })
    .select('id');
  if (msgErr) return json({ error: 'capture failed' }, 500);
  if (!msgRows || msgRows.length === 0) {
    return json({ ok: true, duplicate: true, outcome: { kind: 'duplicate_replayed' }, reply: null });
  }
  const msg = msgRows[0];

  // 4. Parse (versioned, stored separately).
  const parsed = parse(body);
  await sb.from('message_parses').insert({
    inbound_message_id: msg.id,
    business_id: businessId,
    parser_version: PARSER_VERSION,
    kind: parsed.kind,
    output: parsed.output,
    confidence: parsed.confidence,
  });

  // 5. Resolve job: match hint against open jobs' titles, case-insensitive.
  let outcome: any = { kind: parsed.kind };
  if (parsed.kind === 'extra') {
    const hint = (parsed.output.job_hint as string).toLowerCase();
    const { data: jobs } = await sb
      .from('cabinet_jobs')
      .select('id, title')
      .eq('business_id', businessId)
      .eq('status', 'open');
    const matches = (jobs ?? []).filter((j: any) => j.title.toLowerCase().includes(hint));

    if (matches.length === 1) {
      const { data: extra, error: exErr } = await sb
        .from('unbilled_extras')
        .insert({
          business_id: businessId,
          job_id: matches[0].id,
          source_ref: msg.id,
          description: parsed.output.description,
          amount_cents: parsed.output.amount_cents,
          state: 'recorded',
          customer_authorization: 'unknown',
        })
        .select('id')
        .single();
      if (exErr) return json({ error: 'extra commit failed' }, 500);
      await sb.from('cabinet_history').insert({
        business_id: businessId, entity_table: 'unbilled_extras', entity_id: extra.id,
        change_kind: 'create', new: parsed.output,
      });
      outcome = { kind: 'extra_recorded', extra_id: extra.id, job_id: matches[0].id };
    } else {
      // Ambiguous or unknown job: persist the capture, ask ONE question.
      const { data: res } = await sb.from('resolution_queue').insert({
        business_id: businessId,
        source_ref: msg.id,
        question: matches.length === 0 ? 'which_job' : 'which_of_these_jobs',
        options: matches.map((j: any) => ({ job_id: j.id, title: j.title })),
      }).select('id').single();
      outcome = { kind: 'unresolved', resolution_id: res?.id ?? null, candidates: matches.length };
    }
  }

  // 6. Ack only after durable commit. Reply text says "filed" only when it is.
  const reply = opt ? null
    : outcome.kind === 'extra_recorded'
      ? `Filed: ${parsed.output.description}${parsed.output.amount_cents != null ? ' $' + (parsed.output.amount_cents / 100).toFixed(2) : ''} unbilled. Nothing sent.`
      : outcome.kind === 'unresolved'
        ? 'Saved your note. Which job does it belong to? Nothing filed yet.'
        : 'Saved. Nothing filed yet.';

  return json({ ok: true, duplicate_safe: true, outcome, reply, opted_out: !!opt });
});
