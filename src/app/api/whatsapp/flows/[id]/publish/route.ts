import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { publishWaFlow } from '@/lib/whatsapp/wa-flows/lifecycle'
import { flowErrorResponse } from '@/lib/whatsapp/wa-flows/http'

/** DRAFT → PUBLISHED on Meta. Irreversible: Meta freezes a published form's JSON. Admin+. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await requireRole('admin')
    const flow = await publishWaFlow(supabase, { accountId, flowId: id })
    return NextResponse.json({ flow })
  } catch (err) {
    return flowErrorResponse(err, 'publish form')
  }
}
