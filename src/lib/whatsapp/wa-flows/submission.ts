/**
 * Inbound side of WhatsApp Forms: what the webhook does with an
 * `interactive.nfm_reply` (a completed form).
 *
 * Split in two around the message insert, because the webhook's
 * idempotency boundary is the `messages` upsert:
 *
 *   resolveFlowSubmission  — BEFORE the insert. Pure lookups: which
 *                            form, which token / chatbot run, and the
 *                            display text + `flow_response` column for
 *                            the message row. No writes, so a replayed
 *                            delivery costs nothing.
 *   recordFlowSubmission   — AFTER a genuine first insert. Writes the
 *                            response row, closes the token, and copies
 *                            mapped fields onto the contact.
 *
 * Service-role client throughout (the webhook has no session); every
 * query is account-scoped.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import type { MessageFlowResponse, WhatsAppFlowFieldMapping } from '@/types'
import {
  formatFieldValue,
  parseFlowSubmission,
  summarizeSubmission,
} from './definition'
import { findFlowToken, type FlowTokenRow } from './send'

export interface ResolvedFlowSubmission {
  token: FlowTokenRow | null
  flowToken: string | null
  /** Local catalog id, when the form is synced. */
  flowId: string | null
  metaFlowId: string | null
  flowName: string | null
  fields: Record<string, unknown>
  fieldMappings: WhatsAppFlowFieldMapping[]
  /** Chatbot run to resume (token issued by a `send_form` node). */
  flowRunId: string | null
  /** `content_text` for the inbound message. */
  summary: string
  /** `messages.flow_response` for the inbound message. */
  messageFlowResponse: MessageFlowResponse
}

interface LocalFlowRow {
  id: string
  meta_flow_id: string
  name: string
  field_mappings: WhatsAppFlowFieldMapping[] | null
}

async function loadLocalFlow(
  db: SupabaseClient,
  accountId: string,
  by: { id?: string | null; metaFlowId?: string | null },
): Promise<LocalFlowRow | null> {
  if (!by.id && !by.metaFlowId) return null
  let q = db
    .from('whatsapp_flows')
    .select('id, meta_flow_id, name, field_mappings')
    .eq('account_id', accountId)
  q = by.id ? q.eq('id', by.id) : q.eq('meta_flow_id', by.metaFlowId!)
  const { data } = await q.maybeSingle()
  return (data as LocalFlowRow | null) ?? null
}

/**
 * Which form a submission with no usable token came from: the message
 * the customer's reply quotes (`context.id`) is the one we sent — an
 * interactive form message (payload carries `flow_id`) or a template
 * with a FLOW button.
 */
async function metaFlowIdFromRepliedMessage(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  contextWamid: string,
): Promise<string | null> {
  const { data: sent } = await db
    .from('messages')
    .select('interactive_payload, template_name')
    .eq('conversation_id', conversationId)
    .eq('message_id', contextWamid)
    .limit(1)
    .maybeSingle()
  const row = sent as {
    interactive_payload?: { kind?: string; flow_id?: string } | null
    template_name?: string | null
  } | null
  if (!row) return null
  if (row.interactive_payload?.kind === 'flow' && row.interactive_payload.flow_id) {
    return row.interactive_payload.flow_id
  }
  if (row.template_name) {
    const { data: templates } = await db
      .from('message_templates')
      .select('buttons')
      .eq('account_id', accountId)
      .eq('name', row.template_name)
    for (const t of (templates ?? []) as { buttons?: unknown }[]) {
      const flowButton = Array.isArray(t.buttons)
        ? (t.buttons as { type?: string; flow_id?: string }[]).find(
            (b) => b?.type === 'FLOW' && b.flow_id,
          )
        : undefined
      if (flowButton?.flow_id) return flowButton.flow_id
    }
  }
  return null
}

