import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { parseSuggestions } from '@/lib/ai/suggestions'
import { latestUserMessage } from '@/lib/ai/query'
import { logAiUsage } from '@/lib/ai/usage'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'

/**
 * POST /api/ai/suggest  (agent+)
 *
 * Body: { conversation_id }
 * Returns: { suggestions: string[] } — up to three replies the agent
 * can click to load into the composer, then edit before sending.
 *
 * The difference from /api/ai/draft is who initiated it. A draft is one
 * reply an agent asked for by clicking ✨. Suggestions are generated
 * because a customer message is sitting unanswered, which means they
 * spend the account's key without anyone deciding to — so this route
 * refuses unless an admin turned `suggestions_enabled` on, and the same
 * per-user and per-account rate limits as drafting apply on top.
 *
 * Read-only: nothing is sent or stored until the agent hits Send.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Same buckets as drafting rather than new ones: both spend the
    // same key against the same provider quota, and an agent flipping
    // between conversations should not get a second budget just because
    // the calls come from a different button.
    const userLimit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      )
    }

    // RLS scopes the SSR client to what this member may read, which
    // since migration 040 can be narrower than the account. A member
    // restricted away from this thread gets the same 404 as one asking
    // about a conversation that doesn't exist.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/suggest] conversation lookup error:', convErr)
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      )
    }
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const config = await loadAiConfig(supabase, accountId).catch((err) => {
      console.error('[ai/suggest] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'AI assistant is not set up. Enable it in Settings → AI Agents.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    // The gate. The client checks this too so it never asks, but the
    // client's copy of the setting can be stale (an admin turning it
    // off mid-session), and a stale UI must not keep spending.
    if (!config.suggestionsEnabled) {
      return NextResponse.json(
        {
          error: 'Reply suggestions are turned off for this account.',
          code: 'suggestions_disabled',
        },
        { status: 400 },
      )
    }

    const messages = await buildConversationContext(supabase, conversationId)
    if (messages.length === 0) {
      return NextResponse.json({ suggestions: [] })
    }
    // Nothing to suggest when we spoke last: the agent is not waiting on
    // a reply, so generating one is spend with no reader. This is also
    // the client's rule, repeated here because the client can be racing
    // a message that landed after it decided to ask.
    if (messages[messages.length - 1].role !== 'user') {
      return NextResponse.json({ suggestions: [] })
    }

    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'suggestions',
      knowledge,
    })

    const { text, usage } = await generateReply({ config, systemPrompt, messages })
    const suggestions = parseSuggestions(text)

    // Log the spend even when parsing salvaged nothing — the tokens
    // were still bought, and a usage log that hides its failures is how
    // an unexplained bill happens.
    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId,
        mode: 'suggestions',
        provider: config.provider,
        model: config.model,
        usage,
      })
    } catch (logErr) {
      console.error('[ai/suggest] usage log skipped:', logErr)
    }

    return NextResponse.json({ suggestions })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
