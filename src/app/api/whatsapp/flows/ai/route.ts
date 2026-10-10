import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { logAiUsage } from '@/lib/ai/usage'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'
import { proxySafeStatus } from '@/lib/http/proxy-safe-status'
import { buildFormWithAi, pickFlowJsonVersion } from '@/lib/whatsapp/wa-flows/ai-builder'

/**
 * POST /api/whatsapp/flows/ai  (admin+)
 *
 * Body: {
 *   instruction: string,            // "a lead form asking name, email, budget"
 *   current_json?: object,          // edit mode: the definition to change
 *   meta_errors?: [{ message, … }]  // Meta's validation_errors to fix
 * }
 * Returns: { name, categories, flow_json, issues, attempts }
 *
 * Generates Flow JSON with the account's own AI provider and lints it,
 * letting the model repair what the linter finds. Writes nothing: the
 * caller reviews the result, then creates / saves the form through the
 * normal routes (where Meta validates it too). Admin+ like every other
 * form write, and because it spends the account's AI key.
 */

export const maxDuration = 300

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const userLimit = checkRateLimit(`ai-forms:${userId}`, RATE_LIMITS.aiFormBuilder)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    // Shares the account-wide AI budget with drafts.
    const accountLimit = checkRateLimit(`ai-draft-acct:${accountId}`, RATE_LIMITS.aiDraftAccount)
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }
    const instruction = typeof body.instruction === 'string' ? body.instruction : ''
    if (instruction.length > 4000) {
      return NextResponse.json({ error: 'Keep the description under 4000 characters.' }, { status: 400 })
    }
    const currentJson =
      body.current_json && typeof body.current_json === 'object' && !Array.isArray(body.current_json)
        ? (body.current_json as Record<string, unknown>)
        : null
    const metaErrors = Array.isArray(body.meta_errors)
      ? (body.meta_errors as unknown[])
          .filter(
            (e): e is { message: string; line_start?: number; error?: string } =>
              !!e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string',
          )
          .slice(0, 50)
      : []

    // requireActive:false, like the Playground: the master switch
    // governs the assistant talking to CUSTOMERS (drafts, auto-reply).
    // The form builder is an admin tool that only needs a working key.
    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[flows/ai] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error:
            'No AI provider configured. Add a provider and key in Settings → AI Assistant (the assistant itself can stay switched off).',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    // Copy a Flow JSON version Meta already accepted for this account.
    const { data: versions } = await supabase
      .from('whatsapp_flows')
      .select('json_version')
      .eq('account_id', accountId)
      .not('json_version', 'is', null)
    const version =
      typeof currentJson?.version === 'string'
        ? currentJson.version
        : pickFlowJsonVersion(((versions ?? []) as { json_version: string | null }[]).map((v) => v.json_version))

    const result = await buildFormWithAi({
      config,
      instruction,
      currentJson,
      metaErrors,
      version,
    })

    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId: null,
        mode: 'form_builder',
        provider: config.provider,
        model: config.model,
        usage: result.usage,
      })
    } catch (logErr) {
      console.error('[flows/ai] usage log skipped:', logErr)
    }

    return NextResponse.json({
      name: result.name,
      categories: result.categories,
      flow_json: result.flowJson,
      issues: result.issues,
      attempts: result.attempts,
    })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: proxySafeStatus(err.status) },
      )
    }
    return toErrorResponse(err)
  }
}
