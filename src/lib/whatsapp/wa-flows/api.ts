/**
 * Meta WhatsApp Flows management API — the Graph calls behind the
 * "WhatsApp Forms" settings panel.
 *
 * Kept apart from `meta-api.ts` (the send-side client) because Flows
 * management is a different surface: it targets the WABA and the flow
 * object, never a phone number's /messages edge. The send itself
 * (`sendInteractiveFlow`) lives in `meta-api.ts` beside the other
 * interactive senders.
 *
 * Same conventions as `meta-api.ts`: named-argument objects, every
 * call bounded by `metaFetch`'s timeout, and Meta's field-level error
 * text surfaced through `throwMetaError`.
 *
 *   https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
 */

import { META_API_BASE, metaFetch, throwMetaError } from '../meta-api'

/** Shape of `validation_errors` entries Meta returns for a flow. */
export interface MetaFlowValidationError {
  error: string
  error_type?: string
  message: string
  line_start?: number
  line_end?: number
  column_start?: number
  column_end?: number
  pointers?: unknown[]
}

export interface MetaFlowSummary {
  id: string
  name: string
  status: string
  categories: string[]
  validation_errors?: MetaFlowValidationError[]
}

export interface MetaFlowDetails extends MetaFlowSummary {
  json_version?: string
  data_api_version?: string
  endpoint_uri?: string
  preview?: { preview_url?: string; expires_at?: string }
}

