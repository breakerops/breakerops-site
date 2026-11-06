// page-view: anonymous, privacy-friendly visit counter for breakerops.com.
// Invisible: no cookies, no banner, no client storage. Stores date, page and
// referrer only, plus a daily-rotating HMAC hash of IP+user-agent+date so
// per-day unique visitors can be counted. The raw IP is never stored.
// Public endpoint (the counter runs before any login); honeypot + shape
// checks only, same pattern as signup. Notifies no one.
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

async function visitorHash(day: string, ip: string, ua: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("PAGE_VIEW_SALT")!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${day}|${ip}|${ua}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const p = await req.json().catch(() => ({}));
    if (p.hp) return json({ ok: true }); // honeypot: pretend, store nothing
    const page = String(p.page || "");
    if (!page.startsWith("/") || page.length > 100 || page.includes("..")) return json({ error: "bad page" }, 400);
    const referrer = String(p.referrer || "").slice(0, 200) || null;
    const day = new Date().toISOString().slice(0, 10);
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    const ua = (req.headers.get("user-agent") || "").slice(0, 300);
    const { error } = await supabase.from("page_views").insert({
      viewed_on: day,
      page,
      referrer,
      visitor_hash: await visitorHash(day, ip, ua),
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true }, 201);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
