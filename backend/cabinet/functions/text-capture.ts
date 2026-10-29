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

const PARSER_VERSION = 'parse-v3';

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

// parse-v2: still deliberately small. Recognizes four owner-text shapes:
//   quote:     "quote <job hint>, $<amount>"      e.g. "quote Miller, $400"
//   schedule:  "plan <job hint>, <when text>"     e.g. "plan Miller, 2026-11-02 08:00"
//   warranty:  "warranty <job hint>, <item>[, <term>]"
//   extra:     "<job hint>, <what>[, $<amount>]"  e.g. "Miller job, added outlet, $180"
// Anything else -> kind 'other' (saved with parse record, nothing filed).
// Price is captured only when the owner typed it - never invented. Schedule
// times are stored raw and parsed only when Date.parse is sure; the raw text
// always survives in message_parses.output.
function parse(body: string) {
  let m = body.match(/^\s*(?:what|how much)\s+does\s+(.+?)\s+owe(?:\s+me)?\s*\??\s*$/i)
       || body.match(/^\s*what(?:'s| is)\s+owed\s+(?:on|for)\s+(.+?)\s*\??\s*$/i);
  if (m) {
    return {
      kind: 'money_query',
      output: { job_hint: m[1].trim() },
      confidence: 0.7,
    };
  }
  m = body.match(/^\s*quot(?:e|ed)\s+([^,]+?)\s*,\s*\$?(\d+(?:\.\d{1,2})?)\s*$/i);
  if (m) {
    return {
      kind: 'quote',
      output: { job_hint: m[1].trim(), amount_cents: Math.round(parseFloat(m[2]) * 100) },
      confidence: 0.7,
    };
  }
  m = body.match(/^\s*(?:plan|schedule)\s+([^,]+?)\s*,\s*(.+?)\s*$/i);
  if (m) {
    const whenText = m[2].trim();
    const t = Date.parse(whenText);
    const sure = !Number.isNaN(t);
    return {
      kind: 'schedule',
      output: {
        job_hint: m[1].trim(),
        when_text: whenText,
        proposed_start: sure ? new Date(t).toISOString() : null,
      },
      confidence: sure ? 0.6 : 0.4,
    };
  }
  m = body.match(/^\s*warranty\s+([^,]+?)\s*,\s*([^,]+?)(?:\s*,\s*(.+?))?\s*$/i);
  if (m) {
    return {
      kind: 'warranty',
      output: { job_hint: m[1].trim(), item: m[2].trim(), term_text: m[3]?.trim() ?? null },
      confidence: 0.6,
    };
  }
  m = body.match(/^\s*([^,]+?)\s*,\s*(.+?)(?:\s*,?\s*\$(\d+(?:\.\d{1,2})?))?\s*$/);
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
  // Fail CLOSED: if the opt-out lookup errors, treat the number as opted
  // out - suppress any reply rather than text an unknown-status number.
  const { data: opt, error: optErr } = await sb
    .from('sms_opt_outs').select('phone').eq('phone', fromPhone).maybeSingle();
  const optedOut = optErr ? true : !!opt;

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
  //    One match -> file the record. Zero or many -> persist the capture and
  //    ask ONE question; never guess, never duplicate a job.
  let outcome: any = { kind: parsed.kind };
  const needsJob = ['extra', 'quote', 'schedule', 'warranty', 'money_query'];
  if (needsJob.includes(parsed.kind)) {
    const hint = (parsed.output.job_hint as string).toLowerCase();
    const { data: jobs } = await sb
      .from('cabinet_jobs')
      .select('id, title')
      .eq('business_id', businessId)
      .eq('status', 'open');
    const matches = (jobs ?? []).filter((j: any) => j.title.toLowerCase().includes(hint));

    if (matches.length === 1) {
      const jobId = matches[0].id;
      let table = '';
      let row: any = null;
      let ins: any = null;
      if (parsed.kind === 'extra') {
        table = 'unbilled_extras';
        row = {
          business_id: businessId, job_id: jobId, source_ref: msg.id,
          description: parsed.output.description, amount_cents: parsed.output.amount_cents,
          state: 'recorded', customer_authorization: 'unknown',
        };
      } else if (parsed.kind === 'quote') {
        table = 'cabinet_quotes';
        row = {
          business_id: businessId, job_id: jobId, source_ref: msg.id,
          amount_cents: parsed.output.amount_cents, state: 'open',
        };
      } else if (parsed.kind === 'schedule') {
        table = 'schedule_proposals';
        row = {
          business_id: businessId, job_id: jobId, source_ref: msg.id,
          proposed_start: parsed.output.proposed_start, state: 'owner_plan',
        };
      } else if (parsed.kind === 'money_query') {
        // Read-only answer: what is still open on this job. No row created.
        const { data: invs } = await sb
          .from('cabinet_invoices')
          .select('amount_cents')
          .eq('business_id', businessId)
          .eq('job_id', jobId)
          .eq('state', 'open');
        const total = (invs ?? []).reduce((a: number, i: any) => a + (i.amount_cents ?? 0), 0);
        outcome = {
          kind: 'money_answer', job_id: jobId,
          open_total_cents: total, open_count: (invs ?? []).length,
          job_title: matches[0].title,
        };
      } else {
        table = 'warranty_records';
        row = {
          business_id: businessId, job_id: jobId, source_ref: msg.id,
          item: parsed.output.item, term_text: parsed.output.term_text,
        };
      }
      if (parsed.kind !== 'money_query') {
        const { data: created, error: insErr } = await sb.from(table).insert(row).select('id').single();
        if (insErr) return json({ error: table + ' commit failed' }, 500);
        ins = created;
        await sb.from('cabinet_history').insert({
          business_id: businessId, entity_table: table, entity_id: created.id,
          change_kind: 'create', new: parsed.output,
        });
        outcome = { kind: parsed.kind + '_recorded', record_id: ins.id, job_id: jobId };
      }
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
  const reply = optedOut ? null
    : outcome.kind === 'extra_recorded'
      ? `Filed: ${parsed.output.description}${parsed.output.amount_cents != null ? ' $' + (parsed.output.amount_cents / 100).toFixed(2) : ''} unbilled. Nothing sent.`
      : outcome.kind === 'money_answer'
        ? (outcome.open_count > 0
            ? `${outcome.job_title} owes $${(outcome.open_total_cents / 100).toFixed(2)} across ${outcome.open_count} open invoice${outcome.open_count > 1 ? 's' : ''}.`
            : `Nothing open on ${outcome.job_title}.`)
        : outcome.kind === 'quote_recorded'
        ? `Filed: quote ${parsed.output.amount_cents != null ? '$' + (parsed.output.amount_cents / 100).toFixed(2) : '(no price recorded)'}. Nothing sent.`
        : outcome.kind === 'schedule_recorded'
          ? `Filed on your plan: ${parsed.output.when_text}. Customer side untouched.`
          : outcome.kind === 'warranty_recorded'
            ? `Filed warranty: ${parsed.output.item}.`
            : outcome.kind === 'unresolved'
              ? 'Saved your note. Which job does it belong to? Nothing filed yet.'
              : 'Saved. Nothing filed yet.';

  return json({ ok: true, duplicate_safe: true, outcome, reply, opted_out: optedOut });
});
