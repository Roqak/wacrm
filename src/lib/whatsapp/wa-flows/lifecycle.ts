// ============================================================
// WhatsApp Forms lifecycle core — sync / create / edit / publish /
// deprecate / delete / preview.
//
// Same split as template-lifecycle.ts: Meta-side semantics live here
// once; auth stays at the route boundary. The caller passes its
// already-authenticated client (RLS session client for the dashboard,
// service-role client for the public API) and the resolved account —
// every query here also filters by account_id.
//
// Errors are thrown as FlowLifecycleError carrying the HTTP status the
// caller should surface.
// ============================================================

import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { proxySafeStatus } from '@/lib/http/proxy-safe-status'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import {
  WHATSAPP_FLOW_CATEGORIES,
  type WhatsAppFlow,
  type WhatsAppFlowFieldMapping,
  type WhatsAppFlowStatus,
} from '@/types'
import {
  createFlow,
  deleteFlow,
  deprecateFlow,
  getFlow,
  getFlowJson,
  getFlowPreviewUrl,
  listFlows,
  publishFlow,
  updateFlowJson,
  updateFlowMetadata,
  type MetaFlowValidationError,
} from './api'
import { entryScreenOf, listScreenIds } from './definition'

export class FlowLifecycleError extends Error {
  httpStatus: number
  constructor(message: string, httpStatus: number = 400) {
    super(message)
    this.name = 'FlowLifecycleError'
    this.httpStatus = httpStatus
  }
}

/** See proxySafeStatus for why 502/504 can't reach the browser. */
export function flowHttpStatus(error: FlowLifecycleError): number {
  return proxySafeStatus(error.httpStatus)
}

/** Columns safe to hand to any member (no forward secret). */
export const FLOW_PUBLIC_COLUMNS =
  'id, account_id, user_id, meta_flow_id, name, status, categories, flow_json, json_version, data_api_version, endpoint_uri, validation_errors, first_screen, field_mappings, endpoint_forward_url, synced_at, created_at, updated_at'

const KNOWN_STATUSES: WhatsAppFlowStatus[] = [
  'DRAFT',
  'PUBLISHED',
  'DEPRECATED',
  'BLOCKED',
  'THROTTLED',
]

export function normalizeFlowStatus(raw: string | undefined): WhatsAppFlowStatus {
  const upper = (raw ?? '').toUpperCase() as WhatsAppFlowStatus
  return KNOWN_STATUSES.includes(upper) ? upper : 'DRAFT'
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isFlowUuid(id: string): boolean {
  return UUID_RE.test(id)
}

// ------------------------------------------------------------
// Input validation (pure)
// ------------------------------------------------------------

export function validateCategories(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new FlowLifecycleError('Pick at least one category.')
  }
  const out: string[] = []
  for (const c of input) {
    if (
      typeof c !== 'string' ||
      !(WHATSAPP_FLOW_CATEGORIES as readonly string[]).includes(c)
    ) {
      throw new FlowLifecycleError(
        `Unknown category "${String(c)}". Use one of: ${WHATSAPP_FLOW_CATEGORIES.join(', ')}.`,
      )
    }
    if (!out.includes(c)) out.push(c)
  }
  return out
}

/**
 * Structural sanity check before a Flow JSON goes to Meta. Meta runs
 * the real validation (and reports `validation_errors`); this only
 * catches what would make the upload itself meaningless.
 */
