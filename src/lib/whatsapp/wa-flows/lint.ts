/**
 * Structural linter for WhatsApp Flow JSON — pure, no I/O.
 *
 * Catches the mistakes that make Meta reject a definition (or accept it
 * and render a broken form) before it leaves the app: unknown
 * components, duplicate / malformed ids and names, dead-end screens,
 * navigation to screens that don't exist, `${form.x}` / `${data.x}`
 * references to nothing, a `complete` action off a terminal screen,
 * more than one Footer, routing models that disagree with the actions.
 *
 * It is deliberately a subset of Meta's validator, not a replacement:
 * Meta has the last word (its `validation_errors` come back on every
 * save). The AI form builder uses this to repair its own output before
 * the user ever sees it; anything Meta still objects to goes through
 * "Fix with AI" with Meta's errors verbatim.
 *
 *   https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson
 *   https://developers.facebook.com/docs/whatsapp/flows/reference/components
 */

export interface FlowLintIssue {
  severity: 'error' | 'warning'
  /** Where, e.g. `screens[1].layout.children[2]` or a screen id. */
  path: string
  message: string
}

/** Inputs — carry a `name` and show up in `${form.<name>}` + submissions. */
const INPUT_TYPES = new Set([
  'TextInput',
  'TextArea',
  'CheckboxGroup',
  'RadioButtonsGroup',
  'Dropdown',
  'DatePicker',
  'CalendarPicker',
  'OptIn',
  'ChipsSelector',
  'PhotoPicker',
  'DocumentPicker',
])

/** Components that take a static `data-source` list (or a ${data.x}). */
const DATA_SOURCE_TYPES = new Set([
  'CheckboxGroup',
  'RadioButtonsGroup',
  'Dropdown',
  'ChipsSelector',
])

const KNOWN_TYPES = new Set([
  ...INPUT_TYPES,
  'Form',
  'TextHeading',
  'TextSubheading',
  'TextBody',
  'TextCaption',
  'RichText',
  'Footer',
  'EmbeddedLink',
  'Image',
  'If',
  'Switch',
  'NavigationList',
])

const ACTIONS = new Set(['navigate', 'complete', 'data_exchange', 'update_data', 'open_url'])

/** Meta's documented character caps — errors past these. */
const TEXT_LIMITS: Record<string, { field: string; max: number }[]> = {
  TextHeading: [{ field: 'text', max: 80 }],
  TextSubheading: [{ field: 'text', max: 80 }],
  TextBody: [{ field: 'text', max: 4096 }],
  TextCaption: [{ field: 'text', max: 409 }],
  Footer: [{ field: 'label', max: 35 }],
  EmbeddedLink: [{ field: 'text', max: 25 }],
}

const SCREEN_ID_RE = /^[A-Za-z][A-Za-z_]*$/
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const REF_RE = /\$\{(form|data)\.([A-Za-z0-9_]+)\}/g
const MAX_COMPONENTS_PER_SCREEN = 50
const WHOLE_REF_RE = /^\$\{(form|data)\.([A-Za-z0-9_]+)\}$/

/**
 * The runtime type an input's value has. Every text-ish input yields a
 * string — a TextInput with "input-type": "number" included — so a
 * `data` key declared "number" for it fails on the phone ("Something
 * went wrong") although Meta's validator accepts the definition.
 */
function inputValueType(componentType: string): string {
  if (componentType === 'OptIn') return 'boolean'
  if (['CheckboxGroup', 'ChipsSelector', 'PhotoPicker', 'DocumentPicker'].includes(componentType)) {
    return 'array'
  }
  return 'string'
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

interface Action {
  name: string
  next?: string
  payload?: Obj
  path: string
}

interface ScreenFacts {
  id: string
  index: number
  terminal: boolean
  /** Input name → component type. */
  inputs: Map<string, string>
  /** Declared `data` key → its declared type. */
  declaredData: Map<string, unknown>
  footers: number
  actions: Action[]
  refs: { kind: 'form' | 'data'; key: string; path: string }[]
  componentCount: number
}

/** Collect every `${form.x}` / `${data.x}` inside a value. */
function collectRefs(value: unknown, path: string, out: ScreenFacts['refs']) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(REF_RE)) {
      out.push({ kind: m[1] as 'form' | 'data', key: m[2], path })
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectRefs(v, `${path}[${i}]`, out))
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) collectRefs(v, `${path}.${k}`, out)
  }
}

