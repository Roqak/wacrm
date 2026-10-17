// ============================================================
// GET /api/v1/forms/{id}/responses — submissions of one WhatsApp Form
// (scope: forms:read). Keyset-paginated, newest first; optional
// `?contact_id=` narrows to one contact. For a push feed, subscribe a
// webhook to `form.submitted` instead of polling.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { fail, okList, toApiErrorResponse } from '@/lib/api/v1/respond';
import { buildPage, keysetFilter, parseListParams } from '@/lib/api/v1/pagination';
import { FORM_RESPONSE_SELECT, serializeFormResponse } from '@/lib/api/v1/forms';
import { isFlowUuid } from '@/lib/whatsapp/wa-flows/lifecycle';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'forms:read');
    const { id } = await context.params;
    if (!isFlowUuid(id)) return fail('not_found', 'Form not found', 404);
    const { limit, cursor } = parseListParams(request);
    const contactId = new URL(request.url).searchParams.get('contact_id');
    if (contactId && !isFlowUuid(contactId)) {
      return fail('bad_request', "Invalid 'contact_id' filter", 400);
    }

    const { data: form } = await ctx.supabase
      .from('whatsapp_flows')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!form) return fail('not_found', 'Form not found', 404);

    let query = ctx.supabase
      .from('whatsapp_flow_responses')
      .select(FORM_RESPONSE_SELECT)
      .eq('account_id', ctx.accountId)
      .eq('flow_id', id);
    if (contactId) query = query.eq('contact_id', contactId);
    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);
    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/forms] responses error:', error);
      return fail('internal', 'Failed to list responses', 500);
    }
    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit,
    );
    return okList(
      items.map((r) => serializeFormResponse(r as Record<string, unknown>)),
      nextCursor,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
