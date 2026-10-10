/**
 * AI form builder — turns "describe the form you want" into WhatsApp
 * Flow JSON, using the account's own AI provider (Settings → AI).
 *
 * Correctness comes from a loop, not from trusting the model:
 *
 *   1. The model gets a compact Flow JSON reference (components, limits,
 *      how data moves between screens) and must answer with one JSON
 *      object: { name, categories, flow }.
 *   2. The answer is parsed and run through `lintFlowJson`. Any errors
 *      go back to the model verbatim, and it gets up to
 *      `MAX_REPAIR_ROUNDS` tries to fix them.
 *   3. Meta still validates on save. Its `validation_errors` can be fed
 *      back through the same function (`metaErrors`) — "Fix with AI".
 *
 * Also used to edit: pass `currentJson` plus an instruction ("add a
 * phone number field") and/or Meta's errors.
 */

import { generateReply } from '@/lib/ai/generate'
import type { AiConfig, AiUsage, ChatMessage } from '@/lib/ai/types'
import { AiError } from '@/lib/ai/types'
import { WHATSAPP_FLOW_CATEGORIES } from '@/types'
import { lintErrors, lintFlowJson, type FlowLintIssue } from './lint'

/** Flow JSON is long; a chat-sized cap truncates it mid-object. */
export const FORM_BUILDER_MAX_OUTPUT_TOKENS = 8000
/** Large structured generations take longer than a chat reply. */
export const FORM_BUILDER_TIMEOUT_MS = 90_000
/** Lint-driven repair attempts after the first generation. */
export const MAX_REPAIR_ROUNDS = 2
/** Used when the account has no Meta-accepted form to copy a version from. */
export const DEFAULT_FLOW_JSON_VERSION = '7.0'

export function buildFormBuilderPrompt(version: string): string {
  return `You design WhatsApp Flows ("WhatsApp Forms"): native multi-screen forms that open inside WhatsApp. You write Meta's Flow JSON.

Answer with ONE JSON object and nothing else — no prose, no markdown fences:
{"name": "<short form name>", "categories": [<one or more of ${WHATSAPP_FLOW_CATEGORIES.map((c) => `"${c}"`).join(', ')}>], "flow": <the Flow JSON>}

FLOW JSON RULES
- Root: {"version": "${version}", "screens": [...]}. Do NOT add "routing_model" or "data_api_version" — these forms have no server endpoint, so never use the "data_exchange" action.
- Screen: {"id": "UPPER_SNAKE_CASE letters/underscores only, never SUCCESS", "title": "...", "terminal": true|false, "data": {...}, "layout": {"type": "SingleColumnLayout", "children": [...]}}. Screen ids are unique. The FIRST screen in the array is where the form opens.
- Exactly one Footer per screen, as the LAST child. Every non-terminal screen's Footer navigates on; the last screen is "terminal": true and its Footer completes the form. "complete" is ONLY allowed on a terminal screen.
- Keep forms short: 1–3 screens, at most ~8 inputs per screen. Group related questions.

COMPONENTS (put them directly in "children"; do not use a "Form" wrapper)
- Text: {"type": "TextHeading", "text": "≤80 chars"}, {"type": "TextSubheading", "text": "≤80"}, {"type": "TextBody", "text": "..."}, {"type": "TextCaption", "text": "≤409"}
- {"type": "TextInput", "name": "snake_case", "label": "short label", "input-type": "text"|"number"|"email"|"phone"|"password"|"passcode", "required": true|false, "helper-text": "optional"}
- {"type": "TextArea", "name": "...", "label": "...", "required": false}
- {"type": "Dropdown" | "RadioButtonsGroup" | "CheckboxGroup", "name": "...", "label": "...", "required": true, "data-source": [{"id": "snake_case_id", "title": "≤30 chars"}, ...]}  (radio/checkbox ≤ 20 options; checkbox values are arrays of ids)
- {"type": "DatePicker", "name": "...", "label": "...", "required": false}
- {"type": "OptIn", "name": "...", "label": "I agree to ...", "required": true}
- {"type": "Footer", "label": "≤35 chars", "on-click-action": <action>}
Input "name"s are unique within a screen: letters, digits, underscores. Keep labels short (about 20 characters for TextInput/TextArea).

ACTIONS
- Go to the next screen, carrying answers forward:
  {"name": "navigate", "next": {"type": "screen", "name": "NEXT_ID"}, "payload": {"email": "\${form.email}"}}
  The NEXT screen must declare each payload key in its "data":
  "data": {"email": {"type": "string", "__example__": "ada@example.com"}}
  (types: "string", "number", "boolean", "array" — an array also needs "items": {"type": "string"}; CheckboxGroup answers are arrays.)
- Finish the form (terminal screen only):
  {"name": "complete", "payload": { ...EVERY answer from EVERY screen... }}
  On the terminal screen, answers from earlier screens are "\${data.<key>}" (declared in its "data"); answers on this screen are "\${form.<name>}".
- "\${form.x}" may only name an input on the SAME screen. "\${data.x}" may only name a key declared in that screen's "data".
The "complete" payload is what the business receives — use clear snake_case keys (e.g. "full_name", "email", "phone"), and include every field the user asked to collect.

STYLE
- Friendly, concise copy in the language the description is written in.
- Use the right input type: email → TextInput "email", phone → "phone", choices → RadioButtonsGroup (one) or CheckboxGroup (many), dates → DatePicker, consent → OptIn.
- Mark fields required only when the description implies it, but always require the key identifier (e.g. name or email) a business needs.

EXAMPLE (two screens)
{"name": "Callback request", "categories": ["CONTACT_US"], "flow": {"version": "${version}", "screens": [
 {"id": "DETAILS", "title": "Your details", "data": {}, "layout": {"type": "SingleColumnLayout", "children": [
  {"type": "TextInput", "name": "full_name", "label": "Full name", "input-type": "text", "required": true},
  {"type": "TextInput", "name": "phone", "label": "Phone", "input-type": "phone", "required": true},
  {"type": "Footer", "label": "Continue", "on-click-action": {"name": "navigate", "next": {"type": "screen", "name": "TIME"}, "payload": {"full_name": "\${form.full_name}", "phone": "\${form.phone}"}}}]}},
 {"id": "TIME", "title": "Best time", "terminal": true, "data": {"full_name": {"type": "string", "__example__": "Ada"}, "phone": {"type": "string", "__example__": "+2348000000000"}}, "layout": {"type": "SingleColumnLayout", "children": [
  {"type": "RadioButtonsGroup", "name": "slot", "label": "When should we call?", "required": true, "data-source": [{"id": "morning", "title": "Morning"}, {"id": "afternoon", "title": "Afternoon"}]},
  {"type": "Footer", "label": "Request callback", "on-click-action": {"name": "complete", "payload": {"full_name": "\${data.full_name}", "phone": "\${data.phone}", "slot": "\${form.slot}"}}}]}}]}}`
}

