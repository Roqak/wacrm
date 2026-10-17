import { NextResponse } from 'next/server'

import { getCurrentAccount } from '@/lib/auth/account'
import { previewWaFlow } from '@/lib/whatsapp/wa-flows/lifecycle'
import { flowErrorResponse } from '@/lib/whatsapp/wa-flows/http'

/** A Meta-hosted web preview link for the form. Any member. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await getCurrentAccount()
    const preview = await previewWaFlow(supabase, { accountId, flowId: id })
    return NextResponse.json(preview)
  } catch (err) {
    return flowErrorResponse(err, 'preview form')
  }
}
