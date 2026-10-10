/**
 * Pure helpers over a WhatsApp Flow JSON definition and its
 * submissions. No I/O — shared by the send path, the webhook, the
 * chatbot engine and the settings UI.
 *
 *   Flow JSON reference:
 *   https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson
 */

interface FlowScreen {
  id?: unknown
  title?: unknown
  terminal?: unknown
  layout?: unknown
}

function screensOf(flowJson: unknown): FlowScreen[] {
  if (!flowJson || typeof flowJson !== 'object') return []
  const screens = (flowJson as { screens?: unknown }).screens
  return Array.isArray(screens)
    ? screens.filter((s): s is FlowScreen => !!s && typeof s === 'object')
    : []
}

/** Screen ids in definition order. */
export function listScreenIds(flowJson: unknown): string[] {
  return screensOf(flowJson)
    .map((s) => (typeof s.id === 'string' ? s.id : null))
    .filter((id): id is string => !!id)
}

/**
 * The screen a `navigate` send should open.
 *
 * With a `routing_model` (required for data-exchange flows, optional
 * otherwise) the entry is the screen no other screen routes to. Without
 * one, Meta treats the first screen in `screens` as the entry.
 */
export function entryScreenOf(flowJson: unknown): string | null {
  const ids = listScreenIds(flowJson)
  if (ids.length === 0) return null
  const routing = (flowJson as { routing_model?: unknown }).routing_model
  if (routing && typeof routing === 'object' && !Array.isArray(routing)) {
    const targets = new Set<string>()
    for (const next of Object.values(routing as Record<string, unknown>)) {
      if (Array.isArray(next)) {
        for (const t of next) if (typeof t === 'string') targets.add(t)
      }
    }
    const entry = ids.find((id) => !targets.has(id))
    if (entry) return entry
  }
  return ids[0]
}

/**
 * Every input `name` in the definition — the keys a submission can
 * carry. Walks layouts recursively (Forms nest children; If / Switch
 * nest branches). Drives the field-mapping picker in settings.
 */
export function listFieldNames(flowJson: unknown): string[] {
  const out = new Set<string>()
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    // Inputs carry a `name`; layouts / screens don't. `Form` also has a
    // name (its own) — exclude containers by type.
    if (
      typeof obj.name === 'string' &&
      typeof obj.type === 'string' &&
      obj.type !== 'Form'
    ) {
      out.add(obj.name)
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') visit(value)
    }
  }
  for (const screen of screensOf(flowJson)) visit(screen.layout)
  return [...out]
}

// ------------------------------------------------------------
// Submissions (webhook `nfm_reply`)
// ------------------------------------------------------------

export interface ParsedFlowSubmission {
  /** The token we minted at send time; null when Meta sent "unused". */
  flowToken: string | null
  /** Submitted fields — `flow_token` removed. */
  fields: Record<string, unknown>
}

/**
 * Parse `interactive.nfm_reply.response_json`. Meta sends it as a JSON
 * *string*; a malformed one yields empty fields rather than throwing so
 * the inbound message is still recorded.
 */
export function parseFlowSubmission(responseJson: unknown): ParsedFlowSubmission {
  let parsed: unknown = responseJson
  if (typeof responseJson === 'string') {
    try {
      parsed = JSON.parse(responseJson)
    } catch {
      parsed = null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { flowToken: null, fields: {} }
  }
  const { flow_token, ...fields } = parsed as Record<string, unknown>
  const token =
    typeof flow_token === 'string' && flow_token && flow_token !== 'unused'
      ? flow_token
      : null
  return { flowToken: token, fields }
}

/** Render one submitted value as display text. */
export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(formatFieldValue).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Turn a field key (`first_name`, `firstName`) into a label. */
export function humanizeFieldName(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key
}

/**
 * One-line summary for `content_text` / `last_message_text`:
 * "Form submitted: Sign up — Name: Ada, Email: ada@example.com".
 * Long submissions are truncated so the conversation list stays tidy.
 */
export function summarizeSubmission(
  flowName: string | null,
  fields: Record<string, unknown>,
  maxLength = 280,
): string {
  const head = flowName ? `Form submitted: ${flowName}` : 'Form submitted'
  const parts = Object.entries(fields)
    .map(([k, v]) => [k, formatFieldValue(v)] as const)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${humanizeFieldName(k)}: ${v}`)
  const full = parts.length ? `${head} — ${parts.join(', ')}` : head
  return full.length > maxLength ? `${full.slice(0, maxLength - 1)}…` : full
}

/**
 * Submitted fields as flat string vars for automations / chatbot
 * interpolation (`{{vars.email}}`). Keys outside `[A-Za-z0-9_]` are
 * normalised so the `{{ \w+ }}` interpolation syntax can reach them;
 * `prefix` namespaces them (`signup_email`).
 */
export function submissionVars(
  fields: Record<string, unknown>,
  prefix?: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    const safe = key.replace(/[^A-Za-z0-9_]/g, '_')
    if (!safe) continue
    out[prefix ? `${prefix}_${safe}` : safe] = formatFieldValue(value)
  }
  return out
}
