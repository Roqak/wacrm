/**
 * WhatsApp Forms data-exchange endpoint — the decrypted half.
 *
 * The route (`/api/whatsapp/flows/endpoint/[accountId]`) owns transport:
 * signature check, decryption, encryption, status codes. This module
 * decides WHAT to answer once the request is plain JSON:
 *
 *   ping                   → { data: { status: "active" } }  (health check)
 *   data.error present     → { data: { acknowledged: true } } (client
 *                            error notification)
 *   INIT / BACK /
 *   data_exchange          → forwarded to the form's
 *                            `endpoint_forward_url` (signed like an
 *                            outbound webhook) and its JSON answer is
 *                            returned as-is; without a forward URL,
 *                            INIT / BACK open the form's first screen
 *                            and data_exchange reports an error on the
 *                            current screen.
 *
 * The flow_token is how a request finds its form + contact: Meta's
 * request carries no flow id. A token that isn't ours (or belongs to
 * another account) answers 427, which Meta's client shows as "this
 * form is no longer available".
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import { buildSignatureHeader } from '@/lib/webhooks/sign'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { entryScreenOf } from './definition'
import { findFlowToken } from './send'

/** Meta gives an endpoint 10s; leave headroom for crypto + DB. */
export const FORWARD_TIMEOUT_MS = 7_000

export type EndpointOutcome =
  | { kind: 'ok'; response: Record<string, unknown> }
  /** Unknown / foreign / closed flow_token → HTTP 427. */
  | { kind: 'token_invalid' }
  /** Forward target failed — HTTP 500, Meta shows a generic error. */
  | { kind: 'error'; message: string }

interface EndpointFlowRow {
  id: string
  meta_flow_id: string
  name: string
  first_screen: string | null
  flow_json: Record<string, unknown> | null
  endpoint_forward_url: string | null
  endpoint_forward_secret: string | null
}

export async function handleFlowEndpointRequest(
  db: SupabaseClient,
  input: { accountId: string; body: Record<string, unknown> },
): Promise<EndpointOutcome> {
  const { accountId, body } = input
  const action = typeof body.action === 'string' ? body.action : ''

  if (action === 'ping') {
    return { kind: 'ok', response: { data: { status: 'active' } } }
  }

  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {}
  // Error notification from the WhatsApp client (e.g. a screen our
  // previous answer pointed at failed to render). Acknowledge it.
  if (data.error !== undefined) {
    console.warn('[wa-flows endpoint] client error notification:', {
      accountId,
      error: data.error,
      error_message: data.error_message,
    })
    return { kind: 'ok', response: { data: { acknowledged: true } } }
  }

  const flowToken = typeof body.flow_token === 'string' ? body.flow_token : ''
  const token = flowToken ? await findFlowToken(db, flowToken) : null
  if (!token || token.account_id !== accountId || token.completed_at) {
    return { kind: 'token_invalid' }
  }

  const { data: flowRow } = await db
    .from('whatsapp_flows')
    .select(
      'id, meta_flow_id, name, first_screen, flow_json, endpoint_forward_url, endpoint_forward_secret',
    )
    .eq('account_id', accountId)
    .eq(token.flow_id ? 'id' : 'meta_flow_id', token.flow_id ?? token.meta_flow_id ?? '')
    .maybeSingle()
  const flow = flowRow as EndpointFlowRow | null
  if (!flow) return { kind: 'token_invalid' }

  const screen = typeof body.screen === 'string' ? body.screen : null

  if (!flow.endpoint_forward_url) {
    const first = flow.first_screen || entryScreenOf(flow.flow_json)
    if ((action === 'INIT' || action === 'BACK') && first) {
      return { kind: 'ok', response: { screen: action === 'BACK' && screen ? screen : first, data: {} } }
    }
    return {
      kind: 'ok',
      response: {
        screen: screen ?? first ?? '',
        data: {
          error_message:
            'This form needs a data endpoint, and none is configured yet.',
        },
      },
    }
  }

  let contact: { id: string; name: string | null; phone: string | null } | null = null
  if (token.contact_id) {
    const { data: c } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('id', token.contact_id)
      .eq('account_id', accountId)
      .maybeSingle()
    contact = (c as typeof contact) ?? null
  }

  return forwardToEndpoint(flow, {
    version: body.version ?? null,
    action,
    screen,
    data,
    flow_token: flowToken,
    form: { id: flow.id, meta_flow_id: flow.meta_flow_id, name: flow.name },
    contact,
    conversation_id: token.conversation_id,
  })
}

async function forwardToEndpoint(
  flow: EndpointFlowRow,
  payload: Record<string, unknown>,
): Promise<EndpointOutcome> {
  const url = flow.endpoint_forward_url!
  // Re-checked per request: DNS can change after the URL was saved.
  if (!(await isDeliverableUrl(url))) {
    return { kind: 'error', message: 'Forward URL resolves to a private address.' }
  }
  const rawBody = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'wacrm-forms/1.0',
  }
  if (flow.endpoint_forward_secret) {
    try {
      headers['X-Wacrm-Signature'] = buildSignatureHeader(
        rawBody,
        decrypt(flow.endpoint_forward_secret),
        Math.floor(Date.now() / 1000),
      )
    } catch {
      return { kind: 'error', message: 'Forward signing secret could not be decrypted.' }
    }
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: rawBody,
      // Never follow a redirect — it could point at an internal host
      // the SSRF check above never saw.
      redirect: 'manual',
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
  } catch (e) {
    return {
      kind: 'error',
      message: `Forward request failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (!response.ok) {
    return { kind: 'error', message: `Forward target answered HTTP ${response.status}.` }
  }
  const answer: unknown = await response.json().catch(() => null)
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return { kind: 'error', message: 'Forward target must answer with a JSON object.' }
  }
  return { kind: 'ok', response: answer as Record<string, unknown> }
}
