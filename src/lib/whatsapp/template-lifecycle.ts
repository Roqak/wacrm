// ============================================================
// WhatsApp template lifecycle core — submit / edit / delete.
//
// The three flows the dashboard exposes (/submit, PATCH, DELETE on
// /api/whatsapp/templates) and the public API now exposes again
// (/api/v1/templates) were identical except for auth. Extracting the
// core here means Meta-side semantics — what may be edited, what a
// failed submit leaves behind, when an image header needs a fresh
// resumable-uplable handle — live in exactly one file. Auth stays at
// the boundary: the caller passes its already-authenticated client
// and resolved account (session client with RLS for the dashboard,
// service-role client with an explicit account filter for API keys).
//
// Errors: everything is thrown as TemplateLifecycleError carrying the
// HTTP status the caller should surface — mapped to the dashboard's
// error envelope or the v1 error envelope by the route.
// ============================================================

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import {
  deleteMessageTemplate,
  editMessageTemplate,
  submitMessageTemplate,
} from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'

export class TemplateLifecycleError extends Error {
  /** The HTTP status the caller should surface. */
  httpStatus: number
  /** Meta id, set when submission succeeded but persistence failed —
   *  the caller can recover via "Sync from Meta" with it. */
  metaTemplateId?: string

  constructor(message: string, httpStatus: number = 400) {
    super(message)
    this.httpStatus = httpStatus
  }
}

/** Statuses Meta lets you edit — anything else (PENDING, DISABLED,
 *  terminal states) is refused with an actionable message. */
const EDITABLE_STATUS: Record<string, true> = {
  APPROVED: true,
  REJECTED: true,
  PAUSED: true,
}

// uuid v4 plus the looser shape Postgres gen_random_uuid emits.
// We don't need exhaustive RFC parsing — just enough to reject
// "../etc/passwd"-style payloads before they hit Supabase.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isTemplateUuid(id: string): boolean {
  return UUID_RE.test(id)
}

export function isTemplateDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  )
}

/** One message_templates row as the lifecycle writes it. Columns must
 *  stay in step with migration 017; adding a column touches only this
 *  contract and the upsert below. */
export interface TemplateUpsertRow {
  account_id: string
  user_id: string
  name: string
  category: string
  language: string
  header_type: string | null
  header_content: string | null
  header_media_url: string | null
  header_handle: string | null
  body_text: string
  footer_text: string | null
  buttons: unknown
  sample_values: unknown
  status: 'DRAFT' | string
  meta_template_id: string | null
  submission_error: string | null
  rejection_reason: null
  last_submitted_at: string
}

/** Shared upsert row builder — previously duplicated in the submit
 *  route; see the original comment there: one spot to add a column. */
function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: {
    status: 'DRAFT' | string
    metaTemplateId: string | null
    submissionError: string | null
  },
): TemplateUpsertRow {
  return {
    // Account tenancy — required NOT NULL on message_templates as
    // of migration 017. Without this an INSERT throws on the
    // not-null constraint.
    account_id: accountId,
    // Original author — kept as audit only. The unique index is
    // still on (user_id, name, language) — see the upsert helper
    // for the cross-teammate dedup follow-up.
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    // Clear stale rejection_reason whenever we re-submit; the
    // webhook will set it again if Meta still rejects.
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  }
}

async function upsertTemplateRow(
  supabase: SupabaseClient,
  row: TemplateUpsertRow,
) {
  // TODO(account-sharing): conflict target is still scoped to
  // user_id. Once a follow-up migration drops the legacy unique
  // index on (user_id, name, language) and adds (account_id,
  // name, language), switch `onConflict` here so two teammates
  // can't shadow each other's same-named template.
  return supabase
    .from('message_templates')
    .upsert(row, { onConflict: 'user_id,name,language' })
    .select()
    .single()
}

