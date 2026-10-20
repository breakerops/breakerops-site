// invites-redeem: invitee accepts a referral link and gets a SEPARATE business
// (never the inviter's workspace). NOT DEPLOYED yet - the SQL activation gate
// (invite_stage.settings.activation_enabled = false) rejects every call until
// Jake settles activation policy.
//
// Requires a bearer JWT for an account whose verified email matches the link's
// intended recipient. Public signup is disabled, so accounts arrive via
// invites-start (email challenge) only.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: "unauthorized" }, 401);

    const p = await req.json().catch(() => ({}));
    const token = String(p.token || "").trim();
    const name = String(p.business_name || "").trim();
    if (!token) return json({ error: "token required" }, 400);
    if (!name) return json({ error: "business name required" }, 400);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await db.rpc("invite_redeem", { p_actor: user.id, p_token: token, p_business_name: name });
    if (error) {
      const msg = String(error.message || "");
      if (msg.includes("activation disabled")) return json({ error: "invitations are not open yet" }, 403);
      if (msg.includes("recipient mismatch")) return json({ error: "this link was issued to a different email" }, 403);
      if (msg.includes("verified identity required")) return json({ error: "verify your email first" }, 403);
      if (msg.includes("invalid invitation")) return json({ error: "link expired, revoked, or already used" }, 410);
      return json({ error: msg }, 500);
    }
    return json({ business_id: data }, 201);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