export function validateFlowJson(input: unknown): Record<string, unknown> {
  let parsed = input
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input)
    } catch (e) {
      throw new FlowLifecycleError(
        `Form JSON is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FlowLifecycleError('Form JSON must be an object.')
  }
  const json = parsed as Record<string, unknown>
  if (typeof json.version !== 'string' || !json.version) {
    throw new FlowLifecycleError('Form JSON needs a "version" (e.g. "7.0").')
  }
  if (listScreenIds(json).length === 0) {
    throw new FlowLifecycleError('Form JSON needs at least one screen with an "id".')
  }
  return json
}

const MAPPING_TARGET_RE = /^(name|email|company|custom:[0-9a-f-]{36})$/i

export function validateFieldMappings(input: unknown): WhatsAppFlowFieldMapping[] {
  if (!Array.isArray(input)) {
    throw new FlowLifecycleError('field_mappings must be a list.')
  }
  const out: WhatsAppFlowFieldMapping[] = []
  for (const m of input) {
    const field = (m as { field?: unknown })?.field
    const target = (m as { target?: unknown })?.target
    if (typeof field !== 'string' || !field.trim()) {
      throw new FlowLifecycleError('Every field mapping needs a form field.')
    }
    if (typeof target !== 'string' || !MAPPING_TARGET_RE.test(target)) {
      throw new FlowLifecycleError(
        `Mapping for "${field}" must target name, email, company or a custom field.`,
      )
    }
    out.push({ field: field.trim(), target })
  }
  return out
}

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------

export interface FlowConfig {
  wabaId: string
  phoneNumberId: string
  accessToken: string
}

export async function loadFlowConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<FlowConfig> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('waba_id, phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !config) {
    throw new FlowLifecycleError(
      'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
    )
  }
  if (!config.waba_id) {
    throw new FlowLifecycleError(
      'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
    )
  }
  return {
    wabaId: config.waba_id,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
  }
}

/** Wrap a Meta call so its rejection surfaces as a 502 with Meta's text. */
async function meta<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw new FlowLifecycleError(
      e instanceof Error ? e.message : 'Meta API call failed.',
      502,
    )
  }
}

/**
 * Meta can accept a form's JSON and still refuse to publish it:
 * publishing is gated by account-level integrity checks (the 139002
 * family, "Integrity requirements not met."). The usual causes are
 * business verification or the phone number's display name still in
 * review, or a new number with little message history — not the form.
 * Returns the explained error for that refusal, null otherwise.
 */
function publishRefusalError(err: unknown): FlowLifecycleError | null {
  const metaText = err instanceof Error ? err.message : ''
  if (!/integrity requirements not met/i.test(metaText)) return null
  return new FlowLifecycleError(
    `Meta refused to publish this form: ${metaText}. This is an account-level ` +
      "check, not a problem with the form — usually business verification or the " +
      "number's display name is still in review, or the number is new with little " +
      'message history. The form stays here as a draft; retry Publish once Meta ' +
      'clears the account, or contact WhatsApp support if it keeps refusing.',
    502,
  )
}

// ------------------------------------------------------------
// Read / refresh
// ------------------------------------------------------------

export async function loadLocalFlowRow(
  db: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<WhatsAppFlow> {
  if (!isFlowUuid(flowId)) throw new FlowLifecycleError('Form not found.', 404)
  const { data, error } = await db
    .from('whatsapp_flows')
    .select(FLOW_PUBLIC_COLUMNS)
    .eq('id', flowId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new FlowLifecycleError(error.message, 500)
  if (!data) throw new FlowLifecycleError('Form not found.', 404)
  return data as unknown as WhatsAppFlow
}

/** Meta's view of one flow, as the columns we store. */
async function fetchMetaState(
  accessToken: string,
  metaFlowId: string,
): Promise<{
  name: string
  status: WhatsAppFlowStatus
  categories: string[]
  json_version: string | null
  data_api_version: string | null
  endpoint_uri: string | null
  validation_errors: MetaFlowValidationError[]
  flow_json: Record<string, unknown> | null
}> {
  const [details, json] = await Promise.all([
    getFlow({ flowId: metaFlowId, accessToken }),
    getFlowJson({ flowId: metaFlowId, accessToken }).catch(() => null),
  ])
  return {
    name: details.name,
    status: normalizeFlowStatus(details.status),
    categories: details.categories ?? [],
    json_version: details.json_version ?? null,
    data_api_version: details.data_api_version ?? null,
    endpoint_uri: details.endpoint_uri ?? null,
    validation_errors: details.validation_errors ?? [],
    flow_json: json,
  }
}

/** Re-read one flow from Meta and store it. */
export async function refreshWaFlow(
  db: SupabaseClient,
  input: { accountId: string; flowId: string },
): Promise<WhatsAppFlow> {
  const local = await loadLocalFlowRow(db, input.accountId, input.flowId)
  const { accessToken } = await loadFlowConfig(db, input.accountId)
  const state = await meta(() => fetchMetaState(accessToken, local.meta_flow_id))
  return saveFlowState(db, input.accountId, local.id, {
    ...state,
    // A cached JSON survives a failed asset download.
    flow_json: state.flow_json ?? local.flow_json,
  })
}

async function saveFlowState(
  db: SupabaseClient,
  accountId: string,
  localId: string,
  patch: Record<string, unknown>,
): Promise<WhatsAppFlow> {
  const now = new Date().toISOString()
  const { data, error } = await db
    .from('whatsapp_flows')
    .update({ ...patch, synced_at: now, updated_at: now })
    .eq('id', localId)
    .eq('account_id', accountId)
    .select(FLOW_PUBLIC_COLUMNS)
    .single()
  if (error) throw new FlowLifecycleError(error.message, 500)
  return data as unknown as WhatsAppFlow
}

// ------------------------------------------------------------
// Sync
// ------------------------------------------------------------

export interface FlowSyncResult {
  total: number
  inserted: number
  updated: number
  errors: { name: string; message: string }[]
  truncated: boolean
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Meta → local catalog. Local-only behaviour (field mappings, forward
 * URL, first-screen override) is preserved on update. Forms deleted on
 * Meta are left in place, like templates, so their past responses keep
 * a name to hang off.
 */
export async function syncWaFlows(
  db: SupabaseClient,
  input: { accountId: string; userId: string | null },
): Promise<FlowSyncResult> {
  const { wabaId, accessToken } = await loadFlowConfig(db, input.accountId)
  const { flows, truncated } = await meta(() => listFlows({ wabaId, accessToken }))

  const { data: existingRows, error: loadErr } = await db
    .from('whatsapp_flows')
    .select('id, meta_flow_id, flow_json')
    .eq('account_id', input.accountId)
  if (loadErr) throw new FlowLifecycleError(loadErr.message, 500)
  const existing = new Map(
    ((existingRows ?? []) as { id: string; meta_flow_id: string; flow_json: unknown }[]).map(
      (r) => [r.meta_flow_id, r],
    ),
  )

  const result: FlowSyncResult = {
    total: flows.length,
    inserted: 0,
    updated: 0,
    errors: [],
    truncated,
  }

  await mapLimit(flows, 4, async (summary) => {
    try {
      const state = await fetchMetaState(accessToken, summary.id)
      const now = new Date().toISOString()
      const prior = existing.get(summary.id)
      const row = {
        ...state,
        flow_json: state.flow_json ?? (prior?.flow_json as Record<string, unknown> | null) ?? null,
        synced_at: now,
        updated_at: now,
      }
      if (prior) {
        const { error } = await db
          .from('whatsapp_flows')
          .update(row)
          .eq('id', prior.id)
          .eq('account_id', input.accountId)
        if (error) throw new Error(error.message)
        result.updated++
      } else {
        const { error } = await db.from('whatsapp_flows').insert({
          ...row,
          account_id: input.accountId,
          user_id: input.userId,
          meta_flow_id: summary.id,
        })
        if (error) throw new Error(error.message)
        result.inserted++
      }
    } catch (e) {
      result.errors.push({
        name: summary.name,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  })

  return result
}

// ------------------------------------------------------------
// Create / edit
// ------------------------------------------------------------

export async function createWaFlow(
  db: SupabaseClient,
  input: {
    accountId: string
    userId: string | null
    name: unknown
    categories: unknown
    flowJson?: unknown
    publish?: boolean
  },
): Promise<{ flow: WhatsAppFlow; validation_errors: MetaFlowValidationError[] }> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new FlowLifecycleError('Give the form a name.')
  if (name.length > 200) throw new FlowLifecycleError('Form name is too long (200 max).')
  const categories = validateCategories(input.categories)
  const flowJson =
    input.flowJson === undefined || input.flowJson === null || input.flowJson === ''
      ? undefined
      : validateFlowJson(input.flowJson)

  const { wabaId, accessToken } = await loadFlowConfig(db, input.accountId)
  // Always a plain draft create — publishing happens below, in its own
  // call, so a refused publish can't strand the form on Meta alone.
  const created = await meta(() =>
    createFlow({ wabaId, accessToken, name, categories, flowJson }),
  )
  const state = await meta(() => fetchMetaState(accessToken, created.id))
  const now = new Date().toISOString()
  const { data, error } = await db
    .from('whatsapp_flows')
    .insert({
      ...state,
      flow_json: state.flow_json ?? flowJson ?? null,
      account_id: input.accountId,
      user_id: input.userId,
      meta_flow_id: created.id,
      synced_at: now,
    })
    .select(FLOW_PUBLIC_COLUMNS)
    .single()
  if (error) {
    throw new FlowLifecycleError(
      `Created on Meta (id ${created.id}) but failed to save locally: ${error.message}. Run "Sync from Meta" to recover it.`,
      500,
    )
  }
  if (!input.publish) {
    return {
      flow: data as unknown as WhatsAppFlow,
      validation_errors: state.validation_errors.length
        ? state.validation_errors
        : created.validation_errors,
    }
  }

  // Publish in a second call instead of Meta's combined create+publish:
  // when the publish half fails (e.g. an integrity refusal) the form is
  // already saved here as a draft instead of existing only on Meta.
  try {
    await meta(() => publishFlow({ flowId: created.id, accessToken }))
  } catch (err) {
    await refreshWaFlow(db, { accountId: input.accountId, flowId: data.id }).catch(() => null)
    const refusal = publishRefusalError(err)
    if (refusal) throw refusal
    throw err
  }
  const published = await refreshWaFlow(db, { accountId: input.accountId, flowId: data.id })
  // Publish only succeeds with no pending Meta validation errors, and the
  // stored row types that list loosely (unknown[] | null) — hand back the
  // typed empty list instead.
  return { flow: published, validation_errors: [] }
}

export interface FlowPatch {
  name?: unknown
  categories?: unknown
  flow_json?: unknown
  first_screen?: unknown
  field_mappings?: unknown
  endpoint_forward_url?: unknown
  /** Meta-side: the data endpoint Meta calls (https). '' clears it. */
  endpoint_uri?: unknown
}

/**
 * Edit a form. Meta-side fields (name, categories, JSON) go to Meta;
 * the rest is local behaviour. JSON edits are refused on anything but
 * a DRAFT — Meta freezes a published form.
 */
export async function updateWaFlow(
  db: SupabaseClient,
  input: { accountId: string; flowId: string; patch: FlowPatch },
): Promise<{
  flow: WhatsAppFlow
  validation_errors: MetaFlowValidationError[]
  /** Set when the forward URL changed: the new signing secret, shown once. */
  forward_secret?: string
}> {
  const { accountId, patch } = input
  const local = await loadLocalFlowRow(db, accountId, input.flowId)
  const localPatch: Record<string, unknown> = {}
  let forwardSecret: string | undefined

  if (patch.first_screen !== undefined) {
    if (patch.first_screen === null || patch.first_screen === '') {
      localPatch.first_screen = null
    } else if (typeof patch.first_screen === 'string') {
      const screens = listScreenIds(local.flow_json)
      if (screens.length > 0 && !screens.includes(patch.first_screen)) {
        throw new FlowLifecycleError(
          `Screen "${patch.first_screen}" isn't in this form. Screens: ${screens.join(', ')}.`,
        )
      }
      localPatch.first_screen = patch.first_screen
    } else {
      throw new FlowLifecycleError('first_screen must be a screen id.')
    }
  }
  if (patch.field_mappings !== undefined) {
    localPatch.field_mappings = validateFieldMappings(patch.field_mappings)
  }
  if (patch.endpoint_forward_url !== undefined) {
    const url = patch.endpoint_forward_url
    if (url === null || url === '') {
      localPatch.endpoint_forward_url = null
      localPatch.endpoint_forward_secret = null
    } else if (typeof url === 'string') {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new FlowLifecycleError('Forward URL must be a valid URL.')
      }
      if (parsed.protocol !== 'https:') {
        throw new FlowLifecycleError('Forward URL must use https.')
      }
      if (!(await isDeliverableUrl(url))) {
        throw new FlowLifecycleError(
          'Forward URL resolves to a private or reserved address.',
        )
      }
      if (url !== local.endpoint_forward_url) {
        forwardSecret = `whfs_${randomBytes(24).toString('hex')}`
        localPatch.endpoint_forward_secret = encrypt(forwardSecret)
      }
      localPatch.endpoint_forward_url = url
    } else {
      throw new FlowLifecycleError('Forward URL must be a string.')
    }
  }

  let validationErrors: MetaFlowValidationError[] = []
  let endpointUri: string | undefined
  if (patch.endpoint_uri !== undefined) {
    if (patch.endpoint_uri === null || patch.endpoint_uri === '') {
      endpointUri = ''
    } else if (typeof patch.endpoint_uri === 'string') {
      try {
        if (new URL(patch.endpoint_uri).protocol !== 'https:') throw new Error()
      } catch {
        throw new FlowLifecycleError('The data endpoint must be an https URL.')
      }
      endpointUri = patch.endpoint_uri
    } else {
      throw new FlowLifecycleError('endpoint_uri must be a URL.')
    }
  }

  const touchesMeta =
    patch.name !== undefined ||
    patch.categories !== undefined ||
    patch.flow_json !== undefined ||
    endpointUri !== undefined
  if (touchesMeta) {
    const { accessToken } = await loadFlowConfig(db, accountId)
    const name =
      patch.name === undefined
        ? undefined
        : typeof patch.name === 'string' && patch.name.trim()
          ? patch.name.trim()
          : (() => {
              throw new FlowLifecycleError('Give the form a name.')
            })()
    const categories =
      patch.categories === undefined ? undefined : validateCategories(patch.categories)
    if (name !== undefined || categories !== undefined || endpointUri !== undefined) {
      await meta(() =>
        updateFlowMetadata({
          flowId: local.meta_flow_id,
          accessToken,
          name,
          categories,
          endpointUri,
        }),
      )
    }
    if (patch.flow_json !== undefined) {
      if (local.status !== 'DRAFT') {
        throw new FlowLifecycleError(
          `A ${local.status.toLowerCase()} form can't be edited — Meta freezes it once published. Create a new form instead.`,
          409,
        )
      }
      const json = validateFlowJson(patch.flow_json)
      const uploaded = await meta(() =>
        updateFlowJson({ flowId: local.meta_flow_id, accessToken, flowJson: json }),
      )
      validationErrors = uploaded.validation_errors
      localPatch.flow_json = json
      // A first-screen override that no longer exists would break sends.
      const screens = listScreenIds(json)
      const firstScreen =
        (localPatch.first_screen as string | null | undefined) ?? local.first_screen
      if (firstScreen && !screens.includes(firstScreen)) localPatch.first_screen = null
    }
    const state = await meta(() => fetchMetaState(accessToken, local.meta_flow_id))
    Object.assign(localPatch, {
      name: state.name,
      status: state.status,
      categories: state.categories,
      json_version: state.json_version,
      data_api_version: state.data_api_version,
      endpoint_uri: state.endpoint_uri,
      validation_errors: state.validation_errors,
    })
    if (state.flow_json) localPatch.flow_json = state.flow_json
    if (state.validation_errors.length) validationErrors = state.validation_errors
  }

  const flow = await saveFlowState(db, accountId, local.id, localPatch)
  return { flow, validation_errors: validationErrors, forward_secret: forwardSecret }
}

