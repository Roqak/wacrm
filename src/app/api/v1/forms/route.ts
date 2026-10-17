// ============================================================
// GET /api/v1/forms — list WhatsApp Forms (Meta Flows)  (scope: forms:read)
//
// Keyset-paginated, newest first, optional `?status=` (DRAFT,
// PUBLISHED, DEPRECATED, BLOCKED, THROTTLED). Send a form with
// POST /api/v1/messages, `type: "interactive"` and an
// `interactive_payload` of `{ kind: "flow", … }` — see the OpenAPI doc.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { fail, okList, toApiErrorResponse } from '@/lib/api/v1/respond';
import { buildPage, keysetFilter, parseListParams } from '@/lib/api/v1/pagination';
import { FORM_SELECT, serializeForm } from '@/lib/api/v1/forms';

const STATUSES = new Set(['DRAFT', 'PUBLISHED', 'DEPRECATED', 'BLOCKED', 'THROTTLED']);

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'forms:read');
    const { limit, cursor } = parseListParams(request);
    const status = new URL(request.url).searchParams.get('status');

    let query = ctx.supabase
      .from('whatsapp_flows')
      .select(FORM_SELECT)
      .eq('account_id', ctx.accountId);
    if (status) {
      if (!STATUSES.has(status.toUpperCase())) {
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
      console.error('[api/v1/forms] list error:', error);
      return fail('internal', 'Failed to list forms', 500);
    }
    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit,
    );
    return okList(
      items.map((r) => serializeForm(r as Record<string, unknown>)),
      nextCursor,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
