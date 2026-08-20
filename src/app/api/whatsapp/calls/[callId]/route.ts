// ============================================================
// /api/whatsapp/calls/[callId]
//
//   POST — advance a ringing/live call. One route, one `action` field,
//          because every action shares the same authorization, the same
//          config lookup and the same Meta error mapping; four routes
//          would be four copies of that.
//
//     answer     { sdp_answer }  agent picks up → Meta pre_accept
//     connected  { sdp_answer }  peer connection is up → Meta accept
//     decline                    agent rejects a ringing call
//     hangup                     either side ends a live call
//
// Authorization is deliberately not just "is an admin": a call belongs
// to a conversation, and migration 040 lets an account restrict a member
// to their own threads. Someone who cannot see the conversation must not
// be able to answer its calls, so this checks the caller can read the
// call row *under their own RLS* before doing anything with the
// service-role client.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  acceptCall,
  preAcceptCall,
  rejectCall,
  terminateCall,
  CallActionError,
} from '@/lib/whatsapp/calls'
import { supabaseAdmin } from '@/lib/whatsapp/admin-client'

type Action = 'answer' | 'connected' | 'decline' | 'hangup'

const ACTIONS: readonly Action[] = ['answer', 'connected', 'decline', 'hangup']

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ callId: string }> },
) {
  try {
    // 'agent' rather than 'admin': answering the phone is the job, not
    // a settings change. Viewers are read-only and cannot pick up.
    const { userId, accountId } = await requireRole('agent')

    const limit = checkRateLimit(`call:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { callId } = await params

    const body = (await request.json().catch(() => null)) as {
      action?: unknown
      sdp_answer?: unknown
    } | null

    const action = body?.action
    if (typeof action !== 'string' || !ACTIONS.includes(action as Action)) {
      return bad(`action must be one of ${ACTIONS.join(', ')}`)
    }

    const needsSdp = action === 'answer' || action === 'connected'
    const sdpAnswer =
      typeof body?.sdp_answer === 'string' ? body.sdp_answer.trim() : ''
    if (needsSdp && !sdpAnswer) {
      return bad(`sdp_answer is required for "${action}"`)
    }

    // Read the call through the caller's OWN client, so the RLS policy
    // from migration 042 (which defers to conversation visibility) is
    // what decides whether this call is theirs to touch. Everything
    // after this point uses the service-role client, and skipping this
    // step would hand any agent control of every call in the account.
    const userClient = await createClient()
    const { data: call, error: callError } = await userClient
      .from('calls')
      .select('id, wa_call_id, status, account_id, answered_by')
      .eq('id', callId)
      .maybeSingle()

    if (callError) {
      console.error('[calls route] lookup error:', callError)
      return bad('Failed to load the call', 500)
    }
    // Not-found and not-visible are the same 404 on purpose: telling a
    // restricted agent that a call exists but isn't theirs leaks the
    // customer contact that migration 040 exists to hide.
    if (!call || call.account_id !== accountId) {
      return bad('Call not found', 404)
    }

    if (['completed', 'missed', 'declined', 'failed'].includes(call.status)) {
      return bad('This call has already ended', 409)
    }

    const admin = supabaseAdmin()

    const { data: config } = await admin
      .from('whatsapp_config')
      .select('phone_number_id, access_token, calling_enabled')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config?.phone_number_id || !config.access_token) {
      return bad('WhatsApp is not configured for this account', 409)
    }
    if (!config.calling_enabled) {
      return bad('Calling is not enabled for this number', 409)
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return bad('Stored WhatsApp token could not be decrypted', 500)
    }

    const metaArgs = {
      phoneNumberId: config.phone_number_id,
      accessToken,
      callId: call.wa_call_id,
    }

    try {
      switch (action) {
        case 'answer':
          await preAcceptCall({ ...metaArgs, sdpAnswer })
          break
        case 'connected':
          await acceptCall({ ...metaArgs, sdpAnswer })
          break
        case 'decline':
          await rejectCall(metaArgs)
          break
        case 'hangup':
          await terminateCall(metaArgs)
          break
      }
    } catch (err) {
      if (err instanceof CallActionError) {
        // Record the failure rather than leaving the row ringing
        // forever — a call stuck in 'ringing' would keep every agent's
        // browser showing an incoming call that no longer exists.
        await admin
          .from('calls')
          .update({
            status: 'failed',
            ended_at: new Date().toISOString(),
            end_reason: err.message,
            offer_sdp: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', call.id)
        return bad(err.message, 502)
      }
      throw err
    }

    // Persist the new state. The webhook's `terminate` event fills in
    // duration and the final status for calls that end normally; these
    // writes are the parts only we know about.
    const now = new Date().toISOString()
    const patch: Record<string, unknown> = { updated_at: now }
    switch (action) {
      case 'answer':
        patch.status = 'connecting'
        // Claim the call for whoever picked up, so other agents' UIs
        // stop ringing.
        patch.answered_by = userId
        break
      case 'connected':
        patch.status = 'connected'
        patch.connected_at = now
        // The offer is spent once media is up.
        patch.offer_sdp = null
        break
      case 'decline':
        patch.status = 'declined'
        patch.ended_at = now
        patch.offer_sdp = null
        break
      case 'hangup':
        // Leave the final status to the terminate webhook when the call
        // had actually connected — it knows the duration. Only mark it
        // here if it never got that far.
        patch.status = call.status === 'connected' ? 'completed' : 'missed'
        patch.ended_at = now
        patch.offer_sdp = null
        break
    }

    const { error: updateError } = await admin
      .from('calls')
      .update(patch)
      .eq('id', call.id)

    if (updateError) {
      console.error('[calls route] state update failed:', updateError)
      // Meta already acted, so the call really is in the new state —
      // reporting an error would make the UI disagree with reality.
      // Log and move on.
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
