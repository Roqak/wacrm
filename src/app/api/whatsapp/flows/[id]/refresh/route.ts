import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { refreshWaFlow } from '@/lib/whatsapp/wa-flows/lifecycle'
import { flowErrorResponse } from '@/lib/whatsapp/wa-flows/http'

/** Re-read this form's status and JSON from Meta. Admin+. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await requireRole('admin')
    const flow = await refreshWaFlow(supabase, { accountId, flowId: id })
    return NextResponse.json({ flow })
  } catch (err) {
    return flowErrorResponse(err, 'refresh form')
  }
}