/** Pull the first JSON object out of a model reply (tolerates fences / chatter). */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('The reply contained no JSON object.')
  }
  return JSON.parse(candidate.slice(start, end + 1))
}

export interface ParsedBuilderAnswer {
  name: string | null
  categories: string[]
  flow: Record<string, unknown>
}

/**
 * Accept `{ name, categories, flow }` — or a bare Flow JSON, which some
 * models return when editing. Throws with a message the model can act on.
 */
export function parseBuilderAnswer(raw: unknown, version: string): ParsedBuilderAnswer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Answer must be a JSON object.')
  }
  const obj = raw as Record<string, unknown>
  const flow =
    obj.flow && typeof obj.flow === 'object' && !Array.isArray(obj.flow)
      ? (obj.flow as Record<string, unknown>)
      : Array.isArray(obj.screens)
        ? obj
        : null
  if (!flow) throw new Error('Answer has no "flow" object with "screens".')
  // The version is ours to choose, not the model's: pin it.
  flow.version = version
  const categories = Array.isArray(obj.categories)
    ? obj.categories.filter(
        (c): c is string =>
          typeof c === 'string' && (WHATSAPP_FLOW_CATEGORIES as readonly string[]).includes(c),
      )
    : []
  return {
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 200) : null,
    categories: [...new Set(categories)],
    flow,
  }
}

