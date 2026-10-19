import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-reminders-key',
}

// One reply envelope, no application-level SMS fan-out. Preserve all facts:
// if it will exceed two SMS segments, reject for rewriting; never truncate.
function mergeReply(value) {
  if (Array.isArray(value)) return value.map(mergeReply).filter(Boolean).join(" ");
  if (value && typeof value === "object") return mergeReply(value.text ?? value.content ?? value.messages ?? "");
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function fitsReply(text) {
  const gsm = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const ext = "^{}\\[~]|€";
  let units = 0;
  for (const char of text) {
    if (gsm.includes(char)) units++;
    else if (ext.includes(char)) units += 2;
    else return text.length <= 134; // 2 concatenated UCS-2 segments
  }
  return units <= 306; // 2 concatenated GSM-7 segments
}

// POST body: { business_id, recipient_channel, recipient, body, send_at, idempotency_key, template_id?, created_by? }
// Secured with a shared secret in x-reminders-key, checked before touching data.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.headers.get('x-reminders-key') !== Deno.env.get('REMINDERS_KEY')) {
    return json({ error: 'unauthorized' }, 401)
  }
  try {
    const p = await req.json()
    if (!p.business_id || !p.recipient_channel || !p.recipient || !p.body || !p.send_at || !p.idempotency_key) {
      return json({ error: 'missing fields' }, 400)
    }
    p.body = mergeReply(p.body);
    if (!p.body || (p.recipient_channel === 'sms' && !fitsReply(p.body))) {
      return json({ error: 'reply_needs_shortening', detail: 'One reply, at most two SMS segments. No reminder created.' }, 422)
    }
    const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    await db.from('reminders').upsert({
      business_id: p.business_id,
      recipient_channel: p.recipient_channel,
      recipient: p.recipient,
      body: p.body,
      send_at: p.send_at,
      idempotency_key: p.idempotency_key,
      template_id: p.template_id || null,
      created_by: p.created_by || 'conversation',
    }, { onConflict: 'business_id,idempotency_key', ignoreDuplicates: true })
    // Always read back by key: covers both fresh inserts and repeat calls.
    const { data: row, error } = await db.from('reminders')
      .select('*')
      .eq('business_id', p.business_id)
      .eq('idempotency_key', p.idempotency_key)
      .single()
    if (error) return json({ error: error.message }, 500)
    return json({ reminder: row }, 201)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
