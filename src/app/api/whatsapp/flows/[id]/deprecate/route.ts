import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { deprecateWaFlow } from '@/lib/whatsapp/wa-flows/lifecycle'
import { flowErrorResponse } from '@/lib/whatsapp/wa-flows/http'

/** PUBLISHED → DEPRECATED on Meta. New sends stop; forms already in chats still open. Admin+. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await requireRole('admin')
    const flow = await deprecateWaFlow(supabase, { accountId, flowId: id })
    return NextResponse.json({ flow })
  } catch (err) {
    return flowErrorResponse(err, 'deprecate form')
  }
}
