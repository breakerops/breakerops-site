// telnyx-inbound: inbound SMS from the BreakerOps number. NOT DEPLOYED yet.
// This is the missing inbound half of the Matt conversation path (the deployed
// telnyx-webhook only handles delivery receipts).
//
// SENDER IDENTITY IS NOT TRUSTED UNTIL THE WEBHOOK IS SIGNATURE-VERIFIED.
// SMS sender numbers can be spoofed; admission, routing, and any business
// action depend on the from-phone only after the Telnyx ed25519 signature
// checks out. When TELNYX_WEBHOOK_PUBLIC_KEY is unset this handler refuses
// to admit or route (fails closed) - there is no "trust the number anyway" mode.
//
// Flow per inbound text (after verification + replay check):
//   1. Normalize the sender phone.
//   2. Claim the provider event id in inbound_events (durable state machine).
//   3. invite_redeem_on_inbound: admit a phone holding a valid invitation
//      (creates their separate business), recognize an admitted phone, or
//      return 'none' for the public lead path.
//   4. Route by status. ALL outbound replies are gated: unless
//      TELNYX_SEND_ENABLED=true, nothing is sent. No SMS spend, no prospect
//      contact without authority.
//
// Claim state machine (inbound_events.status):
//   processing - claimed, side effects not yet durable. A crash here is
//     recovered by stale-claim reclaim (>2 min); DB mutations are idempotent.
//   db_done    - opt-out/opt-in mutation verified durable; the confirmation
//     text is persisted in detail BEFORE any send attempt. A definitive
//     client-side rejection (provider HTTP 4xx) leaves the claim here so a
//     provider redelivery retries ONLY the send - never the DB mutation.
//   sending    - a provider attempt is in flight (or crashed mid-attempt).
//     Entered ONLY via an atomic conditional update (db_done -> sending that
//     must affect exactly one row), so two concurrent workers can never both
//     send. Recovery CANNOT distinguish "request never left" from "accepted
//     then response lost", so a stale sending claim resolves to uncertain,
//     never to a blind retry.
//   done       - every side effect completed (or send disabled by gate).
//     A 2xx means the provider ACCEPTED the message, not that it delivered;
//     the provider message id is captured in detail for reconciliation.
//   uncertain  - the provider outcome is UNKNOWN (no HTTP response, provider
//     5xx, proxy/timeout, or a crash while sending). Held for desk
//     reconciliation; a replay is acknowledged WITHOUT resending.
//     Never blind-retry uncertain.
// Every claim write checks both the error and the affected-row count; a
// claim write that fails before the send blocks the send (no durable send
// intent, no send).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Telnyx signs `${timestamp}|${rawBody}` with ed25519; verify with the account's
// public key (owner pastes it into this secret when the account goes live).
// Untested against a live account until then - treat first live test as verification.
async function verifyTelnyx(req: Request, rawBody: string): Promise<boolean> {
  const b64 = Deno.env.get("TELNYX_WEBHOOK_PUBLIC_KEY");
  if (!b64) return false;
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts = req.headers.get("telnyx-timestamp");
  if (!sig || !ts) return false;
  // replay window: reject events older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
      { name: "Ed25519" }, false, ["verify"],
    );
    const data = new TextEncoder().encode(`${ts}|${rawBody}`);
    const signature = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data);
  } catch {
    return false;
  }
}

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
}

function normalizePhone(raw: string): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (/^\+\d{8,15}$/.test(raw)) return raw;
  return null;
}

// Three-way send outcome. Only "failed" (an HTTP response came back) may be
// retried on redelivery. "uncertain" means no response: the provider may have
// accepted the message, so an automatic retry could duplicate the text.
// "sent" means the provider ACCEPTED the message (2xx) - not delivered;
// the provider message id is captured for reconciliation. Only a 4xx is a
// definitive rejection safe to retry: it proves the provider refused the
// request. A 5xx, timeout or proxy error may still have queued the message,
// so those are uncertain, exactly like a lost connection.
type SendOutcome =
  | { outcome: "sent"; providerId?: string }
  | { outcome: "failed"; error: string }
  | { outcome: "uncertain"; error: string };

async function sendSms(to: string, text: string): Promise<SendOutcome> {
  const { data: rows, error: cerr } = await supabase.rpc("get_connection", { p_provider: "telnyx" });
  const conn = rows?.[0];
  if (cerr || !conn?.api_key || !conn?.meta?.from_number) return { outcome: "failed", error: "sms provider not configured" };
  try {
    const payload: Record<string, string> = { from: conn.meta.from_number, to, text };
    if (conn.meta?.messaging_profile_id) payload.messaging_profile_id = conn.meta.messaging_profile_id;
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      let providerId: string | undefined;
      try { providerId = (await res.json())?.data?.id; } catch { /* body optional */ }
      return { outcome: "sent", providerId };
    }
    if (res.status >= 400 && res.status < 500) return { outcome: "failed", error: `telnyx ${res.status} (definitive rejection)` };
    return { outcome: "uncertain", error: `telnyx ${res.status} (server-side; may have queued)` };
  } catch (e) {
    return { outcome: "uncertain", error: String(e) };
  }
}

