// reminders-push: server-to-server web push for event reminders.
// Called by pg_cron with the shared REMINDERS_KEY.
// Recipients: while PUSH_OWNER_USER_ID is set, only that pinned user (the
// original single-owner behavior, byte-for-byte unchanged). With the pin
// removed, every member of the reminder's business who has explicitly
// registered a push subscription - subscriptions are self-registered per
// device under own-subs RLS, so fan-out only reaches devices a member opted
// in themselves, never implicit membership. Flipping modes is a config
// decision (remove the pin), not a code change.
import * as webpush from "jsr:@negrel/webpush";
import { createClient } from "jsr:@supabase/supabase-js@2";

const reply = (data: unknown, status = 200) => Response.json(data, { status });
Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "method not allowed" }, 405);
  if (req.headers.get("x-reminders-key") !== Deno.env.get("REMINDERS_KEY")) return reply({ error: "unauthorized" }, 401);
  let payload;
  try { payload = await req.json(); } catch { return reply({ error: "invalid request" }, 400); }
  const { business_id, title, body, url } = payload;
  if (!business_id || !body) return reply({ error: "missing fields" }, 400);

  const serviceKey = (() => {
    const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (legacy) return legacy;
    try {
      const dict = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      return dict.SERVICE_ROLE_KEY ?? dict.service_role ?? Object.values(dict)[0] ?? "";
    } catch { return ""; }
  })();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const ownerId = Deno.env.get("PUSH_OWNER_USER_ID");
  let subsQuery;
  if (ownerId) {
    subsQuery = sb.from("push_subscriptions").select("*").eq("user_id", ownerId);
  } else {
    const { data: members, error: mErr } = await sb.from("business_members").select("user_id").eq("business_id", business_id);
    if (mErr) return reply({ error: "member lookup failed: " + mErr.message }, 500);
    const ids = (members || []).map((m: any) => m.user_id);
    if (!ids.length) return reply({ sent: 0, failed: 0, pruned: 0, recipients: 0 });
    subsQuery = sb.from("push_subscriptions").select("*").in("user_id", ids);
  }
  const { data: subs, error: sErr } = await subsQuery;
  if (sErr) return reply({ error: "subscription lookup failed: " + sErr.message }, 500);
  const vapidKeys = await webpush.importVapidKeys(JSON.parse(Deno.env.get("VAPID_JWKS")!), { extractable: false });
  const appServer = await webpush.ApplicationServer.new({
    contactInformation: "mailto:nick@breakerops.com",
    vapidKeys,
  });
  let sent = 0, failed = 0;
  const dead: string[] = [];
  for (const s of subs || []) {
    try {
      const endpoint = new URL(s.endpoint);
      const trusted = endpoint.protocol === "https:" && (endpoint.hostname === "web.push.apple.com" || endpoint.hostname.endsWith(".push.apple.com") || endpoint.hostname === "fcm.googleapis.com" || endpoint.hostname.endsWith(".push.services.mozilla.com"));
      if (!trusted) { failed++; continue; }
      const subscriber = appServer.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
      await subscriber.pushTextMessage(JSON.stringify({ title: title || "BreakerOps", body, url: url || "https://www.breakerops.com/app/" }), { urgency: webpush.Urgency.High });
      sent++;
    } catch (err) {
      failed++;
      const msg = String(err);
      if (msg.includes("404") || msg.includes("410")) dead.push(s.id);
    }
  }
  if (dead.length) await sb.from("push_subscriptions").delete().in("id", dead);
  return reply({ sent, failed, pruned: dead.length, mode: ownerId ? "owner-pinned" : "business-members" });
});
