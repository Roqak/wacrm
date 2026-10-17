import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { syncWaFlows } from '@/lib/whatsapp/wa-flows/lifecycle'
import { flowErrorResponse } from '@/lib/whatsapp/wa-flows/http'

/**
 * Sync WhatsApp Forms from Meta → local catalog (status, categories,
 * JSON definition). Admin+: it rewrites settings-class data, and the
 * whatsapp_flows write policies require admin anyway.
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const result = await syncWaFlows(supabase, { accountId, userId })
    return NextResponse.json({ success: result.errors.length === 0, ...result })
  } catch (err) {
    return flowErrorResponse(err, 'sync forms')
  }
}
