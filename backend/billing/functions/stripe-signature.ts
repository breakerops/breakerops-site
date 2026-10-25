// stripe-signature.ts: Stripe webhook signature verification, manual scheme.
// Grounded from official Stripe docs (docs.stripe.com/webhooks.md
// ?verify=verify-manually), Oct 24 2026:
//   - header: "t=<timestamp>,v1=<sig>[,v1=<sig2>][,v0=...]"; ignore non-v1
//   - signed_payload = `${t}.${rawBody}`
//   - expected = hex(HMAC-SHA256(key=endpointSecret, msg=signed_payload))
//   - constant-time compare against EVERY v1; timestamp tolerance guards
//     replay. Default tolerance 300s matches Stripe's own libraries.
// Pure WebCrypto: runs on Deno (edge) and Node >=20 (tests) unchanged.

export const DEFAULT_TOLERANCE_SECONDS = 300;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// constant-time equality for equal-length hex strings (different lengths
// still take the same early false; no content oracle beyond length)
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const x = hexToBytes(a), y = hexToBytes(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function parseStripeSignatureHeader(header: string): { t: string; v1: string[] } {
  const parts = header.split(",");
  let t = "";
  const v1: string[] = [];
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  return { t, v1 };
}

export async function verifyStripeSignature(
  rawBody: string,
  header: string,
  secret: string,
  nowSeconds?: number,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): Promise<{ ok: boolean; reason?: string }> {
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  const { t, v1 } = parseStripeSignatureHeader(header);
  if (!t || v1.length === 0) return { ok: false, reason: "no v1 signature in header" };
  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const expected = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, "0")).join("");
  for (const got of v1) {
    if (timingSafeHexEqual(expected, got)) return { ok: true };
  }
  return { ok: false, reason: "no signatures found matching the expected signature for payload" };
}
