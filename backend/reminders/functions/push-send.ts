// push-send: send a web push notification to one user's stored subscriptions.
// Preview companion for /push-preview/. VAPID_JWKS secret holds the JWK pair.
import * as webpush from "jsr:@negrel/webpush";
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
  if (req.method !== "POST") return reply({error:"method not allowed"}, 405);
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!token) return reply({ error: "auth required" }, 401);
  let payload;
  try { payload = await req.json(); } catch { return reply({error:"invalid request"},400); }
  const { user_id, url: requestedUrl } = payload;
  const title = "BreakerOps test";
  const body = "If this banner showed up, push notifications work.";
  // Default tap-through stays the v1 preview; v2 passes its own calendar URL.
  let url = "https://www.breakerops.com/push-preview/calendar/";
  if (typeof requestedUrl === "string") {
    try {
      const u = new URL(requestedUrl);
      const okHost = u.hostname === "www.breakerops.com" || u.hostname === "breakerops.com";
      const okPath = u.pathname.startsWith("/push-preview/") || u.pathname.startsWith("/push-preview-v2/");
      if (u.protocol === "https:" && u.port === "" && u.username === "" && u.password === "" && okHost && okPath) url = u.origin + u.pathname + u.search;
    } catch { /* keep default */ }
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user || data.user.id !== user_id) {
    return reply({ error: "forbidden" }, 403);
  }
  const vapidKeys = await webpush.importVapidKeys(JSON.parse(Deno.env.get("VAPID_JWKS")!), { extractable: false });
  const appServer = await webpush.ApplicationServer.new({
    contactInformation: "mailto:nick@breakerops.com",
    vapidKeys,
  });
  const { data: subs, error: readError } = await sb.from("push_subscriptions").select("*").eq("user_id", user_id);
  if (readError) return reply({error:"Unable to read subscriptions"},500);
  let sent = 0, failed = 0;
  const dead: string[] = [];
  for (const s of subs || []) {
    try {
      const endpoint = new URL(s.endpoint);
      const trusted = endpoint.protocol === "https:" && (endpoint.hostname === "web.push.apple.com" || endpoint.hostname.endsWith(".push.apple.com") || endpoint.hostname === "fcm.googleapis.com" || endpoint.hostname.endsWith(".push.services.mozilla.com"));
      if (!trusted) { failed++; continue; }
      const subscriber = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
      await subscriber.pushTextMessage(JSON.stringify({ title, body, url }), {});
      sent++;
    } catch (err) {
      failed++;
      const msg = String(err);
      if (msg.includes("404") || msg.includes("410")) dead.push(s.id);
    }
  }
  if (dead.length) await sb.from("push_subscriptions").delete().in("id", dead);
  return reply({ sent, failed, pruned: dead.length });
});