async function loadConfig(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{
  wabaId: string
  accessToken: string
}> {
  const { data: config, error } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()
  if (error || !config) {
    throw new TemplateLifecycleError(
      'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
    )
  }
  if (!config.waba_id) {
    throw new TemplateLifecycleError(
      'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
    )
  }
  return {
    wabaId: config.waba_id,
    accessToken: decrypt(config.access_token),
  }
}

/**
 * Submit a template to Meta for approval AND persist it locally
 * (DRAFT → PENDING). Used by both the "New Template" flow and the
 * public API.
 *
 * A Meta-side submit failure persists the attempt as a DRAFT row
 * (with submission_error) so the account can retry without
 * re-typing, then throws 429/502 with Meta's message.
 */
export async function submitTemplate(
  supabase: SupabaseClient,
  input: {
    accountId: string
    userId: string
    payload: TemplatePayload
  },
): Promise<{ template: Record<string, unknown>; dryRun: boolean }> {
  const { accountId, userId, payload } = input

  if (payload.category === 'Authentication') {
    throw new TemplateLifecycleError(
      'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
    )
  }
  try {
    validateTemplatePayload(payload)
  } catch (e) {
    throw new TemplateLifecycleError(
      e instanceof Error ? e.message : 'Validation failed.',
    )
  }

  const dryRun = isTemplateDryRun()
  let metaTemplateId: string
  let metaStatus: string

  if (dryRun) {
    metaTemplateId = `dry-run-${crypto.randomUUID()}`
    metaStatus = 'PENDING'
  } else {
    const { wabaId, accessToken } = await loadConfig(supabase, accountId)

    // Image headers need a Resumable-Upload handle (Meta rejects a
    // plain URL at creation). Derive it from header_media_url before
    // building the payload.
    try {
      await ensureImageHeaderHandle(payload, accessToken)
    } catch (e) {
      throw new TemplateLifecycleError(
        e instanceof Error ? e.message : 'Header image upload failed.',
      )
    }

    const metaPayload = buildMetaTemplatePayload(payload)
    try {
      const meta = await submitMessageTemplate({
        wabaId,
        accessToken,
        payload: metaPayload,
      })
      metaTemplateId = meta.id
      metaStatus = meta.status
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Meta submit failed.'
      // Persist the failure so the user can retry; row stays DRAFT
      // until they fix and re-submit.
      await upsertTemplateRow(
        supabase,
        buildUpsertRow(accountId, userId, payload, {
          status: 'DRAFT',
          metaTemplateId: null,
          submissionError: message,
        }),
      )
      const isRateLimit = /\b429\b/.test(message)
      throw new TemplateLifecycleError(
        isRateLimit
          ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
          : message,
        isRateLimit ? 429 : 502,
      )
    }
  }

  const { data: row, error: upsertErr } = await upsertTemplateRow(
    supabase,
    buildUpsertRow(accountId, userId, payload, {
      status: normalizeStatus(metaStatus),
      metaTemplateId,
      submissionError: null,
    }),
  )

  if (upsertErr) {
    // The submit succeeded on Meta's side but we failed to persist
    // locally. That's a data-drift state — surface the id so the
    // caller can recover via "Sync from Meta".
    const err = new TemplateLifecycleError(
      `Submitted to Meta but failed to save locally: ${upsertErr.message}. Run "Sync from Meta" to recover.`,
      500,
    )
    err.metaTemplateId = metaTemplateId
    throw err
  }

  return { template: row as Record<string, unknown>, dryRun }
}

/**
 * Edit an existing Meta-side template and re-submit. Used by the
 * dashboard's "Edit" (APPROVED) / "Resubmit" (REJECTED / PAUSED) and
 * by the public API's PATCH. Meta replaces components wholesale and
 * bumps status back to PENDING.
 */
export async function editTemplate(
  supabase: SupabaseClient,
  input: {
    accountId: string
    templateId: string
    payload: TemplatePayload
  },
): Promise<{ template: Record<string, unknown>; dryRun: boolean }> {
  const { accountId, templateId, payload } = input

  if (!isTemplateUuid(templateId)) {
    throw new TemplateLifecycleError('Invalid template id.')
  }

  // RLS handles ownership under the session client; the explicit
  // account filter keeps the service-role client honest, and we need
  // the existing row's meta_template_id + status either way.
  const { data: existing, error: lookupErr } = await supabase
    .from('message_templates')
    .select('id, name, status, meta_template_id, language')
    .eq('id', templateId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (lookupErr || !existing) {
    throw new TemplateLifecycleError('Template not found.', 404)
  }

  if (!existing.meta_template_id) {
    throw new TemplateLifecycleError(
      'This template was never submitted to Meta — use New Template to submit it instead.',
    )
  }

  if (!EDITABLE_STATUS[existing.status]) {
    throw new TemplateLifecycleError(
      `Templates in status ${existing.status} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
    )
  }

  if (payload.category === 'Authentication') {
    throw new TemplateLifecycleError(
      'AUTHENTICATION templates are not editable here — manage them in Meta WhatsApp Manager.',
    )
  }

  try {
    validateTemplatePayload(payload)
  } catch (e) {
    throw new TemplateLifecycleError(
      e instanceof Error ? e.message : 'Validation failed.',
    )
  }

  if (!isTemplateDryRun()) {
    const { accessToken } = await loadConfig(supabase, accountId)

    // Image headers need a fresh Resumable-Upload handle on every edit
    // (Meta replaces components wholesale). Derive from header_media_url.
    try {
      await ensureImageHeaderHandle(payload, accessToken)
    } catch (e) {
      throw new TemplateLifecycleError(
        e instanceof Error ? e.message : 'Header image upload failed.',
      )
    }

    const metaPayload = buildMetaTemplatePayload(payload)
    try {
      await editMessageTemplate({
        metaTemplateId: existing.meta_template_id,
        accessToken,
        components: metaPayload.components,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Meta edit failed.'
      await supabase
        .from('message_templates')
        .update({
          submission_error: message,
          last_submitted_at: new Date().toISOString(),
        })
        .eq('id', templateId)
      throw new TemplateLifecycleError(message, 502)
    }
  }

  // Meta accepted the edit — status flips back to PENDING for review.
  const { data: row, error: updErr } = await supabase
    .from('message_templates')
    .update({
      category: payload.category,
      header_type: payload.header_type ?? null,
      header_content: payload.header_content ?? null,
      header_media_url: payload.header_media_url ?? null,
      header_handle: payload.header_handle ?? null,
      body_text: payload.body_text,
      footer_text: payload.footer_text ?? null,
      buttons: payload.buttons ?? null,
      sample_values: payload.sample_values ?? null,
      status: 'PENDING',
      submission_error: null,
      rejection_reason: null,
      last_submitted_at: new Date().toISOString(),
    })
    .eq('id', templateId)
    .select()
    .single()

  if (updErr) {
    throw new TemplateLifecycleError(
      `Edited on Meta but failed to save locally: ${updErr.message}. Run "Sync from Meta" to recover.`,
      500,
    )
  }

  return { template: row as Record<string, unknown>, dryRun: isTemplateDryRun() }
}

/**
 * Remove a template — on Meta (when meta_template_id is set, scoped
 * to a single language variant) AND drop the local row. Local-only
 * rows skip the Meta call.
 */
export async function deleteTemplate(
  supabase: SupabaseClient,
  input: { accountId: string; templateId: string },
): Promise<{ dryRun: boolean }> {
  const { accountId, templateId } = input

  if (!isTemplateUuid(templateId)) {
    throw new TemplateLifecycleError('Invalid template id.')
  }

  const { data: existing, error: lookupErr } = await supabase
    .from('message_templates')
    .select('id, name, meta_template_id')
    .eq('id', templateId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (lookupErr || !existing) {
    throw new TemplateLifecycleError('Template not found.', 404)
  }

  if (existing.meta_template_id && !isTemplateDryRun()) {
    const { wabaId, accessToken } = await loadConfig(supabase, accountId)
    try {
      await deleteMessageTemplate({
        wabaId,
        accessToken,
        name: existing.name,
        metaTemplateId: existing.meta_template_id,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Meta delete failed.'
      throw new TemplateLifecycleError(message, 502)
    }
  }

  const { error: delErr } = await supabase
    .from('message_templates')
    .delete()
    .eq('id', templateId)
  if (delErr) {
    throw new TemplateLifecycleError(
      `Deleted on Meta but failed to delete locally: ${delErr.message}.`,
      500,
    )
  }

  return { dryRun: isTemplateDryRun() }
}