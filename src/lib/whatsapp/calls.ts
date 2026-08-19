/**
 * Meta WhatsApp Cloud API — call actions.
 *
 * Follows the named-parameter convention the rest of `meta-api.ts` uses,
 * for the reason documented there: positional `(phoneNumberId,
 * accessToken)` pairs got swapped four separate times.
 *
 * ============================================================
 * How a call gets connected
 * ============================================================
 *
 * There is no media server on our side. Meta sends us an SDP *offer* in
 * the `calls` webhook; the agent's browser produces the *answer*; audio
 * then flows directly between that browser and Meta. Everything here is
 * signalling — small JSON posts that carry SDP back and forth.
 *
 *   1. `connect` webhook arrives with the offer
 *   2. browser builds an RTCPeerConnection and generates an answer
 *   3. preAcceptCall(answer)   → tells Meta we're picking up
 *   4. …ICE completes, the peer connection reaches `connected`…
 *   5. acceptCall()            → finalizes; audio is live
 *   6. terminateCall()         → either side hangs up
 *
 * The split between pre-accept and accept exists so media can start
 * negotiating while the call is still ringing. Sending `accept` before
 * the peer connection is up produces a connected call with no audio.
 *
 * ============================================================
 * MAINTAINER NOTE — this module has never run against Meta
 * ============================================================
 *
 * The request shape below follows Meta's Calling API documentation, but
 * it was written without a WABA that had calling enabled, so it has not
 * been exercised end-to-end. Everything provider-specific is
 * deliberately confined to `callAction` — if Meta's payload differs in
 * practice, this one function is the fix, and the webhook, routes and
 * browser code above it are unaffected.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

/** Actions the Cloud API accepts on an in-flight call. */
export type CallAction = 'pre_accept' | 'accept' | 'reject' | 'terminate'

export interface CallActionArgs {
  phoneNumberId: string
  accessToken: string
  /** Meta's `call_id` from the `connect` webhook. */
  callId: string
}

export interface SdpCallActionArgs extends CallActionArgs {
  /** The SDP answer produced by the agent's browser. */
  sdpAnswer: string
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string }
}

export class CallActionError extends Error {
  readonly action: CallAction
  readonly status: number
  constructor(action: CallAction, status: number, message: string) {
    super(message)
    this.name = 'CallActionError'
    this.action = action
    this.status = status
  }
}

async function callAction(
  args: CallActionArgs & { action: CallAction; sdpAnswer?: string },
): Promise<void> {
  const { phoneNumberId, accessToken, callId, action, sdpAnswer } = args

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    call_id: callId,
    action,
  }
  // Only the two accept actions carry SDP. Meta rejects a session block
  // on reject/terminate.
  if (sdpAnswer) {
    body.session = { sdp_type: 'answer', sdp: sdpAnswer }
  }

  const response = await fetch(`${META_API_BASE}/${phoneNumberId}/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    let message = `Meta rejected call action "${action}" (${response.status})`
    try {
      const data = (await response.json()) as MetaErrorResponse
      if (data.error?.message) message = data.error.message
    } catch {
      // Non-JSON body — keep the status-line fallback.
    }
    throw new CallActionError(action, response.status, message)
  }
}

/**
 * Answer the call, supplying the browser's SDP answer. Media begins
 * negotiating; the call is not yet live.
 */
export async function preAcceptCall(args: SdpCallActionArgs): Promise<void> {
  return callAction({ ...args, action: 'pre_accept', sdpAnswer: args.sdpAnswer })
}

/**
 * Finalize the call. Send this only once the browser's peer connection
 * reports `connected` — accepting earlier yields a live call with
 * silence on it.
 */
export async function acceptCall(args: SdpCallActionArgs): Promise<void> {
  return callAction({ ...args, action: 'accept', sdpAnswer: args.sdpAnswer })
}

/** Decline a ringing call without answering. */
export async function rejectCall(args: CallActionArgs): Promise<void> {
  return callAction({ ...args, action: 'reject' })
}

/** Hang up a call that is ringing, connecting, or connected. */
export async function terminateCall(args: CallActionArgs): Promise<void> {
  return callAction({ ...args, action: 'terminate' })
}
