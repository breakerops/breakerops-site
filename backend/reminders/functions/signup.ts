// signup: public website signup. Stores a phone number + the exact consent text
// shown, nothing else. Sends nothing to the customer - texting starts only after
// Telnyx is live and onboarding is confirmed. No auth (public form); honeypot +
// shape checks only. Notifies the desk email (fire-and-forget) so the team can
// relay new signups.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p = await req.json().catch(() => ({}));
    if (p.hp) return json({ ok: true }); // honeypot: pretend, store nothing
    const digits = String(p.phone || "").replace(/\D/g, "");
    const e164 = digits.length === 10 ? "+1" + digits : digits.length === 11 && digits.startsWith("1") ? "+" + digits : null;
    if (!e164) return json({ error: "Enter a valid US mobile number." }, 400);
    if (!p.consent) return json({ error: "missing consent" }, 400);
    const source = String(p.source || "breakerops.com").slice(0, 100);
    const { error } = await supabase.from("signups").insert({
      phone: e164,
      consent_text: String(p.consent).slice(0, 500),
      source,
    });
    if (error) return json({ error: error.message }, 500);
    // fire-and-forget desk notification; never blocks or fails the signup
    const note = fetch("https://formsubmit.co/ajax/nick@breakerops.com", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Referer: "https://www.breakerops.com/text/" },
      body: JSON.stringify({
        _subject: "New BreakerOps signup",
        phone: e164,
        source,
        time: new Date().toISOString(),
        _template: "table",
      }),
    }).catch(() => {});
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(note); } catch (_) { /* ignore */ }
    return json({ ok: true }, 201);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
