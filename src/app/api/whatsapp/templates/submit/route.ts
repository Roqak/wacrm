import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import {
  submitTemplate,
  TemplateLifecycleError,
} from '@/lib/whatsapp/template-lifecycle'

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * Auth (admin+) → parse + validate → (DRY_RUN short-circuit) →
 * POST to Meta → upsert local row by (user_id, name, language) with
 * status, meta_template_id, sample_values, last_submitted_at.
 *
 * The lifecycle lives in `@/lib/whatsapp/template-lifecycle`, shared
 * with the public /api/v1/templates endpoint. This route is the auth
 * boundary: message templates are settings-class data —
 * `canEditSettings` and the message_templates_insert/update RLS
 * policies (migration 017) both require 'admin', and a Meta
 * submission is an external side effect RLS couldn't roll back.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    const { template, dryRun } = await submitTemplate(supabase, {
      accountId,
      userId,
      payload,
    })

    return NextResponse.json({
      success: true,
      template,
      dry_run: dryRun,
    })
  } catch (error) {
    // Auth failures map to 401/403. Handled before the generic branch
    // below, which surfaces `error.message` with its status — reporting
    // "you aren't an admin" as a template submission failure would send
    // the user chasing the wrong problem.
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    if (error instanceof TemplateLifecycleError) {
      const body: Record<string, unknown> = { error: error.message }
      if (error.metaTemplateId) body.meta_template_id = error.metaTemplateId
      return NextResponse.json(body, { status: error.httpStatus })
    }
    console.error('Error submitting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to submit template.',
      },
      { status: 500 },
    )
  }
}