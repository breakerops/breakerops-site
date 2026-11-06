// signup: public website signup with phone verification. Two actions:
//   start:  validate + dedupe + rate limit, then text a 6-digit code (Telnyx).
//   verify: check the code, then store the signup with the server-side consent text.
// A signup row is written ONLY after the code checks out. Codes are stored as
// hashes (phone + server-side pepper), expire in 10 minutes, and allow 5 tries.
// A verification row whose text fails to send is deleted so it does not burn
// the caller's rate budget. Responses are neutral: an already-registered
// number is indistinguishable from a fresh one, and errors never leak server
// detail. STOP opt-outs are never texted; the caller gets the same answer.
// Rate limits (counted from signup_verifications rows): 1 code per phone per
// 60s, 4 per phone per day, 10 starts per IP per day, 50 codes per day total.
// start answers every outcome with the same neutral 200 (rate limits and send
// failures are logged, never told), and verify answers registered numbers and
// missing/expired codes with the same wrong-code error, so responses cannot
// reveal whether a number has signed up. A request with no "action" field is
// treated as a legacy homepage and stores the signup like the old function did,
// so a cached page never loses signups during rollout. The pepper is required:
// if SIGNUP_CODE_PEPPER is unset the function refuses to run.
// IP is the platform connecting IP (x-real-ip, else the last X-Forwarded-For
// hop), never the first client-supplied hop. Consent text is a server-side
// constant; the client cannot supply or alter it.
// NOTE: Telnyx 10DLC is not yet registered, so sends may fail until it is.
// Before public launch consider adding Cloudflare Turnstile as a bot layer.
// No auth (public form). Notifies the desk email only when a verified signup
// actually creates a new row.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Response version: lets the homepage tell this function from its predecessor
// and stay backward compatible during rollout.
const V = 2;
const CONSENT_TEXT = "By signing up with your number you agree to receive texts from BreakerOps. Reply STOP to opt out.";
const PEPPER = Deno.env.get("SIGNUP_CODE_PEPPER") || ""; // set with supabase secrets at deploy
const GENERIC_ERR = "Something went wrong. Try again.";
const TOO_MANY = "Too many tries today. Try again tomorrow.";

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

