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

// One reply envelope, no application-level SMS fan-out. Preserve all facts:
// if it will exceed two SMS segments, reject for rewriting; never truncate.
function mergeReply(value: any): string {
  if (Array.isArray(value)) return value.map(mergeReply).filter(Boolean).join(" ");
  if (value && typeof value === "object") return mergeReply(value.text ?? value.content ?? value.messages ?? "");
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function fitsReply(text: string): boolean {
  const gsm = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const ext = "^{}\\[~]|€";
  let units = 0;
  for (const char of text) {
    if (gsm.includes(char)) units++;
    else if (ext.includes(char)) units += 2;
    else return text.length <= 134; // 2 concatenated UCS-2 segments
  }
  return units <= 306; // 2 concatenated GSM-7 segments
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
    const messages = [{ role: "system", content: [
      "You are BreakerOps. Reduce the customer's upkeep. Reply with ONE concise text, never a burst. Use at most two SMS segments only when necessary (306 GSM-7 characters or 134 Unicode UTF-16 units). Prefer short plain ASCII. No filler, repeated acknowledgements, or separate sign-offs. Preserve names, dates, amounts and required safety/consent wording. Return only the reply text, never an array of messages. Brief: Today: <key items or day link>. Reminder: <task> - <time if provided>. Do not invent missing details.",
      p.system || ""
    ].join("\n") }];
    messages.push({ role: "user", content: p.prompt });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: m.model,
          messages,
          max_tokens: Math.min(Number(p.max_tokens) || 120, 160),
          ...(p.temperature != null ? { temperature: p.temperature } : {}),
        }),
      });
    } catch (e) {
      return json({ error: `provider unreachable: ${String(e)}`, active: m.name }, 502);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: `provider ${res.status}: ${JSON.stringify(j).slice(0, 300)}`, active: m.name }, 502);
    const text = mergeReply(j?.choices?.[0]?.message?.content ?? "");
    if (j?.choices?.[0]?.finish_reason === "length" || !text || !fitsReply(text)) {
      return json({ error: "reply_needs_shortening", detail: "Rewrite as one concise reply, at most two SMS segments; nothing sent.", active: m.name }, 422);
    }
    return json({
      text,
      messages: [text],
      message_count: 1,
      provider: m.name,
      model: m.model,
      usage: j?.usage ?? null,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
