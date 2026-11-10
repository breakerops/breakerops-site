// chat-send: customer -> Matt message from the in-app chat page. Verifies the
// caller's user JWT, rate limits (10/min, 200/day per user, DB-side counts),
// inserts through RLS with the caller's token (so the is_member check stays in
// the database), then notifies the desk email via Resend with minimal content
// (no customer message text leaves the database).
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
  const businessId = typeof payload?.business_id === "string" ? payload.business_id : "";
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!businessId || !body || body.length > 4000) return reply({ error: "invalid request" }, 400);
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return reply({ error: "forbidden" }, 403);
  // Rate limit: count this user's recent customer messages (DB-side).
  const minAgo = new Date(Date.now() - 60_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { count: perMin } = await admin.from("messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", data.user.id).eq("direction", "in").gte("created_at", minAgo);
  if ((perMin ?? 0) >= 10) return reply({ error: "rate limited" }, 429);
  const { count: perDay } = await admin.from("messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", data.user.id).eq("direction", "in").gte("created_at", dayAgo);
  if ((perDay ?? 0) >= 200) return reply({ error: "rate limited" }, 429);
  // Insert as the caller so the messages_member_write policy (is_member) applies.
  // Fail loud if the desk-notify key is missing: better to break the send path
  // visibly than to silently stop alerting the desk.
  if (!Deno.env.get("RESEND_API_KEY")) return reply({ error: "server misconfigured: RESEND_API_KEY missing" }, 500);
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { error: insErr } = await asUser.from("messages").insert({ business_id: businessId, user_id: data.user.id, direction: "in", body });
  if (insErr) return reply({ error: "send failed" }, 500);
  // Desk notify via Resend: identifiers only, never the customer's text.
  {
    const note = fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "BreakerOps <auth@breakerops.com>",
        to: "nick@breakerops.com",
        subject: "New BreakerOps chat message",
        text: `New chat message in business ${businessId} at ${new Date().toISOString()}. Open the desk view to read and reply.`,
      }),
    }).catch(() => {});
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(note); } catch (_) { /* ignore */ }
  }
  return reply({ ok: true });
});