Deno.serve(async (req) => {
  const rawBody = await req.text();
  if (!(await verifyTelnyx(req, rawBody))) {
    // fail closed: no admission, no routing, no desk note leak about contents
    return json({ error: "unverified" }, 401);
  }
  try {
    const evt = JSON.parse(rawBody || "{}");
    const data = evt?.data ?? {};
    if (data.event_type !== "message.received") {
      return json({ ok: true, ignored: data.event_type ?? null });
    }
    const p = data.payload ?? {};
    const from = normalizePhone(p?.from?.phone_number ?? p?.from ?? "");
    const text = String(p?.text ?? "").slice(0, 1000);
    if (!from) return json({ error: "no sender" }, 400);

    // Idempotency: the 5-minute timestamp window is replay rejection, not
    // dedupe - a valid replay inside the window must not repeat side effects.
    // Claims are NEVER deleted: a durable status row is the single record of
    // what happened, so crashes and replays resolve to one outcome. Fail
    // closed when the dedupe store is unavailable: no side effects without it.
    const eventId = String(data.id ?? p?.id ?? "");
    if (!eventId) return json({ error: "no event id" }, 400);

    // Checked claim write: returns true only when exactly this event's row
    // was updated. A failed claim write before a send BLOCKS the send -
    // without durable send intent there is no safe recovery.
    const setClaim = async (status: string, detail: string): Promise<boolean> => {
      const { data, error } = await supabase.from("inbound_events")
        .update({ status, detail, updated_at: new Date().toISOString() })
        .eq("event_id", eventId)
        .select("event_id");
      return !error && (data?.length ?? 0) === 1;
    };
    // Atomic ownership transition: succeeds only for the one worker whose
    // conditional update actually flipped the row from the expected state.
    const takeClaim = async (fromStatus: string, toStatus: string, detail?: string): Promise<boolean> => {
      const payload: Record<string, string> = { status: toStatus, updated_at: new Date().toISOString() };
      if (detail !== undefined) payload.detail = detail;
      const { data, error } = await supabase.from("inbound_events")
        .update(payload)
        .eq("event_id", eventId).eq("status", fromStatus)
        .select("event_id");
      return !error && (data?.length ?? 0) === 1;
    };

    let resumeReply: string | null = null;
    const { error: derr } = await supabase.from("inbound_events").insert(
      { event_id: eventId, event_type: String(data.event_type ?? ""), from_phone: from, status: "processing" }
    );
    if (derr) {
      if ((derr as any).code !== "23505") return json({ error: "dedupe store unavailable" }, 500);
      const { data: ex, error: exErr } = await supabase.from("inbound_events")
        .select("status, detail, updated_at").eq("event_id", eventId).maybeSingle();
      if (exErr || !ex) return json({ error: "dedupe state unreadable" }, 500);
      if (ex.status === "done") return json({ ok: true, deduped: true });
      if (ex.status === "uncertain") {
        // A previous attempt may have reached the provider. Acknowledge the
        // replay WITHOUT resending; the desk reconciles from the claim row.
        return json({ ok: true, deduped: true, held: "uncertain provider outcome; no automatic resend" });
      }
      if (ex.status === "db_done") {
        resumeReply = ex.detail; // retry ONLY the persisted confirmation text
      } else {
        // 'processing' or 'sending': another worker owns it, or one crashed.
        const stale = Date.now() - Date.parse(ex.updated_at) > 120_000;
        if (!stale) {
          // Non-2xx so the provider retries later - never ack a concurrent
          // duplicate and mask a first-worker failure.
          return json({ error: "event in progress" }, 409);
        }
        if (ex.status === "sending") {
          // Crash mid-attempt: acceptance is unknown. Resolve to uncertain
          // and hold - do NOT resume the send.
          await setClaim("uncertain", "crashed during provider attempt; outcome unknown, held for reconciliation. intended: " + ex.detail);
          return json({ ok: true, deduped: true, held: "uncertain provider outcome; no automatic resend" });
        }
        // Atomic reclaim: only the worker whose update flips the stale row
        // proceeds; the loser backs off for the provider's next retry.
        if (!(await takeClaim("processing", "processing"))) {
          return json({ error: "event in progress" }, 409);
        }
        // fall through: DB mutations below are idempotent, safe to re-run
      }
    }

    const gated = Deno.env.get("TELNYX_SEND_ENABLED") !== "true";

    // Shared confirmation flow for STOP/START/HELP: mutate + verify durable,
    // persist the intended reply, then send once per outcome rules.
    const completeWithConfirmation = async (
      statusLabel: string,
      reply: string,
      dbStep: () => Promise<string | null>,
    ): Promise<Response> => {
      let effective = reply;
      if (resumeReply === null) {
        const stepErr = await dbStep();
        if (stepErr) {
          // No external side effect attempted; claim stays 'processing' and a
          // provider redelivery (or stale reclaim) retries the whole event.
          return json({ error: stepErr + "; not confirmed" }, 500);
        }
        // Durable send intent BEFORE sending; if it cannot be persisted,
        // there is no safe recovery from a crash, so do not send.
        if (!(await setClaim("db_done", reply))) {
          return json({ error: "could not persist send intent; not sent" }, 500);
        }
      } else {
        effective = resumeReply;
      }
      if (gated) {
        await setClaim("done", "send disabled: " + effective);
        return json({ ok: true, status: statusLabel, send: "disabled" });
      }
      // Atomic pre-send ownership: exactly one worker flips db_done ->
      // sending. A concurrent replay/worker that loses the race backs off
      // for the provider's retry instead of double-sending.
      if (!(await takeClaim("db_done", "sending", effective))) {
        return json({ error: "event in progress" }, 409);
      }
      const sent = await sendSms(from, effective);
      if (sent.outcome === "sent") {
        // 2xx = accepted, not delivered; keep the provider id for the desk.
        await setClaim("done", effective + (sent.providerId ? " [provider " + sent.providerId + "]" : ""));
        return json({ ok: true, status: statusLabel, send: "enabled", reply_sent: true, provider_id: sent.providerId ?? null });
      }
      if (sent.outcome === "failed") {
        // Definitive 4xx rejection: return the claim to db_done so the
        // provider's redelivery retries ONLY the send.
        await takeClaim("sending", "db_done", effective);
        return json({ error: "confirmation definitively rejected; will retry on redelivery: " + sent.error }, 500);
      }
      await setClaim("uncertain", "provider outcome unknown after request; held for reconciliation, no automatic resend. intended: " + effective);
      return json({ error: "provider outcome unknown; held for reconciliation, no automatic resend" }, 500);
    };

    // STOP/START/HELP per the published sms-terms. These short-circuit all
    // other routing; the confirmation text is the "one final text" the terms
    // promise. Opt-out rows are honored by reminders-send before every send.
    const kw = text.trim().toUpperCase().replace(/\s+/g, " ");
    if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(kw)) {
      return await completeWithConfirmation(
        "opted_out",
        "BreakerOps: You are unsubscribed and will receive no more texts. Reply START to resubscribe.",
        async () => {
          const { error: oerr } = await supabase.from("sms_opt_outs").upsert(
            { phone: from, opted_out_at: new Date().toISOString(), keyword: kw },
            { onConflict: "phone" }
          );
          if (oerr) return "opt-out store failed";
          // Confirm only what is durable: re-read before the "one final text".
          const { data: chk, error: cerr } = await supabase.from("sms_opt_outs").select("phone").eq("phone", from).maybeSingle();
          if (cerr || !chk) return "opt-out state not durable";
          return null;
        },
      );
    }
    if (["START", "UNSTOP"].includes(kw)) {
      return await completeWithConfirmation(
        "opted_in",
        "BreakerOps: You are resubscribed to texts. Reply STOP to opt out, HELP for help. Msg&data rates may apply.",
        async () => {
          const { error: derr2 } = await supabase.from("sms_opt_outs").delete().eq("phone", from);
          if (derr2) return "opt-in store failed";
          const { data: still, error: serr } = await supabase.from("sms_opt_outs").select("phone").eq("phone", from).maybeSingle();
          if (serr || still) return "opt-in state not durable";
          return null;
        },
      );
    }
    if (kw === "HELP") {
      return await completeWithConfirmation(
        "help",
        "BreakerOps: morning day text + reminders you ask for. Reply STOP to opt out. Msg&data rates may apply. Help: matt@breakerops.com",
        async () => null,
      );
    }

    const { data: admission, error } = await supabase.rpc("invite_redeem_on_inbound", { p_phone: from });
    if (error) {
      // activation disabled or a data problem: log for the desk, never reply blindly
      return json({ ok: true, status: "unrouted", reason: String(error.message || error), send: "disabled" });
    }
    const status = admission?.status ?? "none";
    // STUB: no durable routing/capture exists yet. Nothing below acknowledges
    // customer capture, stores the message, or truncates it into a record -
    // the desk watches function logs until the Matt handler owns routing.
    //  admitted -> welcome text from Matt + notify the inviter (both gated)
    //  member   -> Matt conversation (desk today)
    //  none     -> existing public lead path (desk notification)
    await setClaim("done", "stub-no-durable-capture");
    return json({ ok: true, status, routing: "stub-no-durable-capture", captured: false, send: gated ? "disabled" : "enabled" });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