interface AuthArgs {
  accessToken: string
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` }
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    await throwMetaError(response, `${fallback}: ${response.status}`)
  }
  return (await response.json()) as T
}

// ------------------------------------------------------------
// Read
// ------------------------------------------------------------

/** Pages through every flow on the WABA (capped, like template sync). */
export async function listFlows(
  args: AuthArgs & { wabaId: string; pageCap?: number },
): Promise<{ flows: MetaFlowSummary[]; truncated: boolean }> {
  const { wabaId, accessToken, pageCap = 20 } = args
  const flows: MetaFlowSummary[] = []
  let next: string | null =
    `${META_API_BASE}/${wabaId}/flows?limit=100&fields=id,name,status,categories,validation_errors`
  let pages = 0
  while (next && pages < pageCap) {
    pages++
    const response = await metaFetch(next, { headers: authHeaders(accessToken) })
    const body = await readJson<{
      data?: MetaFlowSummary[]
      paging?: { next?: string }
    }>(response, 'Meta API error')
    if (body.data) flows.push(...body.data)
    next = body.paging?.next ?? null
  }
  return { flows, truncated: next !== null }
}

export async function getFlow(
  args: AuthArgs & { flowId: string },
): Promise<MetaFlowDetails> {
  const fields = [
    'id',
    'name',
    'status',
    'categories',
    'validation_errors',
    'json_version',
    'data_api_version',
    'endpoint_uri',
  ].join(',')
  const response = await metaFetch(
    `${META_API_BASE}/${args.flowId}?fields=${fields}`,
    { headers: authHeaders(args.accessToken) },
  )
  return readJson<MetaFlowDetails>(response, 'Meta API error')
}

/**
 * Download the flow's JSON definition. Meta exposes it as an asset
 * with a short-lived `download_url`, not as a field on the flow.
 * Returns null when the flow has no JSON yet (a freshly created draft).
 */
export async function getFlowJson(
  args: AuthArgs & { flowId: string },
): Promise<Record<string, unknown> | null> {
  const response = await metaFetch(`${META_API_BASE}/${args.flowId}/assets`, {
    headers: authHeaders(args.accessToken),
  })
  const body = await readJson<{
    data?: { name?: string; asset_type?: string; download_url?: string }[]
  }>(response, 'Meta API error')
  const asset = (body.data ?? []).find((a) => a.asset_type === 'FLOW_JSON')
  if (!asset?.download_url) return null
  const download = await metaFetch(asset.download_url)
  if (!download.ok) {
    throw new Error(`Could not download the form definition (HTTP ${download.status}).`)
  }
  const parsed: unknown = await download.json()
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

/** A web preview link (valid ~30 days) that renders the form. */
export async function getFlowPreviewUrl(
  args: AuthArgs & { flowId: string; invalidate?: boolean },
): Promise<{ preview_url: string; expires_at: string | null }> {
  const field = `preview.invalidate(${args.invalidate ? 'true' : 'false'})`
  const response = await metaFetch(
    `${META_API_BASE}/${args.flowId}?fields=${encodeURIComponent(field)}`,
    { headers: authHeaders(args.accessToken) },
  )
  const body = await readJson<MetaFlowDetails>(response, 'Meta API error')
  if (!body.preview?.preview_url) {
    throw new Error('Meta returned no preview link for this form.')
  }
  return {
    preview_url: body.preview.preview_url,
    expires_at: body.preview.expires_at ?? null,
  }
}

// ------------------------------------------------------------
// Write
// ------------------------------------------------------------

export interface CreateFlowArgs extends AuthArgs {
  wabaId: string
  name: string
  categories: string[]
  /** Optional definition — omitted creates an empty draft. */
  flowJson?: Record<string, unknown>
  /** Publish in the same call (only if the JSON is valid). */
  publish?: boolean
  endpointUri?: string
}

export interface CreateFlowResult {
  id: string
  validation_errors: MetaFlowValidationError[]
}

export async function createFlow(args: CreateFlowArgs): Promise<CreateFlowResult> {
  const payload: Record<string, unknown> = {
    name: args.name,
    categories: args.categories,
  }
  if (args.flowJson) payload.flow_json = JSON.stringify(args.flowJson)
  if (args.publish) payload.publish = true
  if (args.endpointUri) payload.endpoint_uri = args.endpointUri
  const response = await metaFetch(`${META_API_BASE}/${args.wabaId}/flows`, {
    method: 'POST',
    headers: { ...authHeaders(args.accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await readJson<{
    id?: string
    validation_errors?: MetaFlowValidationError[]
  }>(response, 'Meta API error')
  if (!body.id) throw new Error('Meta accepted the form but returned no id.')
  return { id: String(body.id), validation_errors: body.validation_errors ?? [] }
}

/** Rename, re-categorise or re-point the data endpoint. */
export async function updateFlowMetadata(
  args: AuthArgs & {
    flowId: string
    name?: string
    categories?: string[]
    endpointUri?: string
  },
): Promise<void> {
  const payload: Record<string, unknown> = {}
  if (args.name !== undefined) payload.name = args.name
  if (args.categories !== undefined) payload.categories = args.categories
  if (args.endpointUri !== undefined) payload.endpoint_uri = args.endpointUri
  if (Object.keys(payload).length === 0) return
  const response = await metaFetch(`${META_API_BASE}/${args.flowId}`, {
    method: 'POST',
    headers: { ...authHeaders(args.accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  await readJson(response, 'Meta API error')
}

/**
 * Replace the flow's JSON definition (DRAFT flows only — a published
 * flow is immutable; clone it instead). Meta validates on upload and
 * answers 200 with `validation_errors` for a structurally-wrong JSON,
 * so a successful call can still leave the flow unpublishable.
 */
export async function updateFlowJson(
  args: AuthArgs & { flowId: string; flowJson: Record<string, unknown> },
): Promise<{ validation_errors: MetaFlowValidationError[] }> {
  const form = new FormData()
  form.append(
    'file',
    new Blob([JSON.stringify(args.flowJson)], { type: 'application/json' }),
    'flow.json',
  )
  form.append('name', 'flow.json')
  form.append('asset_type', 'FLOW_JSON')
  const response = await metaFetch(`${META_API_BASE}/${args.flowId}/assets`, {
    method: 'POST',
    headers: authHeaders(args.accessToken),
    body: form,
  })
  const body = await readJson<{ validation_errors?: MetaFlowValidationError[] }>(
    response,
    'Meta API error',
  )
  return { validation_errors: body.validation_errors ?? [] }
}

async function postFlowAction(
  args: AuthArgs & { flowId: string },
  action: 'publish' | 'deprecate',
): Promise<void> {
  const response = await metaFetch(`${META_API_BASE}/${args.flowId}/${action}`, {
    method: 'POST',
    headers: authHeaders(args.accessToken),
  })
  await readJson(response, 'Meta API error')
}

/** DRAFT → PUBLISHED. Irreversible: a published flow can't be edited. */
export function publishFlow(args: AuthArgs & { flowId: string }): Promise<void> {
  return postFlowAction(args, 'publish')
}

/** PUBLISHED → DEPRECATED. Stops new sends; existing messages still open. */
export function deprecateFlow(args: AuthArgs & { flowId: string }): Promise<void> {
  return postFlowAction(args, 'deprecate')
}

/** Delete a DRAFT flow. Meta refuses for any other status. 404 = gone. */
export async function deleteFlow(args: AuthArgs & { flowId: string }): Promise<void> {
  const response = await metaFetch(`${META_API_BASE}/${args.flowId}`, {
    method: 'DELETE',
    headers: authHeaders(args.accessToken),
  })
  if (response.status === 404) return
  await readJson(response, 'Meta API error')
}

// ------------------------------------------------------------
// Data-exchange endpoint encryption key
// ------------------------------------------------------------

/**
 * Register the business public key Meta encrypts endpoint requests
 * with. Keyed to the phone number, not the WABA.
 *
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/reference/whatsapp-business-encryption
 */
export async function setBusinessPublicKey(
  args: AuthArgs & { phoneNumberId: string; publicKeyPem: string },
): Promise<void> {
  const response = await metaFetch(
    `${META_API_BASE}/${args.phoneNumberId}/whatsapp_business_encryption`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(args.accessToken),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ business_public_key: args.publicKeyPem }).toString(),
    },
  )
  await readJson(response, 'Meta API error')
}

export async function getBusinessPublicKey(
  args: AuthArgs & { phoneNumberId: string },
): Promise<{ business_public_key: string | null; signature_status: string | null }> {
  const response = await metaFetch(
    `${META_API_BASE}/${args.phoneNumberId}/whatsapp_business_encryption`,
    { headers: authHeaders(args.accessToken) },
  )
  const body = await readJson<{
    data?: {
      business_public_key?: string
      business_public_key_signature_status?: string
    }[]
  }>(response, 'Meta API error')
  const entry = body.data?.[0]
  return {
    business_public_key: entry?.business_public_key ?? null,
    signature_status: entry?.business_public_key_signature_status ?? null,
  }
}