// ------------------------------------------------------------
// Publish / deprecate / delete / preview
// ------------------------------------------------------------

export async function publishWaFlow(
  db: SupabaseClient,
  input: { accountId: string; flowId: string },
): Promise<WhatsAppFlow> {
  const local = await loadLocalFlowRow(db, input.accountId, input.flowId)
  if (local.status !== 'DRAFT') {
    throw new FlowLifecycleError(`Only draft forms can be published (this one is ${local.status.toLowerCase()}).`, 409)
  }
  const { accessToken } = await loadFlowConfig(db, input.accountId)
  try {
    await meta(() => publishFlow({ flowId: local.meta_flow_id, accessToken }))
  } catch (err) {
    const refusal = publishRefusalError(err)
    if (refusal) throw refusal
    throw err
  }
  return refreshWaFlow(db, input)
}

export async function deprecateWaFlow(
  db: SupabaseClient,
  input: { accountId: string; flowId: string },
): Promise<WhatsAppFlow> {
  const local = await loadLocalFlowRow(db, input.accountId, input.flowId)
  if (local.status !== 'PUBLISHED') {
    throw new FlowLifecycleError('Only published forms can be deprecated.', 409)
  }
  const { accessToken } = await loadFlowConfig(db, input.accountId)
  await meta(() => deprecateFlow({ flowId: local.meta_flow_id, accessToken }))
  return refreshWaFlow(db, input)
}

