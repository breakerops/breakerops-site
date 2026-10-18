// reminders-write: the product-owned write path for reminders.
// Any conversation backend (Instinct today, another model later) calls this
// with a structured request. The model never writes to the database directly.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHARED_KEY = Deno.env.get("REMINDERS_KEY") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

function bad(reason: string, status = 400) {
  return Response.json({ error: reason }, { status });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return bad("POST only", 405);
  if (!SHARED_KEY || req.headers.get("x-reminders-key") !== SHARED_KEY) {
    return bad("unauthorized", 401);
  }

  let r: Record<string, unknown>;
  try { r = await req.json(); } catch { return bad("invalid JSON"); }

  const { business_id, recipient_channel, recipient, body, send_at, idempotency_key, created_by } = r;

  // Conversation rules live here, not in the model: absolute time, known shape, no guessing.
  if (typeof business_id !== "string" || !business_id) return bad("business_id required");
  if (recipient_channel !== "sms" && recipient_channel !== "email" && recipient_channel !== "log")
    return bad("recipient_channel must be sms, email, or log");
  if (typeof recipient !== "string" || !recipient.trim()) return bad("recipient required");
  if (typeof body !== "string" || !body.trim()) return bad("body required");
  if (typeof send_at !== "string" || Number.isNaN(Date.parse(send_at)))
    return bad("send_at must be an absolute ISO timestamp with offset");
  if (typeof idempotency_key !== "string" || !idempotency_key.trim())
    return bad("idempotency_key required");
  if (typeof created_by !== "string" || !created_by.trim()) return bad("created_by required");

  // Idempotent: a repeated request returns the existing row, never a second send.
  const { data, error } = await supabase
    .from("reminders")
    .upsert(
      { business_id, recipient_channel, recipient: recipient.trim(), body: body.trim(),
        send_at, idempotency_key: idempotency_key.trim(), created_by },
      { onConflict: "business_id,idempotency_key", ignoreDuplicates: true }
    )
    .select()
    .single();

  if (error) return bad(error.message, 500);
  return Response.json({ reminder: data }, { status: 201 });
});
