// ============================================================
// GET /api/v1/forms/{id} — one WhatsApp Form, with its definition
// (scope: forms:read). A foreign or unknown id is a 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { FORM_SELECT, serializeForm } from '@/lib/api/v1/forms';
import { isFlowUuid } from '@/lib/whatsapp/wa-flows/lifecycle';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'forms:read');
    const { id } = await context.params;
    if (!isFlowUuid(id)) return fail('not_found', 'Form not found', 404);
    const { data, error } = await ctx.supabase
      .from('whatsapp_flows')
      .select(FORM_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) {
      console.error('[api/v1/forms] read error:', error);
      return fail('internal', 'Failed to read form', 500);
    }
    if (!data) return fail('not_found', 'Form not found', 404);
    return ok(serializeForm(data as Record<string, unknown>));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