function makeCode(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
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
    if (!PEPPER) {
      // Fail closed: without the server-side pepper, codes would be hashable
      // from the phone number alone.
      console.error("SIGNUP_CODE_PEPPER is not set");
      return json({ error: GENERIC_ERR }, 500);
    }
    if (p.hp) return json({ ok: true, v: V }); // honeypot: pretend, store nothing
    const action = String(p.action || "legacy");
    const e164 = toE164(p.phone);
    if (!e164) return json({ error: "Enter a valid US mobile number.", v: V }, 400);
    const ip =
      req.headers.get("x-real-ip") ||
      (req.headers.get("x-forwarded-for") || "").split(",").pop()?.trim() ||
      "unknown";
    const ipHash = await sha256hex("ip:" + ip);

    if (action === "legacy") {
      // Old or cached homepage: store the signup like the previous function
      // did, so no signup is lost while the new page rolls out.
      const { data: created, error } = await supabase
        .from("signups")
        .upsert(
          { phone: e164, consent_text: CONSENT_TEXT, source: String(p.source || "breakerops.com").slice(0, 100) },
          { onConflict: "phone", ignoreDuplicates: true }
        )
        .select("id");
      if (error) {
        console.error("legacy insert failed", error);
        return json({ error: GENERIC_ERR }, 500);
      }
      if (created && created.length > 0) {
        const note = fetch("https://formsubmit.co/ajax/nick@breakerops.com", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Referer: "https://www.breakerops.com/text/" },
          body: JSON.stringify({
            _subject: "New BreakerOps signup",
            phone: e164,
            source: String(p.source || "breakerops.com"),
            time: new Date().toISOString(),
            _template: "table",
          }),
        }).catch(() => {});
        try { (globalThis as any).EdgeRuntime?.waitUntil?.(note); } catch (_) { /* ignore */ }
      }
      return json({ ok: true }, 201);
    }

    if (action === "start") {
      // Neutral path for already-registered numbers: no code, no new
      // verification row, same response as a fresh start. No enumeration.
      const { data: existing, error: exErr } = await supabase.from("signups").select("id").eq("phone", e164).limit(1);
      if (exErr) {
        console.error("dedupe check failed", exErr);
        return json({ error: GENERIC_ERR, v: V }, 500);
      }
      if (existing && existing.length > 0) return json({ ok: true, v: V });

      // Rate limits, counted from recent verification rows.
      const minuteAgo = new Date(Date.now() - 60_000).toISOString();
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
      const [perMin, perDay, perIp, perAll] = await Promise.all([
        supabase.from("signup_verifications").select("id", { count: "exact", head: true }).eq("phone", e164).gte("created_at", minuteAgo),
        supabase.from("signup_verifications").select("id", { count: "exact", head: true }).eq("phone", e164).gte("created_at", dayAgo),
        supabase.from("signup_verifications").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", dayAgo),
        supabase.from("signup_verifications").select("id", { count: "exact", head: true }).gte("created_at", dayAgo),
      ]);
      if ((perMin.count ?? 0) >= 1) { console.error("rate: phone minute"); return json({ ok: true, v: V }); }
      if ((perDay.count ?? 0) >= 4) { console.error("rate: phone day"); return json({ ok: true, v: V }); }
      if ((perIp.count ?? 0) >= 10) { console.error("rate: ip day"); return json({ ok: true, v: V }); }
      if ((perAll.count ?? 0) >= 50) { console.error("rate: global day"); return json({ ok: true, v: V }); }

      const code = makeCode();
      const row = {
        phone: e164,
        code_hash: await sha256hex(e164 + ":" + PEPPER + ":" + code),
        ip_hash: ipHash,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      };
      const { data: ins, error: insErr } = await supabase.from("signup_verifications").insert(row).select("id").single();
      if (insErr) {
        console.error("verification insert failed", insErr);
        return json({ error: GENERIC_ERR, v: V }, 500);
      }

      // Never text a STOP-opted-out number. Neutral answer either way.
      const { data: oo } = await supabase.from("sms_opt_outs").select("phone").eq("phone", e164).maybeSingle();
      if (!oo) {
        const { data: rows, error: cerr } = await supabase.rpc("get_connection", { p_provider: "telnyx" });
        const conn = rows?.[0];
        if (cerr || !conn?.api_key) {
          console.error("telnyx connection missing", cerr);
          await supabase.from("signup_verifications").delete().eq("id", ins.id);
          return json({ ok: true, v: V });
        }
        const sent = await sendCode(conn, e164, code);
        if (!sent.ok) {
          console.error("telnyx send failed", sent.error);
          await supabase.from("signup_verifications").delete().eq("id", ins.id);
          return json({ ok: true, v: V });
        }
      }
      return json({ ok: true, v: V }, 200);
    }

    if (action === "verify") {
      const code = String(p.code || "").replace(/\D/g, "");
      if (code.length !== 6) return json({ error: "Enter the 6-digit code.", v: V }, 400);
      const { data: rows, error: vErr } = await supabase
        .from("signup_verifications")
        .select("id, code_hash, attempts, expires_at, verified_at")
        .eq("phone", e164)
        .order("created_at", { ascending: false })
        .limit(1);
      if (vErr) {
        console.error("verify lookup failed", vErr);
        return json({ error: GENERIC_ERR, v: V }, 500);
      }
      const v = rows?.[0];
      // Same answer for a registered number, no code, an expired code, or a
      // used code: indistinguishable from a wrong guess.
      if (!v || v.verified_at || new Date(v.expires_at).getTime() < Date.now()) {
        return json({ error: "That code does not match. Try again.", v: V }, 400);
      }
      if ((v.attempts ?? 0) >= 5) {
        return json({ error: "Too many wrong tries. Tap Sign up again for a new code.", v: V }, 429);
      }
      const guess = await sha256hex(e164 + ":" + PEPPER + ":" + code);
      if (guess !== v.code_hash) {
        await supabase.from("signup_verifications").update({ attempts: (v.attempts ?? 0) + 1 }).eq("id", v.id);
        return json({ error: "That code does not match. Try again.", v: V }, 400);
      }
      await supabase.from("signup_verifications").update({ verified_at: new Date().toISOString() }).eq("id", v.id);

      // Store the signup only now. The unique index on signups.phone plus
      // ON CONFLICT DO NOTHING keeps races and resubmits from making
      // duplicate rows; the desk email fires only when a row was created.
      const { data: created, error } = await supabase
        .from("signups")
        .upsert(
          { phone: e164, consent_text: CONSENT_TEXT, source: String(p.source || "breakerops.com").slice(0, 100) },
          { onConflict: "phone", ignoreDuplicates: true }
        )
        .select("id");
      if (error) {
        console.error("signup insert failed", error);
        return json({ error: GENERIC_ERR, v: V }, 500);
      }
      if (created && created.length > 0) {
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
      }
      return json({ ok: true, v: V }, 201);
    }

    return json({ error: "unknown action", v: V }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: GENERIC_ERR }, 500);
  }
});
