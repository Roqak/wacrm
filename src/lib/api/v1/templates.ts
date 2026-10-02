// ============================================================
// Shared template logic for the public API (v1) template endpoints.
//
// Kept out of the route files the same way contacts.ts is: one
// serializer, one row select, one error-mapping shape, so
// `GET/POST /api/v1/templates` and the /{id} lifecycle routes
// agree on the wire format. The Meta-side lifecycle itself lives in
// `@/lib/whatsapp/template-lifecycle` (shared with the dashboard).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { TemplateLifecycleError } from '@/lib/whatsapp/template-lifecycle';
import { badRequest } from '@/lib/api/v1/respond';

/** Template row select — everything the public contract promises. */
export const TEMPLATE_SELECT =
  'id, name, category, language, header_type, header_content, header_media_url, body_text, footer_text, buttons, sample_values, status, meta_template_id, submission_error, rejection_reason, last_submitted_at, created_at, updated_at';

export interface ApiTemplate {
  id: string;
  /** Meta-side lifecycle status, verbatim (PENDING / APPROVED / REJECTED / PAUSED / …). */
  status: string;
  name: string;
  category: string;
  language: string;
  header_type: string | null;
  header_content: string | null;
  header_media_url: string | null;
  body_text: string;
  footer_text: string | null;
  buttons: unknown;
  sample_values: unknown;
  /** Meta's id when accepted for delivery/review — null while DRAFT. */
  meta_template_id: string | null;
  submission_error: string | null;
  rejection_reason: string | null;
  last_submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Flatten a `message_templates` row into the public template shape.
 * `header_handle` (Meta's resumable-upload id) is deliberately NOT
 * exposed — it is an integration detail the app derives on submit.
 */
export function serializeTemplate(row: Record<string, unknown>): ApiTemplate {
  return {
    id: row.id as string,
    status: row.status as string,
    name: row.name as string,
    category: row.category as string,
    language: row.language as string,
    header_type: (row.header_type as string | null) ?? null,
    header_content: (row.header_content as string | null) ?? null,
    header_media_url: (row.header_media_url as string | null) ?? null,
    body_text: row.body_text as string,
    footer_text: (row.footer_text as string | null) ?? null,
    buttons: row.buttons ?? null,
    sample_values: row.sample_values ?? null,
    meta_template_id: (row.meta_template_id as string | null) ?? null,
    submission_error: (row.submission_error as string | null) ?? null,
    rejection_reason: (row.rejection_reason as string | null) ?? null,
    last_submitted_at: (row.last_submitted_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Map a template-lifecycle failure to the v1 failure envelope. Statuses
 * come from the core (which picked 400/404/429/500/502 per case); the
 * code follows the envelope's vocabulary. Nothing internal leaks except
 * Meta's own actionable message.
 */
export function templateLifecycleToApi(err: TemplateLifecycleError) {
  const code =
    err.httpStatus === 404
      ? 'not_found'
      : err.httpStatus === 409
        ? 'conflict'
        : err.httpStatus === 429
          ? 'rate_limited'
          : err.httpStatus < 500
            ? 'bad_request'
            : 'internal';
  return { code: code as string, message: err.message, status: err.httpStatus };
}

/**
 * Fetch one template row for the account, enforcing the id shape first.
 * Shared by GET / PATCH / DELETE so a foreign id is indistinguishable
 * from a missing one (404).
 */
export async function getTemplateRow(
  db: SupabaseClient,
  accountId: string,
  templateId: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from('message_templates')
    .select(TEMPLATE_SELECT)
    .eq('id', templateId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/templates] row lookup error:', error);
    return null;
  }
  return (data as Record<string, unknown> | null) ?? null;
}

export async function parseTemplateBody(
  request: Request
): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body || typeof body !== 'object') {
    throw badRequest('Invalid JSON body.');
  }
  return body;
}