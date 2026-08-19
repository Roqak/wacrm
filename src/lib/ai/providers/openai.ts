import type { ProviderResult } from '../types'
import { generateOpenAiCompatible } from './openai-compatible'
import type { ProviderArgs } from './shared'

const OPENAI_BASE_URL = 'https://api.openai.com'

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 *
 * The request/response handling lives in `./openai-compatible` — Ollama
 * speaks the same format, and one copy of it means a fix to either
 * lands for both.
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  return generateOpenAiCompatible({
    ...args,
    baseUrl: OPENAI_BASE_URL,
    label: 'OpenAI',
  })
}
