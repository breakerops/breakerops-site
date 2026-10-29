// BreakerOps life-log (Jake's personal calendar preserve-link, Oct 29).
// Read-only JSON feed for the standalone /life/ page: his calendar_items and
// daily_summaries exactly as they live in the app DB, so the shareable link
// always shows the same items, statuses and checkmarks as /app/.
// Additive only: this changes nothing the app or cabinet reads or writes.
//
// Auth: ?t= token (or x-life-token header) matched against private.config
// key 'life_log_token' (service-role read via webhook_config). The deployed
// page carries no token; only the shared link holds it.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUSINESS_ID = 'c91e6dbc-7cba-479d-8c8d-ea2ffd84967e'; // Jake's pilot business

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-life-token',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  }

  const sb = createClient(SB_URL, SB_KEY);

  const url = new URL(req.url);
  const token = url.searchParams.get('t') || req.headers.get('x-life-token') || '';
  const { data: expected } = await sb.rpc('webhook_config', { p_key: 'life_log_token' });
  if (!expected || !token || token !== expected) {
    return json({ ok: false, reason: 'unauthorized' }, 401);
  }

  const [items, summaries] = await Promise.all([
    sb.from('calendar_items')
      .select('id,title,due_date,due_time,notes,completed')
      .eq('business_id', BUSINESS_ID)
      .order('due_date')
      .order('due_time'),
    sb.from('daily_summaries')
      .select('date,sections')
      .eq('business_id', BUSINESS_ID)
      .order('date', { ascending: false })
      .limit(120),
  ]);

  if (items.error) return json({ ok: false, reason: 'items_read_failed' }, 500);
  if (summaries.error) return json({ ok: false, reason: 'summaries_read_failed' }, 500);

  return json({
    ok: true,
    items: items.data || [],
    summaries: (summaries.data || []).map((r: any) => ({ date: r.date, sections: r.sections })),
  });
});