function readAction(raw: unknown, path: string, issues: FlowLintIssue[]): Action | null {
  if (!isObj(raw)) {
    issues.push({ severity: 'error', path, message: 'on-click-action must be an object.' })
    return null
  }
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!ACTIONS.has(name)) {
    issues.push({
      severity: 'error',
      path,
      message: `Unknown action "${name}". Use navigate, complete, data_exchange, update_data or open_url.`,
    })
    return null
  }
  const action: Action = { name, path }
  if (raw.payload !== undefined) {
    if (!isObj(raw.payload)) {
      issues.push({ severity: 'error', path: `${path}.payload`, message: 'payload must be an object.' })
    } else {
      action.payload = raw.payload
    }
  }
  if (name === 'navigate') {
    const next = raw.next
    if (!isObj(next) || next.type !== 'screen' || typeof next.name !== 'string' || !next.name) {
      issues.push({
        severity: 'error',
        path: `${path}.next`,
        message: 'navigate needs "next": { "type": "screen", "name": "<SCREEN_ID>" }.',
      })
    } else {
      action.next = next.name
    }
  }
  return action
}

function walkComponents(
  children: unknown,
  path: string,
  facts: ScreenFacts,
  issues: FlowLintIssue[],
) {
  if (!Array.isArray(children)) {
    issues.push({ severity: 'error', path, message: 'children must be an array.' })
    return
  }
  children.forEach((child, i) => {
    const p = `${path}[${i}]`
    if (!isObj(child)) {
      issues.push({ severity: 'error', path: p, message: 'Component must be an object.' })
      return
    }
    facts.componentCount++
    const type = typeof child.type === 'string' ? child.type : ''
    if (!KNOWN_TYPES.has(type)) {
      issues.push({ severity: 'error', path: p, message: `Unknown component type "${type}".` })
      return
    }

    for (const { field, max } of TEXT_LIMITS[type] ?? []) {
      const v = child[field]
      if (typeof v === 'string' && !v.includes('${') && v.length > max) {
        issues.push({
          severity: 'error',
          path: `${p}.${field}`,
          message: `${type} ${field} is ${v.length} characters; Meta allows ${max}.`,
        })
      }
    }

    if (INPUT_TYPES.has(type)) {
      const name = child.name
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        issues.push({
          severity: 'error',
          path: `${p}.name`,
          message: `${type} needs a "name" of letters, digits and underscores.`,
        })
      } else if (facts.inputs.has(name)) {
        issues.push({
          severity: 'error',
          path: `${p}.name`,
          message: `Duplicate input name "${name}" on screen ${facts.id}.`,
        })
      } else {
        facts.inputs.set(name, type)
      }
      if (type !== 'OptIn' && (typeof child.label !== 'string' || !child.label.trim())) {
        issues.push({ severity: 'error', path: `${p}.label`, message: `${type} needs a "label".` })
      }
      if (type === 'OptIn' && (typeof child.label !== 'string' || !child.label.trim())) {
        issues.push({ severity: 'error', path: `${p}.label`, message: 'OptIn needs a "label".' })
      }
    }

    if (DATA_SOURCE_TYPES.has(type)) {
      const ds = child['data-source']
      if (typeof ds === 'string') {
        // Dynamic list from screen data — checked as a reference below.
      } else if (!Array.isArray(ds) || ds.length === 0) {
        issues.push({
          severity: 'error',
          path: `${p}.data-source`,
          message: `${type} needs a non-empty "data-source" of { "id", "title" } options.`,
        })
      } else {
        const ids = new Set<string>()
        ds.forEach((opt, j) => {
          const op = `${p}.data-source[${j}]`
          if (!isObj(opt) || typeof opt.id !== 'string' || !opt.id) {
            issues.push({ severity: 'error', path: op, message: 'Option needs a string "id".' })
            return
          }
          if (ids.has(opt.id)) {
            issues.push({ severity: 'error', path: op, message: `Duplicate option id "${opt.id}".` })
          }
          ids.add(opt.id)
          if (typeof opt.title !== 'string' || !opt.title.trim()) {
            issues.push({ severity: 'error', path: op, message: 'Option needs a "title".' })
          } else if (opt.title.length > 30) {
            issues.push({
              severity: 'error',
              path: `${op}.title`,
              message: `Option title is ${opt.title.length} characters; Meta allows 30.`,
            })
          }
        })
      }
    }

    if (type === 'Footer') {
      facts.footers++
      if (typeof child.label !== 'string' || !child.label.trim()) {
        issues.push({ severity: 'error', path: `${p}.label`, message: 'Footer needs a "label".' })
      }
      if (child['on-click-action'] === undefined) {
        issues.push({ severity: 'error', path: p, message: 'Footer needs an "on-click-action".' })
      }
    }

    for (const key of ['on-click-action', 'on-select-action', 'on-unselect-action']) {
      if (child[key] !== undefined) {
        const action = readAction(child[key], `${p}.${key}`, issues)
        if (action) facts.actions.push(action)
      }
    }

    // Containers.
    if (type === 'Form') walkComponents(child.children, `${p}.children`, facts, issues)
    if (type === 'If') {
      if (child.then !== undefined) walkComponents(child.then, `${p}.then`, facts, issues)
      if (child.else !== undefined) walkComponents(child.else, `${p}.else`, facts, issues)
    }
    if (type === 'Switch' && isObj(child.cases)) {
      for (const [k, v] of Object.entries(child.cases)) {
        walkComponents(v, `${p}.cases.${k}`, facts, issues)
      }
    }
  })
}

