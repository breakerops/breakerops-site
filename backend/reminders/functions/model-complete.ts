// model-complete: the swappable model adapter. One endpoint for product-side text
// generation; which provider answers is data, not code (model_providers.active row).
// - kind 'manual' (instinct): no server-side call exists; returns 409 so callers
//   keep using the concierge path. Nothing breaks when no key is saved.
// - kind 'openai_compatible': POST {endpoint}/chat/completions with the key saved
//   in private.connections under the provider's name (entered at /admin).
// Secured with the shared x-reminders-key, same as the reminder pipeline.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHARED_KEY = Deno.env.get("REMINDERS_KEY") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { global: { headers: { "x-reminders-key": SHARED_KEY } } }
);

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (!SHARED_KEY || req.headers.get("x-reminders-key") !== SHARED_KEY) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const p = await req.json().catch(() => ({}));
    if (!p.prompt) return json({ error: "missing prompt" }, 400);

    const { data: active } = await supabase.rpc("get_active_model");
    const m = active?.[0];
    if (!m) return json({ error: "no active model provider" }, 500);
    if (m.kind !== "openai_compatible") {
      return json({ error: "active provider is concierge-style, no server-side endpoint", active: m.name }, 409);
    }

    const { data: rows } = await supabase.rpc("get_connection", { p_provider: m.name });
    const key = rows?.[0]?.api_key;
    if (!key) return json({ error: `no API key saved for provider '${m.name}'`, active: m.name }, 409);

    const base = (m.endpoint || "").replace(/\/+$/, "");
    const url = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
    const messages = [];
    if (p.system) messages.push({ role: "system", content: p.system });
    messages.push({ role: "user", content: p.prompt });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: m.model,
          messages,
          max_tokens: p.max_tokens ?? 800,
          ...(p.temperature != null ? { temperature: p.temperature } : {}),
        }),
      });
    } catch (e) {
      return json({ error: `provider unreachable: ${String(e)}`, active: m.name }, 502);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: `provider ${res.status}: ${JSON.stringify(j).slice(0, 300)}`, active: m.name }, 502);
    return json({
      text: j?.choices?.[0]?.message?.content ?? "",
      provider: m.name,
      model: m.model,
      usage: j?.usage ?? null,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
