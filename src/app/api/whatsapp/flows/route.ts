import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import {
  createWaFlow,
  FLOW_PUBLIC_COLUMNS,
} from '@/lib/whatsapp/wa-flows/lifecycle'
import { flowErrorResponse, readJsonObject } from '@/lib/whatsapp/wa-flows/http'

/**
 * WhatsApp Forms (Meta Flows) catalog.
 *
 * GET  — every form in the active account, newest first. Any member:
 *        the composer, automation and chatbot builders all pick from
 *        this list.
 * POST — create a form on Meta (optionally with its JSON, optionally
 *        published in the same call) and store it. Admin+, like
 *        templates: forms are settings-class data.
 */

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('whatsapp_flows')
      .select(FLOW_PUBLIC_COLUMNS)
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
    if (error) throw error
    return NextResponse.json({ flows: data ?? [] })
  } catch (err) {
    return flowErrorResponse(err, 'list forms')
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = await readJsonObject(request)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }
    const result = await createWaFlow(supabase, {
      accountId,
      userId,
      name: body.name,
      categories: body.categories,
      flowJson: body.flow_json,
      publish: body.publish === true,
    })
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return flowErrorResponse(err, 'create form')
  }
}
