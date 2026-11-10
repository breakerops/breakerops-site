// push-subscribe: save the caller's web push subscription. Endpoints are per
// device+site, not per user, so an endpoint that already exists under another
// user is reassigned to the caller (upsert on the endpoint unique key).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://www.breakerops.com",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply({ error: "method not allowed" }, 405);
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!token) return reply({ error: "auth required" }, 401);
  let payload;
  try { payload = await req.json(); } catch { return reply({ error: "invalid request" }, 400); }
  const { endpoint, p256dh, auth, user_agent } = payload || {};
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string" ||
      !endpoint || endpoint.length > 2048 || !p256dh || !auth || p256dh.length > 512 || auth.length > 512) {
    return reply({ error: "invalid request" }, 400);
  }
  try {
    const u = new URL(endpoint);
    const trusted = u.protocol === "https:" &&
      (u.hostname === "web.push.apple.com" || u.hostname.endsWith(".push.apple.com") ||
       u.hostname === "fcm.googleapis.com" || u.hostname.endsWith(".push.services.mozilla.com"));
    if (!trusted) return reply({ error: "invalid request" }, 400);
  } catch { return reply({ error: "invalid request" }, 400); }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return reply({ error: "forbidden" }, 403);
  const { error: upErr } = await sb.from("push_subscriptions").upsert(
    { user_id: data.user.id, endpoint, p256dh, auth, user_agent: String(user_agent || "").slice(0, 512) },
    { onConflict: "endpoint" }
  );
  if (upErr) return reply({ error: "save failed" }, 500);
  return reply({ ok: true });
});
