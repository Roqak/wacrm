import type { ProviderResult } from '../types'
import { generateOpenAiCompatible } from './openai-compatible'
import type { ProviderArgs } from './shared'

// ============================================================
// Ollama — self-hosted and cloud.
//
// Both are the OpenAI chat-completions format at `/v1/chat/completions`
// on a different origin, so there is no protocol work here. What this
// module owns is the distinction the caller must not blur: the origin
// for `ollama` comes from the account's settings and has been through
// the base-URL policy in `./base-url`, while `ollama_cloud`'s is fixed
// in code. `generateOllama` takes the resolved origin rather than the
// config so it cannot accidentally read an unvalidated one.
// ============================================================

export interface OllamaArgs extends ProviderArgs {
  baseUrl: string
  /** True for the hosted service — only changes how errors read. */
  cloud?: boolean
}

export async function generateOllama(args: OllamaArgs): Promise<ProviderResult> {
  const { cloud, ...rest } = args
  return generateOpenAiCompatible({
    ...rest,
    label: cloud ? 'Ollama Cloud' : 'Ollama',
  })
}
