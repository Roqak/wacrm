// ============================================================
// GET  /api/v1/templates  — list templates   (scope: templates:manage)
// POST /api/v1/templates  — create + submit to Meta          ″
//
// List is keyset-paginated (see src/lib/api/v1/pagination.ts), newest
// first, with `?search=` (name) and `?status=` (one of Meta's status
// words — e.g. APPROVED to find what is safe to send with) filters.
//
// Create validates against the same rule set the dashboard uses
// (header formats, button types, {{variables}}), then submits to Meta
// for approval and stores the row. The response is the template as
// stored — `status: PENDING` until Meta reviews; use GET afterwards
// (or sync) to watch it land. `WHATSAPP_TEMPLATES_DRY_RUN=true` skips
// the network call and stores a synthetic id, same as the dashboard.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import {
  serializeTemplate,
  templateLifecycleToApi,
  parseTemplateBody,
  TEMPLATE_SELECT,
} from '@/lib/api/v1/templates';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';
import {
  submitTemplate,
  TemplateLifecycleError,
} from '@/lib/whatsapp/template-lifecycle';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:manage');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = url.searchParams.get('search');
    const status = url.searchParams.get('status');

    let query = ctx.supabase
      .from('message_templates')
      .select(TEMPLATE_SELECT)
      .eq('account_id', ctx.accountId);

    // PostgREST filter values are comma/paren-delimited; the template
    // name grammar is narrower, but strip anything that could break
    // the `.or()` grammar before interpolating.
    if (search) {
      const term = search.replace(/[^\p{L}\p{N}_\-.]/gu, '');
      if (term) query = query.or(`name.ilike.*${term}*`);
    }
    // One Meta status word; anything else is a 400 at the grammar level
    // anyway — but check the shape here to return a clean envelope.
    if (status) {
      if (status.length > 20 || !/^[A-Z_]{1,20}$/i.test(status)) {
        return fail('bad_request', "Invalid 'status' filter", 400);
      }
      query = query.eq('status', status.toUpperCase());
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/templates] list error:', error);
      return fail('internal', 'Failed to list templates', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit,
    );
    return okList(
      items.map((r) => serializeTemplate(r as Record<string, unknown>)),
      nextCursor,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:manage');
    const body = await parseTemplateBody(request);

    const { template, dryRun } = await submitTemplate(ctx.supabase, {
      accountId: ctx.accountId,
      // Audit authorship follows the same rule as contacts/messages:
      // attribute to the WhatsApp config owner (falling back to the
      // account owner), since a key has no session of its own — and
      // the (user_id, name, language) conflict key rides along.
      userId: await resolveAuditUserId(ctx.supabase, ctx.accountId),
      payload: body as unknown as TemplatePayload,
    });

    return ok({ ...serializeTemplate(template), dry_run: dryRun }, 201);
  } catch (err) {
    if (err instanceof TemplateLifecycleError) {
      const { code, message, status } = templateLifecycleToApi(err);
      return fail(code, message, status);
    }
    return toApiErrorResponse(err);
  }
}