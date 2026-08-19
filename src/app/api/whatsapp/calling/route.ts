// ============================================================
// PATCH /api/whatsapp/calling  (admin+)
//
// Flips `whatsapp_config.calling_enabled`.
//
// A separate route from the main config POST on purpose: that endpoint
// re-runs the whole credential flow (verify → /register →
// subscribed_apps) and demands the access token be re-entered. Toggling
// a checkbox should not require any of that, and folding it in would
// mean an operator could not turn calling off without a working token.
//
// The flag is a local statement of intent, not a fact we can verify:
// enabling calling happens in Meta's own settings, and the Graph API
// exposes no field that reports it. What the flag actually controls is
// this app — whether the browser mounts a call surface and whether the
// signalling routes will act — so an operator who flips it on without
// doing the Meta side simply never receives a `calls` webhook.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function PATCH(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`wa-calling:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown
    } | null

    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json(
        { error: "'enabled' must be true or false" },
        { status: 400 },
      )
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json(
        { error: 'Connect a WhatsApp number before enabling calling.' },
        { status: 409 },
      )
    }

    const { error } = await supabase
      .from('whatsapp_config')
      .update({
        calling_enabled: body.enabled,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)

    if (error) {
      console.error('[whatsapp/calling PATCH] update error:', error)
      return NextResponse.json(
        { error: 'Failed to update calling setting' },
        { status: 500 },
      )
    }

    return NextResponse.json({ ok: true, calling_enabled: body.enabled })
  } catch (err) {
    return toErrorResponse(err)
  }
}
