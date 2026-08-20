// ============================================================
// Parsing the model's reply-suggestion output.
//
// The prompt asks for one option per line prefixed with "- ". Models
// mostly comply and reliably don't: they number instead of bullet, wrap
// options in quotes, add a "Here are three replies:" preamble, or emit
// blank lines between items. Rather than tighten the prompt forever,
// this is lenient about the shape and strict about the result.
//
// Pure, so the tolerances are testable without spending a token.
// ============================================================

import { MAX_SUGGESTION_LEN, SUGGESTION_COUNT } from './defaults'

/** Bullet, number, or letter used as a list marker at line start. */
const LIST_MARKER = /^\s*(?:[-*•–—]|\(?\d{1,2}[.)]|[a-c][.)])\s+/i

/** Wrapping quotes a model adds when it thinks it is quoting a reply. */
const WRAPPING_QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g

/**
 * Lines that are commentary rather than an option. A leading "Here are
 * three suggestions:" is the common one; it has no marker and ends in a
 * colon, which is a shape no actual WhatsApp reply has.
 */
function isPreamble(line: string): boolean {
  return line.endsWith(':') && line.length < 80
}

/**
 * Turn raw model output into distinct suggestions.
 *
 * Returns at most `max`, in the model's order, with duplicates and
 * anything unusable removed. An empty array is a legitimate outcome —
 * the caller treats "no suggestions" as "show nothing", never as an
 * error worth interrupting the agent for.
 */
export function parseSuggestions(
  raw: string,
  max: number = SUGGESTION_COUNT,
): string[] {
  if (!raw || !raw.trim()) return []

  const out: string[] = []
  // Case-insensitive dedupe: two options differing only in capitalization
  // are the same choice as far as the agent is concerned.
  const seen = new Set<string>()

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const hadMarker = LIST_MARKER.test(line)
    const text = line
      .replace(LIST_MARKER, '')
      .replace(WRAPPING_QUOTES, '')
      .trim()

    if (!text) continue
    // Drop a preamble only when it wasn't itself a list item — "- Sure:
    // here's what I can do" is a real reply that happens to end in a
    // colon at the wrong place.
    if (!hadMarker && isPreamble(text)) continue
    if (text.length > MAX_SUGGESTION_LEN) continue

    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)

    if (out.length >= max) break
  }

  // No markers anywhere and nothing salvaged line-by-line: the model
  // answered with a single paragraph. One usable suggestion beats none.
  if (out.length === 0) {
    const whole = raw.trim().replace(WRAPPING_QUOTES, '').trim()
    if (whole && whole.length <= MAX_SUGGESTION_LEN) return [whole]
  }

  return out
}
