import { NextResponse } from 'next/server';

import {
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  serializeWebhookEndpoint,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints';

// ============================================================
// /api/webhook-endpoints/{id} — session-auth per-endpoint management
// for outbound webhooks. Dashboard twin of /api/v1/webhooks/{id}.
//
// PATCH  — update url / events / is_active (admin+). Re-enabling
//          clears the failure streak so one stale failure can't
//          re-disable an endpoint the admin just turned back on.
// DELETE — remove the endpoint (admin+).
//
// Mutations are scoped by account_id explicitly; a foreign id 404s
// (never 403). The signing secret is never returned here — shown once
// at creation only.
// ============================================================

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      { error: 'Request body must be a JSON object' },
      { status: 400 },
    );
  }

  const updates: Record<string, unknown> = {};

  if ('url' in body) {
    const url = normalizeWebhookUrl(body.url);
    if (!url) {
      return NextResponse.json(
        { error: "'url' must be a valid https:// URL" },
        { status: 400 },
      );
    }
    updates.url = url;
  }

  if ('events' in body) {
    const events = normalizeEvents(body.events);
    if (!events) {
      return NextResponse.json(
        { error: "'events' must be a non-empty array of known event names" },
        { status: 400 },
      );
    }
    updates.events = events;
  }

  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') {
      return NextResponse.json(
        { error: "'is_active' must be a boolean" },
        { status: 400 },
      );
    }
    updates.is_active = body.is_active;
    if (body.is_active === true) updates.failure_count = 0;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'No updatable fields provided' },
      { status: 400 },
    );
  }

  const { data, error } = await ctx.supabase
    .from('webhook_endpoints')
    .update(updates)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select(WEBHOOK_PUBLIC_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error('[api/webhook-endpoints] update error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
  }

  return NextResponse.json({
    endpoint: serializeWebhookEndpoint(data as Record<string, unknown>),
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { data, error } = await ctx.supabase
    .from('webhook_endpoints')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[api/webhook-endpoints] delete error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
  }

  return NextResponse.json({ id: data.id, deleted: true });
}