/**
 * Lint a Flow JSON definition. Returns every issue found; the
 * definition is fit to send to Meta when none has severity `error`.
 */
export function lintFlowJson(flowJson: unknown): FlowLintIssue[] {
  const issues: FlowLintIssue[] = []
  if (!isObj(flowJson)) {
    return [{ severity: 'error', path: '$', message: 'Flow JSON must be an object.' }]
  }
  if (typeof flowJson.version !== 'string' || !flowJson.version) {
    issues.push({ severity: 'error', path: 'version', message: 'Missing "version".' })
  }
  if (!Array.isArray(flowJson.screens) || flowJson.screens.length === 0) {
    issues.push({ severity: 'error', path: 'screens', message: 'Needs at least one screen.' })
    return issues
  }

  const facts: ScreenFacts[] = []
  const seen = new Set<string>()
  flowJson.screens.forEach((raw, index) => {
    const path = `screens[${index}]`
    if (!isObj(raw)) {
      issues.push({ severity: 'error', path, message: 'Screen must be an object.' })
      return
    }
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (!SCREEN_ID_RE.test(id)) {
      issues.push({
        severity: 'error',
        path: `${path}.id`,
        message: `Screen id "${id}" must be letters and underscores only (e.g. "CONTACT_DETAILS").`,
      })
    } else if (id === 'SUCCESS') {
      issues.push({ severity: 'error', path: `${path}.id`, message: '"SUCCESS" is a reserved screen id.' })
    } else if (seen.has(id)) {
      issues.push({ severity: 'error', path: `${path}.id`, message: `Duplicate screen id "${id}".` })
    }
    seen.add(id)
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      issues.push({ severity: 'error', path: `${path}.title`, message: `Screen ${id} needs a "title".` })
    }

    const screen: ScreenFacts = {
      id,
      index,
      terminal: raw.terminal === true,
      inputs: new Map(),
      declaredData: new Map(),
      footers: 0,
      actions: [],
      refs: [],
      componentCount: 0,
    }

    if (raw.data !== undefined) {
      if (!isObj(raw.data)) {
        issues.push({ severity: 'error', path: `${path}.data`, message: 'Screen "data" must be an object.' })
      } else {
        for (const [key, decl] of Object.entries(raw.data)) {
          screen.declaredData.set(key, isObj(decl) ? decl.type : undefined)
          if (!isObj(decl) || typeof decl.type !== 'string' || !('__example__' in decl)) {
            issues.push({
              severity: 'error',
              path: `${path}.data.${key}`,
              message: `Screen data "${key}" needs a "type" and an "__example__".`,
            })
          }
        }
      }
    }

    const layout = raw.layout
    if (!isObj(layout) || layout.type !== 'SingleColumnLayout') {
      issues.push({
        severity: 'error',
        path: `${path}.layout`,
        message: 'layout must be { "type": "SingleColumnLayout", "children": [...] }.',
      })
    } else {
      walkComponents(layout.children, `${path}.layout.children`, screen, issues)
      collectRefs(layout, `${path}.layout`, screen.refs)
    }
    facts.push(screen)
  })

  const ids = new Set(facts.map((f) => f.id))
  const usesEndpoint = facts.some((f) => f.actions.some((a) => a.name === 'data_exchange'))
  const routing = isObj(flowJson.routing_model) ? flowJson.routing_model : null

  for (const screen of facts) {
    const path = `screens[${screen.index}] (${screen.id})`
    if (screen.footers > 1) {
      issues.push({ severity: 'error', path, message: 'A screen can have only one Footer.' })
    }
    if (screen.componentCount > MAX_COMPONENTS_PER_SCREEN) {
      issues.push({
        severity: 'warning',
        path,
        message: `${screen.componentCount} components on one screen; Meta allows ${MAX_COMPONENTS_PER_SCREEN}.`,
      })
    }

    const leaves = screen.actions.some((a) =>
      ['navigate', 'complete', 'data_exchange'].includes(a.name),
    )
    if (!screen.terminal && !leaves) {
      issues.push({
        severity: 'error',
        path,
        message:
          'Screen is a dead end — add a Footer that navigates on (or make it terminal with a "complete" Footer).',
      })
    }
    if (screen.terminal && !screen.actions.some((a) => a.name === 'complete' || a.name === 'data_exchange')) {
      issues.push({
        severity: 'error',
        path,
        message: 'Terminal screen must finish the form — its Footer action should be "complete".',
      })
    }

    for (const action of screen.actions) {
      if (action.name === 'complete' && !screen.terminal) {
        issues.push({
          severity: 'error',
          path: action.path,
          message: '"complete" is only allowed on a terminal screen ("terminal": true).',
        })
      }
      if (action.name === 'navigate' && action.next) {
        if (!ids.has(action.next)) {
          issues.push({
            severity: 'error',
            path: action.path,
            message: `navigate goes to "${action.next}", which isn't a screen.`,
          })
        } else if (action.next === screen.id) {
          issues.push({ severity: 'error', path: action.path, message: 'A screen cannot navigate to itself.' })
        } else {
          const target = facts.find((f) => f.id === action.next)!
          for (const key of Object.keys(action.payload ?? {})) {
            if (!target.declaredData.has(key)) {
              issues.push({
                severity: 'error',
                path: `${action.path}.payload.${key}`,
                message: `Passes "${key}" to ${target.id}, which doesn't declare it in its "data".`,
              })
              continue
            }
            const declared = target.declaredData.get(key)
            const ref = String(action.payload?.[key] ?? '').match(WHOLE_REF_RE)
            const sent = !ref
              ? undefined
              : ref[1] === 'form'
                ? screen.inputs.has(ref[2])
                  ? inputValueType(screen.inputs.get(ref[2])!)
                  : undefined
                : screen.declaredData.get(ref[2])
            if (typeof declared === 'string' && typeof sent === 'string' && declared !== sent) {
              issues.push({
                severity: 'error',
                path: `screens[${target.index}].data.${key}`,
                message: `${target.id} declares "${key}" as "${declared}", but ${screen.id} sends a ${sent}. Declare it "${sent}" — the form fails on the phone otherwise.`,
              })
            }
          }
          if (routing) {
            const allowed = routing[screen.id]
            if (!Array.isArray(allowed) || !allowed.includes(action.next)) {
              issues.push({
                severity: 'error',
                path: action.path,
                message: `routing_model doesn't allow ${screen.id} → ${action.next}.`,
              })
            }
          }
        }
      }
    }

    for (const ref of screen.refs) {
      if (ref.kind === 'form' && !screen.inputs.has(ref.key)) {
        issues.push({
          severity: 'error',
          path: ref.path,
          message: `\${form.${ref.key}} — no input named "${ref.key}" on screen ${screen.id}.`,
        })
      }
      if (ref.kind === 'data' && !screen.declaredData.has(ref.key)) {
        issues.push({
          severity: 'error',
          path: ref.path,
          message: `\${data.${ref.key}} — screen ${screen.id} doesn't declare "${ref.key}" in its "data".`,
        })
      }
    }
  }

  if (!facts.some((f) => f.terminal)) {
    issues.push({ severity: 'error', path: 'screens', message: 'At least one screen must be terminal.' })
  }

  if (usesEndpoint) {
    if (!routing) {
      issues.push({
        severity: 'error',
        path: 'routing_model',
        message: 'Forms that use data_exchange need a "routing_model".',
      })
    }
    if (typeof flowJson.data_api_version !== 'string') {
      issues.push({
        severity: 'error',
        path: 'data_api_version',
        message: 'Forms that use data_exchange need "data_api_version": "3.0".',
      })
    }
  }
  if (routing) {
    for (const [from, to] of Object.entries(routing)) {
      if (!ids.has(from)) {
        issues.push({ severity: 'error', path: `routing_model.${from}`, message: `"${from}" isn't a screen.` })
      }
      if (!Array.isArray(to) || to.some((t) => typeof t !== 'string' || !ids.has(t))) {
        issues.push({
          severity: 'error',
          path: `routing_model.${from}`,
          message: 'Routes must be a list of existing screen ids.',
        })
      }
    }
  }

  // Reachability from the first screen (navigate edges only; endpoint
  // routes are invisible here, so this stays a warning).
  if (!usesEndpoint && facts.length > 1) {
    const reached = new Set<string>([facts[0].id])
    const queue = [facts[0]]
    while (queue.length) {
      const s = queue.shift()!
      for (const a of s.actions) {
        if (a.name === 'navigate' && a.next && !reached.has(a.next)) {
          reached.add(a.next)
          const t = facts.find((f) => f.id === a.next)
          if (t) queue.push(t)
        }
      }
    }
    for (const f of facts) {
      if (!reached.has(f.id)) {
        issues.push({
          severity: 'warning',
          path: `screens[${f.index}] (${f.id})`,
          message: 'No screen navigates here — customers can never reach it.',
        })
      }
    }
  }

  return issues
}

export function lintErrors(issues: FlowLintIssue[]): FlowLintIssue[] {
  return issues.filter((i) => i.severity === 'error')
}
