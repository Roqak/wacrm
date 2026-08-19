// ============================================================
// Validation for the provider half of the AI setup form.
//
// `/api/ai/config` (save) and `/api/ai/test` (Test key) ask the same
// three questions — is this a provider we support, does it need a key,
// does it need a server address — and previously answered the first one
// with a hand-written `provider !== 'openai' && provider !== 'anthropic'`
// in each file. With four providers and two of them having different
// requirements, two copies of that is two places to forget.
// ============================================================

import { AI_PROVIDER_REQUIREMENTS } from './defaults'
import { normalizeBaseUrl, assertBaseUrlAllowed } from './providers/base-url'
import { AiError, type AiProvider } from './types'

export const SUPPORTED_PROVIDERS: readonly AiProvider[] = [
  'openai',
  'anthropic',
  'ollama',
  'ollama_cloud',
] as const

export function isAiProvider(value: unknown): value is AiProvider {
  return (
    typeof value === 'string' &&
    (SUPPORTED_PROVIDERS as readonly string[]).includes(value)
  )
}

/** Human-readable list for a 400 message. */
export function supportedProvidersMessage(): string {
  return `provider must be one of ${SUPPORTED_PROVIDERS.map((p) => `"${p}"`).join(', ')}`
}

export function providerRequiresKey(provider: AiProvider): boolean {
  return AI_PROVIDER_REQUIREMENTS[provider].requiresKey
}

export function providerRequiresBaseUrl(provider: AiProvider): boolean {
  return AI_PROVIDER_REQUIREMENTS[provider].requiresBaseUrl
}

/**
 * Normalize and authorize the base URL for a save/test request.
 *
 * Returns the value to persist: an origin string for providers that
 * take one, `null` for the rest — so a stale address left over from a
 * previous provider choice is cleared rather than lingering in the row
 * where a future code path might read it.
 *
 * Throws `AiError` (status 400) when the URL is malformed or points
 * somewhere the operator hasn't allowed.
 */
export async function resolveBaseUrlInput(
  provider: AiProvider,
  raw: unknown,
): Promise<string | null> {
  if (!providerRequiresBaseUrl(provider)) return null

  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) {
    throw new AiError('A server URL is required for a self-hosted Ollama.', {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  const origin = normalizeBaseUrl(text)
  await assertBaseUrlAllowed(origin)
  return origin
}
