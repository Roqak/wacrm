// ============================================================
// /api/webhook-endpoints — dashboard management for outbound
// webhook endpoints (the `webhook_endpoints` table, migration 028).
//
// GET   — list this account's endpoints (any member; the roster is
//         settings-class, not secret — the signing secret never
//         leaves the server after creation).
// POST  — register a new endpoint + generate its signing secret.
//
// Session auth (cookie), admin+ for writes via `requireRole('admin')`
// — same gate as the RLS policies on the table. The public-API equivalent
// (`/api/v1/webhooks`, API-key `webhooks:manage` scope) shares the
// validate/serialize helpers in `@/lib/webhooks/endpoints`; only the
// auth differs. No API key required here — that's the point.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  serializeWebhookEndpoint,
  generateWebhookSecret,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints';

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();
    // RLS (webhook_endpoints_select) scopes to the caller's account;
    // any member may read the roster.
    const { data, error } = await supabase
      .from('webhook_endpoints')
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[api/webhook-endpoints] list error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      endpoints: (data ?? []).map((row) =>
        serializeWebhookEndpoint(row as Record<string, unknown>),
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
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

  const url = normalizeWebhookUrl(body.url);
  if (!url) {
    return NextResponse.json(
      { error: "'url' must be a valid https:// URL" },
      { status: 400 },
    );
  }

  const events = normalizeEvents(body.events);
  if (!events) {
    return NextResponse.json(
      { error: "'events' must be a non-empty array of known event names" },
      { status: 400 },
    );
  }

  const secret = generateWebhookSecret();

  const { data: created, error } = await ctx.supabase
    .from('webhook_endpoints')
    .insert({
      account_id: ctx.accountId,
      created_by: ctx.userId,
      url,
      secret: encrypt(secret),
      events,
    })
    .select(WEBHOOK_PUBLIC_COLUMNS)
    .single();

  if (error || !created) {
    console.error('[api/webhook-endpoints] create error:', error);
    return NextResponse.json(
      { error: error?.message ?? 'Failed to create webhook' },
      { status: 500 },
    );
  }

  // Signing secret shown exactly once, same one-time-reveal contract
  // as API keys and invite links.
  return NextResponse.json(
    {
      endpoint: serializeWebhookEndpoint(created as Record<string, unknown>),
      secret,
    },
    { status: 201 },
  );
}