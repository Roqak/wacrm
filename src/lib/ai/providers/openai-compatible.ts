import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

// ============================================================
// The OpenAI chat-completions wire format, pointed at any origin.
//
// OpenAI defined it; Ollama (local and hosted) implements it at
// `/v1/chat/completions` with the same request body, the same
// `choices[0].message.content`, and the same `usage` block. So one
// adapter serves all three and the provider modules are thin wrappers
// that supply an origin and a name for error messages.
//
// Anthropic is not in this family — different envelope, different
// header, different usage keys — and keeps its own adapter.
// ============================================================

interface ChatCompletionsResponse {
  choices?: { message?: { content?: string } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export interface OpenAiCompatibleArgs extends ProviderArgs {
  /** Origin to call, without a trailing slash. */
  baseUrl: string
  /** Provider name as it should read in an error message. */
  label: string
}

export async function generateOpenAiCompatible(
  args: OpenAiCompatibleArgs,
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, baseUrl, label } = args

  // A local Ollama usually has no auth. Sending `Authorization: Bearer`
  // with an empty value is worse than sending nothing — some proxies
  // treat the malformed header as a failed auth attempt rather than an
  // absent one.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let res: Response
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        // Ollama streams by default on some client paths; the response
        // parsing below expects one JSON object, so say so explicitly.
        // OpenAI already defaults to false and ignores the repetition.
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError(label, res)
  }

  const data = (await res.json().catch(() => null)) as ChatCompletionsResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError(`${label} returned an empty response.`, {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