/**
 * Drafts are deleted on Meta and locally. Published / deprecated forms
 * can't be deleted on Meta — only the local row goes, and only once
 * deprecated, so a live form can't vanish from the picker by accident.
 */
export async function deleteWaFlow(
  db: SupabaseClient,
  input: { accountId: string; flowId: string },
): Promise<void> {
  const local = await loadLocalFlowRow(db, input.accountId, input.flowId)
  if (local.status === 'PUBLISHED') {
    throw new FlowLifecycleError(
      'Deprecate the form before removing it — Meta never deletes a published form.',
      409,
    )
  }
  if (local.status === 'DRAFT') {
    const { accessToken } = await loadFlowConfig(db, input.accountId)
    await meta(() => deleteFlow({ flowId: local.meta_flow_id, accessToken }))
  }
  const { error } = await db
    .from('whatsapp_flows')
    .delete()
    .eq('id', local.id)
    .eq('account_id', input.accountId)
  if (error) throw new FlowLifecycleError(error.message, 500)
}

export async function previewWaFlow(
  db: SupabaseClient,
  input: { accountId: string; flowId: string },
): Promise<{ preview_url: string; expires_at: string | null }> {
  const local = await loadLocalFlowRow(db, input.accountId, input.flowId)
  const { accessToken } = await loadFlowConfig(db, input.accountId)
  return meta(() => getFlowPreviewUrl({ flowId: local.meta_flow_id, accessToken }))
}

/** The screen a navigate send would open — exposed for the UI. */
export function effectiveFirstScreen(flow: Pick<WhatsAppFlow, 'first_screen' | 'flow_json'>): string | null {
  return flow.first_screen || entryScreenOf(flow.flow_json)
}
