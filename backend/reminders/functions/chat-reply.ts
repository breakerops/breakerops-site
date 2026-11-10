// chat-reply: Matt -> customer reply, called by the concierge desk with the
// dedicated CHAT_REPLY_KEY secret (constant-time compare). Verifies the target
// user is a member of the business before insert and push. Inserts the message
// (service role), then pushes a generic "New message from Matt" alert to the
// customer's devices; push failures never fail the reply or retry the insert.
import * as webpush from "jsr:@negrel/webpush";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CHAT_REPLY_KEY = Deno.env.get("CHAT_REPLY_KEY") ?? "";
const reply = (data: unknown, status = 200) => Response.json(data, { status });

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "method not allowed" }, 405);
  if (!CHAT_REPLY_KEY || !safeEqual(req.headers.get("x-chat-reply-key") ?? "", CHAT_REPLY_KEY)) {
    return reply({ error: "auth required" }, 401);
  }
  let payload;
  try { payload = await req.json(); } catch { return reply({ error: "invalid request" }, 400); }
  const businessId = typeof payload?.business_id === "string" ? payload.business_id : "";
  const userId = typeof payload?.user_id === "string" ? payload.user_id : "";
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!businessId || !userId || !body || body.length > 4000) return reply({ error: "invalid request" }, 400);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: membership } = await sb.from("business_members")
    .select("user_id").eq("business_id", businessId).eq("user_id", userId).limit(1);
  if (!membership || !membership.length) return reply({ error: "forbidden" }, 403);
  const { error: insErr } = await sb.from("messages").insert({ business_id: businessId, user_id: userId, direction: "out", body });
  if (insErr) return reply({ error: "send failed" }, 500);
  // The message is saved; a push failure must not look like a reply failure.
  let sent = 0, pruned = 0;
  try {
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(Deno.env.get("VAPID_JWKS")!), { extractable: false });
    const appServer = await webpush.ApplicationServer.new({
      contactInformation: "mailto:nick@breakerops.com",
      vapidKeys,
    });
    const { data: subs } = await sb.from("push_subscriptions").select("*").eq("user_id", userId);
    const dead: string[] = [];
    for (const s of subs || []) {
      try {
        const endpoint = new URL(s.endpoint);
        const trusted = endpoint.protocol === "https:" &&
          (endpoint.hostname === "web.push.apple.com" || endpoint.hostname.endsWith(".push.apple.com") ||
           endpoint.hostname === "fcm.googleapis.com" || endpoint.hostname.endsWith(".push.services.mozilla.com"));
        if (!trusted) continue;
        const subscriber = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
        await subscriber.pushTextMessage(JSON.stringify({
          title: "BreakerOps",
          body: "New message from Matt",
          url: "https://www.breakerops.com/push-preview-v2/chat/",
        }), {});
        sent++;
      } catch (err) {
        const msg = String(err);
        if (msg.includes("404") || msg.includes("410")) dead.push(s.id);
      }
    }
    if (dead.length) await sb.from("push_subscriptions").delete().in("id", dead);
    pruned = dead.length;
  } catch (err) {
    console.error("chat-reply push failed", err);
  }
  return reply({ ok: true, sent, pruned });
});