function formatIssues(issues: { path?: string; message: string }[]): string {
  return issues.map((i) => `- ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n')
}

export interface FormBuilderInput {
  config: AiConfig
  /** What the user wants — a new form, or a change to `currentJson`. */
  instruction: string
  /** Edit mode: the definition to change. */
  currentJson?: Record<string, unknown> | null
  /** Meta's `validation_errors` for `currentJson`, to fix. */
  metaErrors?: { message: string; line_start?: number; error?: string }[]
  version: string
}

export interface FormBuilderResult {
  name: string | null
  categories: string[]
  flowJson: Record<string, unknown>
  /** Remaining lint issues (warnings, or errors the model couldn't fix). */
  issues: FlowLintIssue[]
  attempts: number
  usage: AiUsage | null
}

function addUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

function firstUserMessage(input: FormBuilderInput): string {
  const parts: string[] = []
  if (input.currentJson) {
    parts.push(
      'Here is the current form definition:',
      JSON.stringify(input.currentJson),
    )
    if (input.metaErrors?.length) {
      parts.push(
        "Meta's validator rejected it with these errors — fix every one of them:",
        formatIssues(
          input.metaErrors.map((e) => ({
            message: `${e.message}${e.error ? ` (${e.error})` : ''}${
              e.line_start !== undefined ? ` [line ${e.line_start}]` : ''
            }`,
          })),
        ),
      )
    }
    parts.push(
      input.instruction.trim()
        ? `Change it as follows: ${input.instruction.trim()}`
        : 'Return the corrected form.',
      'Keep everything else the same. Answer with the full {"name","categories","flow"} object.',
    )
  } else {
    parts.push(`Create a WhatsApp form for this: ${input.instruction.trim()}`)
  }
  return parts.join('\n\n')
}

/**
 * Generate (or revise) a form definition, repairing lint errors with
 * the model until it is clean or the rounds run out. Throws `AiError`
 * for provider failures; a still-invalid result is returned with its
 * issues rather than thrown, so the user can see and fix it.
 */
export async function buildFormWithAi(input: FormBuilderInput): Promise<FormBuilderResult> {
  if (!input.instruction.trim() && !input.metaErrors?.length) {
    throw new AiError('Describe the form you want.', { code: 'bad_request', status: 400 })
  }
  const systemPrompt = buildFormBuilderPrompt(input.version)
  const messages: ChatMessage[] = [{ role: 'user', content: firstUserMessage(input) }]
  let usage: AiUsage | null = null
  let best: { parsed: ParsedBuilderAnswer; issues: FlowLintIssue[] } | null = null

  for (let attempt = 1; attempt <= MAX_REPAIR_ROUNDS + 1; attempt++) {
    const reply = await generateReply({
      config: input.config,
      systemPrompt,
      messages,
      maxOutputTokens: FORM_BUILDER_MAX_OUTPUT_TOKENS,
      timeoutMs: FORM_BUILDER_TIMEOUT_MS,
    })
    usage = addUsage(usage, reply.usage)
    messages.push({ role: 'assistant', content: reply.text })

    let parsed: ParsedBuilderAnswer
    try {
      parsed = parseBuilderAnswer(extractJsonObject(reply.text), input.version)
    } catch (e) {
      messages.push({
        role: 'user',
        content: `That answer couldn't be used: ${e instanceof Error ? e.message : String(e)}. Reply with only the JSON object {"name","categories","flow"}.`,
      })
      continue
    }

    const issues = lintFlowJson(parsed.flow)
    const errors = lintErrors(issues)
    if (!best || errors.length < lintErrors(best.issues).length) best = { parsed, issues }
    if (errors.length === 0) {
      return {
        name: parsed.name,
        categories: parsed.categories,
        flowJson: parsed.flow,
        issues,
        attempts: attempt,
        usage,
      }
    }
    messages.push({
      role: 'user',
      content: `The form has these problems:\n${formatIssues(errors)}\n\nFix all of them and answer with the full corrected {"name","categories","flow"} object.`,
    })
  }

  if (!best) {
    throw new AiError(
      'The AI did not return a usable form definition. Try rephrasing the description, or a stronger model.',
      { code: 'unusable_output', status: 422 },
    )
  }
  return {
    name: best.parsed.name,
    categories: best.parsed.categories,
    flowJson: best.parsed.flow,
    issues: best.issues,
    attempts: MAX_REPAIR_ROUNDS + 1,
    usage,
  }
}

/**
 * The Flow JSON version to generate: the newest one Meta has already
 * accepted for this account (any synced form), else the default. Meta
 * retires old versions and adds new ones; copying a version it just
 * accepted is the safest guess without an API that lists them.
 */
export function pickFlowJsonVersion(known: (string | null | undefined)[]): string {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const valid = known.filter((v): v is string => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v))
  if (valid.length === 0) return DEFAULT_FLOW_JSON_VERSION
  return valid.sort((a, b) => {
    const [pa, pb] = [parse(a), parse(b)]
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  })[0]
}
