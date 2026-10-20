// invites-issue: issues a customer referral link (five-invite allowance, recipient-bound,
// one-use). NOT DEPLOYED yet - admission stays disabled until Jake settles activation.
//
// Two caller paths:
//  1) Customer self-serve: Authorization bearer JWT; body { customer_id, email, request_key, expires_in_days? }
//  2) Desk / Matt text flow: x-invites-desk-key shared secret; body { phone, email, request_key, expires_in_days? }
//     The customer texts Matt; the desk matches the sender's E.164 phone to their customer row.
//
// Returns the raw token ONCE. Tokens are stored hashed; an idempotent retry returns
// already_issued with no token. Expiry default: 7 days (proposed default, Jake can change).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-invites-desk-key",
};

const URL_BASE = Deno.env.get("INVITE_URL_BASE") || "https://www.breakerops.com/join/";
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p = await req.json().catch(() => ({}));
    const email = String(p.email || "").trim().toLowerCase();
    const requestKey = String(p.request_key || "").trim();
    if (!email || !email.includes("@")) return json({ error: "recipient email required" }, 400);
    if (!requestKey) return json({ error: "request_key required" }, 400);
    const days = Math.min(Math.max(Number(p.expires_in_days) || DEFAULT_DAYS, 1), MAX_DAYS);
    const expires = new Date(Date.now() + days * 86400000).toISOString();

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    let rpc: string, args: Record<string, unknown>;

    if (req.headers.get("x-invites-desk-key") === Deno.env.get("INVITES_DESK_KEY") && Deno.env.get("INVITES_DESK_KEY")) {
      const phone = String(p.phone || "").trim();
      if (!/^\+\d{8,15}$/.test(phone)) return json({ error: "customer phone (E.164) required" }, 400);
      rpc = "invite_issue_by_phone";
      args = { p_phone: phone, p_email: email, p_request_key: requestKey, p_expires: expires };
    } else {
      const authHeader = req.headers.get("Authorization") || "";
      const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error } = await userClient.auth.getUser();
      if (error || !user) return json({ error: "unauthorized" }, 401);
      if (!p.customer_id) return json({ error: "customer_id required" }, 400);
      rpc = "invite_issue";
      args = { p_actor: user.id, p_customer: p.customer_id, p_email: email, p_request_key: requestKey, p_expires: expires };
    }

    const { data, error } = await db.rpc(rpc, args);
    if (error) {
      const msg = String(error.message || "");
      if (msg.includes("allowance exhausted")) return json({ error: "allowance exhausted" }, 409);
      if (msg.includes("idempotency conflict")) return json({ error: "request_key already used with a different email" }, 409);
      if (msg.includes("unknown customer phone")) return json({ error: "unknown customer phone" }, 404);
      if (msg.includes("forbidden") || msg.includes("not admitted")) return json({ error: "forbidden" }, 403);
      return json({ error: msg }, 500);
    }
    const token = data?.token ?? null;
    return json({
      id: data.id,
      already_issued: !!data.already_issued,
      token,
      url: token ? `${URL_BASE}?token=${token}` : null,
      expires_at: expires,
    }, data.already_issued ? 200 : 201);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
