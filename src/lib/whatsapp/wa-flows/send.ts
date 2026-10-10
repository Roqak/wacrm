/**
 * Send-side plumbing for WhatsApp Forms, shared by every path that can
 * put a form in front of a customer: the inbox composer / public API
 * (`send-message.ts`), automations, the chatbot engine, and template /
 * broadcast sends with a FLOW button.
 *
 * Two jobs:
 *
 *   1. Prepare the payload — mint the `flow_token` and resolve which
 *      screen a `navigate` send opens (the caller rarely knows; the
 *      form's definition does).
 *   2. Record the token once Meta accepted the send, so the
 *      submission webhook and the data-exchange endpoint can map the
 *      token back to account / contact / conversation / chatbot run.
 *
 * Works with any Supabase client — every query filters by account_id,
 * so the RLS-scoped dashboard client and the service-role client are
 * both safe.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { MessageTemplate } from '@/types'
import type { InteractiveFlowPayload } from '../interactive'
import { getFlowJson } from './api'
import { entryScreenOf } from './definition'

export type FlowTokenSource =
  | 'inbox'
  | 'api'
  | 'automation'
  | 'chatbot'
  | 'template'
  | 'broadcast'

/** Tokens are opaque to Meta; the prefix makes ours recognisable in logs. */
export function mintFlowToken(): string {
  return `wacrm_${randomUUID()}`
}

export interface LocalFlowRef {
  id: string
  name: string
  status: string
  first_screen: string | null
  flow_json: Record<string, unknown> | null
}

/** The catalog row for a Meta flow id, scoped to the account. */
export async function findLocalFlow(
  db: SupabaseClient,
  accountId: string,
  metaFlowId: string,
): Promise<LocalFlowRef | null> {
  const { data } = await db
    .from('whatsapp_flows')
    .select('id, name, status, first_screen, flow_json')
    .eq('account_id', accountId)
    .eq('meta_flow_id', metaFlowId)
    .maybeSingle()
  return (data as LocalFlowRef | null) ?? null
}

export class FlowSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlowSendError'
  }
}

/**
 * Fill in `flow_token` and, for `navigate`, the screen to open.
 *
 * Screen resolution order: the caller's explicit `screen`, the form's
 * configured `first_screen`, the entry screen of the cached definition,
 * and — when the definition was never fetched — a one-off download
 * from Meta (cached back onto the row so the next send is free).
 */
export async function prepareFlowPayload(
  db: SupabaseClient,
  args: {
    accountId: string
    payload: InteractiveFlowPayload
    accessToken: string
  },
): Promise<{ payload: InteractiveFlowPayload; localFlow: LocalFlowRef | null }> {
  const { accountId, accessToken } = args
  const payload: InteractiveFlowPayload = {
    ...args.payload,
    flow_action: args.payload.flow_action ?? 'navigate',
    flow_token: mintFlowToken(),
  }
  const localFlow = await findLocalFlow(db, accountId, payload.flow_id)
  if (localFlow && !payload.flow_name) payload.flow_name = localFlow.name

  if (localFlow && localFlow.status !== 'PUBLISHED' && payload.mode !== 'draft') {
    throw new FlowSendError(
      `Form "${localFlow.name}" is ${localFlow.status.toLowerCase()} — only published forms can be sent.`,
    )
  }

  if (payload.flow_action === 'navigate' && !payload.screen?.trim()) {
    let screen = localFlow?.first_screen || entryScreenOf(localFlow?.flow_json)
    if (!screen) {
      const json = await getFlowJson({ flowId: payload.flow_id, accessToken }).catch(
        () => null,
      )
      screen = entryScreenOf(json)
      if (json && localFlow) {
        await db
          .from('whatsapp_flows')
          .update({ flow_json: json })
          .eq('id', localFlow.id)
          .eq('account_id', accountId)
      }
    }
    if (!screen) {
      throw new FlowSendError(
        'Could not work out which screen the form opens on — set its first screen in Settings → WhatsApp Forms.',
      )
    }
    payload.screen = screen
  }

  return { payload, localFlow }
}

/**
 * Persist the token after Meta accepted the send. Best-effort by
 * design: the message is already out, and a lost token row only costs
 * the submission its contact/run correlation — the webhook still falls
 * back to the replied-to message (`context.id`) and the sender phone.
 */
export async function recordFlowToken(
  db: SupabaseClient,
  row: {
    token: string
    accountId: string
    flowId?: string | null
    metaFlowId: string | null
    contactId?: string | null
    conversationId?: string | null
    flowRunId?: string | null
    source: FlowTokenSource
    waMessageId?: string | null
  },
): Promise<void> {
  const { error } = await db.from('whatsapp_flow_tokens').insert({
    token: row.token,
    account_id: row.accountId,
    flow_id: row.flowId ?? null,
    meta_flow_id: row.metaFlowId,
    contact_id: row.contactId ?? null,
    conversation_id: row.conversationId ?? null,
    flow_run_id: row.flowRunId ?? null,
    source: row.source,
    wa_message_id: row.waMessageId ?? null,
  })
  if (error) {
    console.error('[wa-flows] recording flow token failed:', error.message)
  }
}

export interface FlowTokenRow {
  token: string
  account_id: string
  flow_id: string | null
  meta_flow_id: string | null
  contact_id: string | null
  conversation_id: string | null
  flow_run_id: string | null
  source: FlowTokenSource
  wa_message_id: string | null
  completed_at: string | null
  created_at: string
}

export async function findFlowToken(
  db: SupabaseClient,
  token: string,
): Promise<FlowTokenRow | null> {
  const { data } = await db
    .from('whatsapp_flow_tokens')
    .select('*')
    .eq('token', token)
    .maybeSingle()
  return (data as FlowTokenRow | null) ?? null
}

/** The template's FLOW (WhatsApp Form) button, if it has one. */
export function templateFlowButton(
  template: Pick<MessageTemplate, 'buttons'> | null | undefined,
): { flow_id: string } | null {
  const button = template?.buttons?.find((b) => b.type === 'FLOW')
  return button && button.type === 'FLOW' && button.flow_id
    ? { flow_id: button.flow_id }
    : null
}
