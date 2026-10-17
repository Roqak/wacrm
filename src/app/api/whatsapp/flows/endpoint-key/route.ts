import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { getBusinessPublicKey, setBusinessPublicKey } from '@/lib/whatsapp/wa-flows/api'
import { generateFlowKeyPair } from '@/lib/whatsapp/wa-flows/crypto'
import {
  FlowLifecycleError,
  loadFlowConfig,
} from '@/lib/whatsapp/wa-flows/lifecycle'
import { flowErrorResponse } from '@/lib/whatsapp/wa-flows/http'

/**
 * The account's data-exchange encryption key.
 *
 * GET  — whether a key is set up, plus Meta's view of it (the signature
 *        status Meta reports for the registered public key). Any member.
 * POST — generate a fresh RSA-2048 keypair, register the public half
 *        with Meta for this phone number, and store the private half
 *        encrypted. Rotating invalidates the old key at once. Admin+.
 */

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('flows_public_key, flows_key_uploaded_at')
      .eq('account_id', accountId)
      .maybeSingle()
    let metaStatus: string | null = null
    let metaMatches: boolean | null = null
    if (config?.flows_public_key) {
      try {
        const { phoneNumberId, accessToken } = await loadFlowConfig(supabase, accountId)
        const meta = await getBusinessPublicKey({ phoneNumberId, accessToken })
        metaStatus = meta.signature_status
        metaMatches =
          meta.business_public_key !== null &&
          meta.business_public_key.trim() === config.flows_public_key.trim()
      } catch {
        // Meta unreachable — report what we know locally.
      }
    }
    return NextResponse.json({
      configured: Boolean(config?.flows_public_key),
      public_key: config?.flows_public_key ?? null,
      uploaded_at: config?.flows_key_uploaded_at ?? null,
      meta_signature_status: metaStatus,
      meta_key_matches: metaMatches,
      endpoint_path: `/api/whatsapp/flows/endpoint/${accountId}`,
    })
  } catch (err) {
    return flowErrorResponse(err, 'load endpoint key')
  }
}

export async function POST() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { phoneNumberId, accessToken } = await loadFlowConfig(supabase, accountId)
    const { publicKeyPem, privateKeyPem } = generateFlowKeyPair()
    try {
      await setBusinessPublicKey({ phoneNumberId, accessToken, publicKeyPem })
    } catch (e) {
      throw new FlowLifecycleError(
        e instanceof Error ? e.message : 'Meta rejected the public key.',
        502,
      )
    }
    const uploadedAt = new Date().toISOString()
    const { error } = await supabase
      .from('whatsapp_config')
      .update({
        flows_public_key: publicKeyPem,
        flows_private_key: encrypt(privateKeyPem),
        flows_key_uploaded_at: uploadedAt,
      })
      .eq('account_id', accountId)
    if (error) {
      throw new FlowLifecycleError(
        `Meta has the new public key but saving the private key failed: ${error.message}. Generate a new key to recover.`,
        500,
      )
    }
    return NextResponse.json({
      configured: true,
      public_key: publicKeyPem,
      uploaded_at: uploadedAt,
      endpoint_path: `/api/whatsapp/flows/endpoint/${accountId}`,
    })
  } catch (err) {
    return flowErrorResponse(err, 'generate endpoint key')
  }
}
