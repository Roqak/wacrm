// ============================================================
// Where an AI provider call is allowed to point.
//
// Every other provider in this codebase has a hardcoded endpoint. A
// self-hosted Ollama does not — the account types its address in, and
// the server fetches it on every draft and auto-reply. That makes this
// column an SSRF sink: an account admin who can set it to
// `http://169.254.169.254/...` or an internal service is making our
// server issue requests it otherwise couldn't, and (via the model's
// reply and our error messages) can see some of what came back.
//
// The webhook layer solves the same problem by refusing every private
// address outright (`src/lib/webhooks/ssrf.ts`). That answer doesn't
// transfer: a local Ollama is *supposed* to be at `localhost:11434` or
// `http://ollama:11434` in docker-compose. Refusing private addresses
// would refuse the entire feature.
//
// So the rule is: private and loopback addresses are allowed only when
// the operator opts in with AI_ALLOW_PRIVATE_BASE_URL, which is off by
// default. A single-tenant self-host sets it once and points at
// localhost. A deployment hosting accounts it doesn't control leaves it
// alone, and its admins can still use a publicly-reachable Ollama over
// TLS. The decision belongs to whoever runs the server, not to whoever
// signed up on it.
//
// Residual risk, inherited from the webhook guard: this does not defend
// against DNS rebinding. A hostname that resolves publicly at save time
// can resolve privately at connect time, because fetch gives no way to
// pin the resolved address into the socket.
// ============================================================

import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { AiError, type AiProvider } from '../types'
import { OLLAMA_CLOUD_BASE_URL, OLLAMA_DEFAULT_BASE_URL } from '../defaults'

/** True when the operator has opted into private/loopback endpoints. */
export function privateBaseUrlAllowed(): boolean {
  const raw = (process.env.AI_ALLOW_PRIVATE_BASE_URL ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Parse and shape-check a user-supplied base URL. Returns the
 * normalized origin (no trailing slash, no path) or throws `AiError`.
 *
 * Reachability is NOT checked here — see `assertBaseUrlAllowed`, which
 * needs a DNS lookup and so has to be async. This half is pure, which
 * keeps it testable without a resolver.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new AiError('A server URL is required for a self-hosted Ollama.', {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new AiError(
      `"${trimmed}" is not a valid URL. Use the full origin, e.g. ${OLLAMA_DEFAULT_BASE_URL}.`,
      { code: 'invalid_base_url', status: 400 },
    )
  }

  // Anything but http/https would let the fetch reach a different
  // subsystem entirely (file:, and in some runtimes unix: sockets).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiError('The server URL must start with http:// or https://.', {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  // Keep the origin only. A stored path would be silently prefixed onto
  // every request path we build, which is both surprising and a way to
  // aim the call somewhere unintended.
  return url.origin
}

/**
 * Reject a base URL the operator hasn't allowed. Async because
 * deciding "is this private" means resolving the hostname.
 *
 * Call this on save AND before use. Save-time alone is not enough: the
 * env flag can be turned off after a row was written, and a hostname's
 * addresses can change under a stored value.
 */
export async function assertBaseUrlAllowed(origin: string): Promise<void> {
  if (privateBaseUrlAllowed()) return
  if (await isDeliverableUrl(origin)) return

  throw new AiError(
    `${origin} resolves to a private or loopback address. Set AI_ALLOW_PRIVATE_BASE_URL=true on the server to allow it — do that only if you trust everyone who can administer an account here, since it lets them point the AI agent at services on your internal network.`,
    { code: 'base_url_not_allowed', status: 400 },
  )
}

/**
 * The origin a provider's requests go to. Hosted providers ignore the
 * stored column entirely — that is the point of the switch statement
 * rather than `config.baseUrl ?? DEFAULT`, which would let a database
 * value redirect an OpenAI or Ollama Cloud call.
 */
export function resolveBaseUrl(
  provider: AiProvider,
  configured: string | null,
): string | null {
  switch (provider) {
    case 'ollama_cloud':
      return OLLAMA_CLOUD_BASE_URL
    case 'ollama':
      return configured ? normalizeBaseUrl(configured) : OLLAMA_DEFAULT_BASE_URL
    default:
      return null
  }
}
