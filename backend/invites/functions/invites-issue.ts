// invites-issue: desk endpoint for the Matt text flow. NOT DEPLOYED yet.
// A customer texts Matt asking to invite a buddy; the desk (concierge today)
// verifies the sender's phone against the bound customer rows and calls this
// with the shared desk key. Issues a phone-bound invitation - no token, link,
// email, or account is created. The buddy simply texts Matt when ready; the
// inbound handler admits them on first contact (see telnyx-inbound.ts).
//
// Auth: x-invites-desk-key shared secret only. There is no customer login path;
// customers never authenticate to anything (text-first product rule).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-invites-desk-key",
};

const DEFAULT_DAYS = 7;  // proposed default; Jake's expiry decision still open
const MAX_DAYS = 30;

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!Deno.env.get("INVITES_DESK_KEY") || req.headers.get("x-invites-desk-key") !== Deno.env.get("INVITES_DESK_KEY")) {
      return json({ error: "unauthorized" }, 401);
    }
    const p = await req.json().catch(() => ({}));
    const customerPhone = String(p.customer_phone || "").trim();
    const buddyPhone = String(p.buddy_phone || "").trim();
    const requestKey = String(p.request_key || "").trim();
    const e164 = /^\+\d{8,15}$/;
    if (!e164.test(customerPhone)) return json({ error: "customer phone (E.164) required" }, 400);
    if (!e164.test(buddyPhone)) return json({ error: "buddy phone (E.164) required" }, 400);
    if (!requestKey) return json({ error: "request_key required" }, 400);
    const days = Math.min(Math.max(Number(p.expires_in_days) || DEFAULT_DAYS, 1), MAX_DAYS);
    const expires = new Date(Date.now() + days * 86400000).toISOString();

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await db.rpc("invite_issue_by_phone", {
      p_customer_phone: customerPhone, p_buddy_phone: buddyPhone, p_request_key: requestKey, p_expires: expires,
    });
    if (error) {
      const msg = String(error.message || "");
      if (msg.includes("allowance exhausted")) return json({ error: "allowance exhausted" }, 409);
      if (msg.includes("phone already invited")) return json({ error: "that phone already has a pending invitation" }, 409);
      if (msg.includes("already admitted")) return json({ error: "that phone is already admitted" }, 409);
      if (msg.includes("phone is a customer")) return json({ error: "that phone belongs to a customer" }, 409);
      if (msg.includes("idempotency conflict")) return json({ error: "request_key already used with a different phone" }, 409);
      if (msg.includes("unknown customer phone")) return json({ error: "unknown customer phone" }, 404);
      return json({ error: msg }, 500);
    }
    // Nothing is sent to the buddy here. The desk decides the contact path
    // (Matt's first text, once SMS sending is authorized and funded).
    return json({ id: data.id, already_issued: !!data.already_issued, expires_at: expires }, data.already_issued ? 200 : 201);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
