// ============================================================
// Per-template lifecycle over the public API.
//
// GET    /api/v1/templates/{id} — read one  (scope: templates:manage)
// PATCH  /api/v1/templates/{id} — edit + re-submit   ″
// DELETE /api/v1/templates/{id} — delete on Meta + drop local row  ″
//
// All account-scoped by the key; a foreign id → 404, same as every
// other /api/v1/{resource}/{id}. The lifecycle (what status may be
// edited, when a Meta call is skipped) is the shared core in
// `@/lib/whatsapp/template-lifecycle`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  serializeTemplate,
  templateLifecycleToApi,
  parseTemplateBody,
  getTemplateRow,
} from '@/lib/api/v1/templates';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';
import {
  editTemplate,
  deleteTemplate,
  TemplateLifecycleError,
} from '@/lib/whatsapp/template-lifecycle';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'templates:manage');
    const { id } = await params;

    const row = await getTemplateRow(ctx.supabase, ctx.accountId, id);
    if (!row) {
      return fail('not_found', 'Template not found.', 404);
    }

    return ok(serializeTemplate(row));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'templates:manage');
    const { id } = await params;
    const body = await parseTemplateBody(request);

    const { template, dryRun } = await editTemplate(ctx.supabase, {
      accountId: ctx.accountId,
      templateId: id,
      payload: body as unknown as TemplatePayload,
    });

    return ok({ ...serializeTemplate(template), dry_run: dryRun });
  } catch (err) {
    if (err instanceof TemplateLifecycleError) {
      const { code, message, status } = templateLifecycleToApi(err);
      return fail(code, message, status);
    }
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'templates:manage');
    const { id } = await params;

    const { dryRun } = await deleteTemplate(ctx.supabase, {
      accountId: ctx.accountId,
      templateId: id,
    });

    return ok({ deleted: true, dry_run: dryRun });
  } catch (err) {
    if (err instanceof TemplateLifecycleError) {
      const { code, message, status } = templateLifecycleToApi(err);
      return fail(code, message, status);
    }
    return toApiErrorResponse(err);
  }
}