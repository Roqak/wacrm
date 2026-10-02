import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import {
  deleteTemplate,
  editTemplate,
  TemplateLifecycleError,
} from '@/lib/whatsapp/template-lifecycle'

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit an existing Meta-side template (and re-submit). Used
 *          by the "Edit" action on APPROVED rows and the "Resubmit"
 *          action on REJECTED / PAUSED rows. Meta replaces components
 *          wholesale on edit and bumps status back to PENDING.
 *
 * DELETE — remove the template on Meta (when meta_template_id is set,
 *          scoped to a single language variant via hsm_id) AND drop
 *          the local row. Local-only rows skip the Meta call.
 *
 * The lifecycle lives in `@/lib/whatsapp/template-lifecycle`, shared
 * with the public /api/v1/templates endpoint. This route is the auth
 * boundary — settings-class data, admin+ (RLS enforces the same).
 *
 * Initial submission (DRAFT → PENDING) lives at the sibling
 * /submit endpoint — keep this route narrowly about lifecycle of
 * already-submitted templates.
 */

const lifecycleResponse = (error: TemplateLifecycleError) => {
  const body: Record<string, unknown> = { error: error.message }
  if (error.metaTemplateId) body.meta_template_id = error.metaTemplateId
  return NextResponse.json(body, { status: error.httpStatus })
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await requireRole('admin')

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    const { template, dryRun } = await editTemplate(supabase, {
      accountId,
      templateId: id,
      payload,
    })
    return NextResponse.json({
      success: true,
      template,
      dry_run: dryRun,
    })
  } catch (error) {
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    if (error instanceof TemplateLifecycleError) {
      return lifecycleResponse(error)
    }
    console.error('Error editing template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to edit template.',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await requireRole('admin')

    const { dryRun } = await deleteTemplate(supabase, {
      accountId,
      templateId: id,
    })
    return NextResponse.json({ success: true, dry_run: dryRun })
  } catch (error) {
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    if (error instanceof TemplateLifecycleError) {
      return lifecycleResponse(error)
    }
    console.error('Error deleting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to delete template.',
      },
      { status: 500 },
    )
  }
}