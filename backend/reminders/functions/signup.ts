// signup: public website signup with phone verification. Two actions:
//   start:  validate + dedupe + rate limit, then text a 6-digit code (Telnyx).
//   verify: check the code, then store phone + exact consent text in signups.
// A signup row is written ONLY after the code checks out. Verification codes
// are stored as hashes, expire in 10 minutes, and allow 5 tries.
// Rate limits (counted from signup_verifications rows): 1 code per phone per
// 60s, 4 per phone per day, 10 starts per IP per day. STOP opt-outs are never
// texted; the caller gets the same neutral answer either way.
// No auth (public form). Notifies the desk email after a verified signup.
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

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toE164(raw: unknown): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length === 10 ? "+1" + digits : digits.length === 11 && digits.startsWith("1") ? "+" + digits : null;
}

async function sendCode(conn: { api_key: string; meta: any }, to: string, code: string) {
  const from = conn.meta?.from_number;
  if (!from) return { ok: false, error: "sms sender number not configured" };
  const payload: Record<string, string> = {
    from,
    to,
    text: `Your BreakerOps code is ${code}. It expires in 10 minutes. Reply STOP to opt out.`,
  };
  if (conn.meta?.messaging_profile_id) payload.messaging_profile_id = conn.meta.messaging_profile_id;
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return { ok: false, error: `telnyx ${res.status}` };
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p = await req.json().catch(() => ({}));
    if (p.hp) return json({ ok: true }); // honeypot: pretend, store nothing
    const action = String(p.action || "start");
    const e164 = toE164(p.phone);
    if (!e164) return json({ error: "Enter a valid US mobile number." }, 400);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const ipHash = await sha256hex("ip:" + ip);

    if (action === "start") {
      // Dedupe: already signed up means no code and no second row.
      const { data: existing, error: exErr } = await supabase.from("signups").select("id").eq("phone", e164).limit(1);
      if (exErr) return json({ error: exErr.message }, 500);
      if (existing && existing.length > 0) return json({ ok: true, already: true });

      // Rate limits, counted from recent verification rows.
      const minuteAgo = new Date(Date.now() - 60_000).toISOString();
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
      const [perMin, perDay, perIp] = await Promise.all([
        supabase.from("signup_verifications").select("id", { count: "exact", head: true }).eq("phone", e164).gte("created_at", minuteAgo),
        supabase.from("signup_verifications").select("id", { count: "exact", head: true }).eq("phone", e164).gte("created_at", dayAgo),
        supabase.from("signup_verifications").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", dayAgo),
      ]);
      if ((perMin.count ?? 0) >= 1) return json({ error: "Code already sent. Give it a minute." }, 429);
      if ((perDay.count ?? 0) >= 4) return json({ error: "Too many tries today. Try again tomorrow." }, 429);
      if ((perIp.count ?? 0) >= 10) return json({ error: "Too many tries today. Try again tomorrow." }, 429);

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const row = {
        phone: e164,
        code_hash: await sha256hex(e164 + ":" + code),
        ip_hash: ipHash,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      };
      const { error: insErr } = await supabase.from("signup_verifications").insert(row);
      if (insErr) return json({ error: insErr.message }, 500);

      // Never text a STOP-opted-out number. Neutral answer either way.
      const { data: oo } = await supabase.from("sms_opt_outs").select("phone").eq("phone", e164).maybeSingle();
      if (!oo) {
        const { data: rows, error: cerr } = await supabase.rpc("get_connection", { p_provider: "telnyx" });
        const conn = rows?.[0];
        if (cerr || !conn?.api_key) return json({ error: "sms provider not configured" }, 500);
        const sent = await sendCode(conn, e164, code);
        if (!sent.ok) return json({ error: "Could not send the code. Try again." }, 502);
      }
      return json({ ok: true }, 200);
    }

    if (action === "verify") {
      const code = String(p.code || "").replace(/\D/g, "");
      if (code.length !== 6) return json({ error: "Enter the 6-digit code." }, 400);
      const { data: rows, error: vErr = null } = await supabase
        .from("signup_verifications")
        .select("id, code_hash, attempts, expires_at, verified_at")
        .eq("phone", e164)
        .order("created_at", { ascending: false })
        .limit(1);
      if (vErr) return json({ error: vErr.message }, 500);
      const v = rows?.[0];
      if (!v || v.verified_at || new Date(v.expires_at).getTime() < Date.now()) {
        return json({ error: "No active code. Tap Sign up again for a new one." }, 400);
      }
      if ((v.attempts ?? 0) >= 5) return json({ error: "Too many wrong tries. Tap Sign up again for a new code." }, 429);
      const guess = await sha256hex(e164 + ":" + code);
      if (guess !== v.code_hash) {
        await supabase.from("signup_verifications").update({ attempts: (v.attempts ?? 0) + 1 }).eq("id", v.id);
        return json({ error: "That code does not match. Try again." }, 400);
      }
      await supabase.from("signup_verifications").update({ verified_at: new Date().toISOString() }).eq("id", v.id);

      // Store the signup only now, and only once (dedupe on race or resubmit).
      const { data: existing } = await supabase.from("signups").select("id").eq("phone", e164).limit(1);
      if (!existing || existing.length === 0) {
        const { error } = await supabase.from("signups").insert({
          phone: e164,
          consent_text: String(p.consent || "").slice(0, 500),
          source: String(p.source || "breakerops.com").slice(0, 100),
        });
        if (error) return json({ error: error.message }, 500);
      }
      // fire-and-forget desk notification; never blocks or fails the signup
      const note = fetch("https://formsubmit.co/ajax/nick@breakerops.com", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Referer: "https://www.breakerops.com/text/" },
        body: JSON.stringify({
          _subject: "New BreakerOps signup (verified)",
          phone: e164,
          source: String(p.source || "breakerops.com"),
          time: new Date().toISOString(),
          _template: "table",
        }),
      }).catch(() => {});
      try { (globalThis as any).EdgeRuntime?.waitUntil?.(note); } catch (_) { /* ignore */ }
      return json({ ok: true }, 201);
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