export async function resolveFlowSubmission(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    responseJson: unknown
    /** `messages[0].context.id` — the form message being answered. */
    contextWamid: string | null
  },
): Promise<ResolvedFlowSubmission> {
  const { accountId } = args
  const { flowToken, fields } = parseFlowSubmission(args.responseJson)

  // A token only counts if it is ours AND this account's — a forged or
  // cross-tenant token must not steer the submission into another
  // account's chatbot run.
  let token = flowToken ? await findFlowToken(db, flowToken) : null
  if (token && token.account_id !== accountId) token = null

  let local = await loadLocalFlow(db, accountId, {
    id: token?.flow_id,
    metaFlowId: token?.meta_flow_id,
  })
  let metaFlowId = local?.meta_flow_id ?? token?.meta_flow_id ?? null
  if (!metaFlowId && args.contextWamid) {
    metaFlowId = await metaFlowIdFromRepliedMessage(
      db,
      accountId,
      args.conversationId,
      args.contextWamid,
    )
    if (metaFlowId) local = await loadLocalFlow(db, accountId, { metaFlowId })
  }

  const flowName = local?.name ?? null
  return {
    token,
    flowToken,
    flowId: local?.id ?? null,
    metaFlowId,
    flowName,
    fields,
    fieldMappings: Array.isArray(local?.field_mappings) ? local.field_mappings : [],
    flowRunId: token?.flow_run_id ?? null,
    summary: summarizeSubmission(flowName, fields),
    messageFlowResponse: {
      flow_id: local?.id ?? null,
      meta_flow_id: metaFlowId,
      flow_name: flowName,
      response: fields,
    },
  }
}

const BUILT_IN_TARGETS = new Set(['name', 'email', 'company'])

/**
 * Copy mapped submission fields onto the contact. Same target encoding
 * and the same tenancy guards as the automation `update_contact_field`
 * step. Returns the targets written, for logging.
 */
export async function applyFieldMappings(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    mappings: WhatsAppFlowFieldMapping[]
    fields: Record<string, unknown>
  },
): Promise<string[]> {
  const written: string[] = []
  const columns: Record<string, string> = {}
  for (const m of args.mappings) {
    if (!m?.field || !m.target) continue
    const value = formatFieldValue(args.fields[m.field]).trim()
    if (!value) continue
    if (BUILT_IN_TARGETS.has(m.target)) {
      columns[m.target] = value
      continue
    }
    if (m.target.startsWith('custom:')) {
      const customFieldId = m.target.slice('custom:'.length)
      if (!customFieldId) continue
      const { data: field } = await db
        .from('custom_fields')
        .select('id')
        .eq('id', customFieldId)
        .eq('account_id', args.accountId)
        .maybeSingle()
      if (!field) continue
      const { error } = await db
        .from('contact_custom_values')
        .upsert(
          { contact_id: args.contactId, custom_field_id: customFieldId, value },
          { onConflict: 'contact_id,custom_field_id' },
        )
      if (!error) written.push(m.target)
    }
  }
  if (Object.keys(columns).length > 0) {
    const { error } = await db
      .from('contacts')
      .update({ ...columns, updated_at: new Date().toISOString() })
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
    if (!error) written.push(...Object.keys(columns))
  }
  return written
}

export async function recordFlowSubmission(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    messageId: string
    waMessageId: string
    submission: ResolvedFlowSubmission
  },
): Promise<{ responseId: string | null; mapped: string[] }> {
  const { submission } = args
  const { data: inserted, error } = await db
    .from('whatsapp_flow_responses')
    .upsert(
      {
        account_id: args.accountId,
        flow_id: submission.flowId,
        meta_flow_id: submission.metaFlowId,
        flow_token: submission.flowToken,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        message_id: args.messageId,
        wa_message_id: args.waMessageId,
        response: submission.fields,
      },
      { onConflict: 'account_id,wa_message_id', ignoreDuplicates: true },
    )
    .select('id')
  if (error) {
    console.error('[wa-flows] storing form response failed:', error.message)
  }

  if (submission.token) {
    await db
      .from('whatsapp_flow_tokens')
      .update({ completed_at: new Date().toISOString() })
      .eq('token', submission.token.token)
      .eq('account_id', args.accountId)
  }

  let mapped: string[] = []
  if (submission.fieldMappings.length > 0) {
    try {
      mapped = await applyFieldMappings(db, {
        accountId: args.accountId,
        contactId: args.contactId,
        mappings: submission.fieldMappings,
        fields: submission.fields,
      })
    } catch (err) {
      console.error(
        '[wa-flows] applying field mappings failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  const rows = (inserted ?? []) as { id: string }[]
  return { responseId: rows[0]?.id ?? null, mapped }
}
