// invites-start: begins invitee account creation for a valid link. NOT DEPLOYED yet.
//
// Public signup is disabled, so the invitee's account is created here by email
// challenge. SENDING EMAIL IS NOT AUTHORIZED: unless INVITES_EMAIL_ENABLED=true
// this returns 503 and sends nothing. When Jake authorizes email delivery, the
// step uses admin.inviteUserByEmail, which sends the recipient a confirmation
// link; redeem then enforces that the verified email matches the invitation.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const URL_BASE = Deno.env.get("INVITE_URL_BASE") || "https://www.breakerops.com/join/";

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p = await req.json().catch(() => ({}));
    const token = String(p.token || "").trim();
    if (!token) return json({ error: "token required" }, 400);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: peek, error } = await db.rpc("invite_peek", { p_token: token });
    if (error) return json({ error: String(error.message || error) }, 500);
    if (!peek?.valid) return json({ error: `link not usable: ${peek?.reason || "unknown"}` }, 410);

    if (Deno.env.get("INVITES_EMAIL_ENABLED") !== "true") {
      return json({ error: "email delivery not enabled" }, 503);
    }
    const { error: inviteError } = await db.auth.admin.inviteUserByEmail(peek.intended_email, {
      redirectTo: `${URL_BASE}?token=${token}`,
    });
    if (inviteError) return json({ error: String(inviteError.message || inviteError) }, 500);
    return json({ ok: true, sent_to: peek.intended_email });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
