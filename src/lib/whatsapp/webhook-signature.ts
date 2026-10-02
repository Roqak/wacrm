// ============================================================
// WhatsApp webhook signature verification
//
// Meta signs the raw request body with the App Secret of the app that
// delivers the webhook, and sends the result in
// `x-hub-signature-256: sha256=<hex>`. Without verification, anyone
// who knows our webhook URL can POST fabricated status updates and
// drift broadcast counts arbitrarily.
//
// Reference:
//   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
//
// The secret of the DELIVERING app. One deployment usually serves one
// app, whose secret is `${META_APP_SECRET}` — but multi-business
// deployments may legitimately connect numbers through other Meta
// apps. Each such row of whatsapp_config carries its own app secret;
// the webhook route collects them and here we accept a signature
// matching ANY of them. Fail closed: if none of the known secrets
// match (or none are configured), the request is rejected.
// ============================================================
import crypto from 'node:crypto'

function matchesSecret(rawBody: string, signatureHeader: string, secret: string): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Verify the HMAC-SHA256 signature against the deployment's Meta App
 * Secret (${META_APP_SECRET}, when configured) and any per-account app
 * secrets collected from `whatsapp_config` by the caller.
 *
 * Returns true only when at least one known secret verifies the exact
 * request bytes.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  extraAppSecrets: readonly string[] = [],
): boolean {
  const secrets: string[] = []
  const envSecret = process.env.META_APP_SECRET
  if (envSecret) secrets.push(envSecret)
  for (const s of extraAppSecrets) {
    // Rows with no secret, or a malformed one, contribute nothing —
    // and must not crash verification.
    if (s) secrets.push(s)
  }
  if (secrets.length === 0) {
    console.error(
      '[webhook] no Meta App Secret is configured (neither META_APP_SECRET nor any account secret) — rejecting request.'
    )
    return false
  }
  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false
  return secrets.some((s) => matchesSecret(rawBody, signatureHeader, s))
}