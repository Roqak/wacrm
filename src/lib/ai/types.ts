// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// which provider the account is on.
// ============================================================

/**
 * `ollama` is an Ollama server the operator runs themselves; the
 * account supplies its address. `ollama_cloud` is Ollama's hosted
 * service, whose endpoint is fixed in code. They are separate members
 * rather than one provider with a flag because everything downstream
 * differs: whether a key is required, whether a base URL is editable,
 * and whether the address is trusted.
 */
export type AiProvider = 'openai' | 'anthropic' | 'ollama' | 'ollama_cloud'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  /** Empty string when the provider needs no credential — a local
   *  Ollama typically has no authentication at all. */
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Generate reply suggestions in the inbox without being asked.
   *  Off by default — it spends the account's provider key on its own,
   *  which is the same reason `autoReplyEnabled` is opt-in. */
  suggestionsEnabled: boolean
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search.
   *
   *  Still OpenAI-only, including for Ollama accounts: the stored
   *  vectors are `vector(1536)` (migration 030) and re-embedding a
   *  knowledge base at a different dimension is a schema change, not a
   *  setting. An Ollama account can run chat locally and leave this
   *  blank for lexical search. */
  embeddingsApiKey: string | null
  /** Origin of a self-hosted server (`http://localhost:11434`), for
   *  providers whose endpoint isn't fixed. Null for every hosted
   *  provider — their addresses live in code and must never come from
   *  the database. */
  baseUrl: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
