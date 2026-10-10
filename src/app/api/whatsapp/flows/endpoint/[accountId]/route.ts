import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  decryptFlowRequest,
  encryptFlowResponse,
  FlowDecryptionError,
  isEncryptedFlowRequest,
} from '@/lib/whatsapp/wa-flows/crypto'
import { handleFlowEndpointRequest } from '@/lib/whatsapp/wa-flows/endpoint'

/**
 * WhatsApp Forms data-exchange endpoint — set as a form's
 * `endpoint_uri` on Meta. Unauthenticated by session (Meta calls it);
 * authenticated by Meta's X-Hub-Signature-256 over the raw body, and
 * by the fact that only Meta holds the AES key it wrapped with this
 * account's public key.
 *
 * The account is in the path because the request itself names no
 * account: the private key to decrypt with must be chosen first.
 *
 * Status codes are Meta's contract:
 *   200 text/plain — base64 AES-GCM encrypted JSON answer
 *   421 — could not decrypt (Meta re-fetches the public key, retries)
 *   427 — flow token unknown / expired (the form shows as closed)
 *   432 — signature check failed
 *
 *   https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint
 */

export const maxDuration = 15

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await context.params
  if (!UUID_RE.test(accountId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const rawBody = await request.text()
  const db = supabaseAdmin()

  const { data: config } = await db
    .from('whatsapp_config')
    .select('flows_private_key, meta_app_secret')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!config) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let accountSecret: string | null = null
  if (config.meta_app_secret) {
    try {
      accountSecret = decrypt(config.meta_app_secret)
    } catch {
      console.warn('[wa-flows endpoint] meta_app_secret could not be decrypted')
    }
  }
  const signature = request.headers.get('x-hub-signature-256')
  if (!verifyWebhookSignature(rawBody, signature, accountSecret ? [accountSecret] : [])) {
    return new NextResponse(null, { status: 432 })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!isEncryptedFlowRequest(parsed)) {
    return NextResponse.json({ error: 'Missing encrypted payload' }, { status: 400 })
  }
  if (!config.flows_private_key) {
    console.error(
      '[wa-flows endpoint] no endpoint key for account — generate one in Settings → WhatsApp Forms',
    )
    return new NextResponse(null, { status: 421 })
  }

  let decrypted
  try {
    decrypted = decryptFlowRequest(parsed, decrypt(config.flows_private_key))
  } catch (e) {
    if (e instanceof FlowDecryptionError) {
      console.warn('[wa-flows endpoint] decryption failed:', e.message)
      return new NextResponse(null, { status: 421 })
    }
    // decrypt() of the stored key failed — wrong ENCRYPTION_KEY.
    console.error('[wa-flows endpoint] stored endpoint key unreadable:', e)
    return new NextResponse(null, { status: 421 })
  }

  const outcome = await handleFlowEndpointRequest(db, {
    accountId,
    body: decrypted.body,
  })
  if (outcome.kind === 'token_invalid') {
    return new NextResponse(null, { status: 427 })
  }
  if (outcome.kind === 'error') {
    console.error('[wa-flows endpoint]', outcome.message)
    return new NextResponse(null, { status: 500 })
  }
  return new NextResponse(
    encryptFlowResponse(outcome.response, decrypted.aesKey, decrypted.iv),
    { status: 200, headers: { 'Content-Type': 'text/plain' } },
  )
}
