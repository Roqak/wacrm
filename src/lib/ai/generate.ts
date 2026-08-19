import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import { generateOllama } from './providers/ollama'
import { assertBaseUrlAllowed, resolveBaseUrl } from './providers/base-url'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    case 'ollama':
    case 'ollama_cloud': {
      // Re-checked here, not just at save time. The stored address
      // outlives the conditions it was accepted under: the operator can
      // turn AI_ALLOW_PRIVATE_BASE_URL back off, and a hostname's
      // resolution can change under a row that is never edited again.
      const baseUrl = resolveBaseUrl(config.provider, config.baseUrl)!
      if (config.provider === 'ollama') {
        await assertBaseUrlAllowed(baseUrl)
      }
      result = await generateOllama({
        ...providerArgs,
        baseUrl,
        cloud: config.provider === 'ollama_cloud',
      })
      break
    }
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
