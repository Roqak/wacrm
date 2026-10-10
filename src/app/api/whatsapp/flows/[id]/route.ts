import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import {
  deleteWaFlow,
  loadLocalFlowRow,
  updateWaFlow,
} from '@/lib/whatsapp/wa-flows/lifecycle'
import { flowErrorResponse, readJsonObject } from '@/lib/whatsapp/wa-flows/http'

/**
 * One WhatsApp Form.
 *
 * GET    — the stored form (any member).
 * PATCH  — edit: name / categories / flow_json go to Meta (JSON only
 *          while DRAFT); first_screen / field_mappings /
 *          endpoint_forward_url are local behaviour. Admin+.
 * DELETE — drafts are deleted on Meta too; deprecated forms are only
 *          removed locally; published forms are refused. Admin+.
 */

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await getCurrentAccount()
    const flow = await loadLocalFlowRow(supabase, accountId, id)
    return NextResponse.json({ flow })
  } catch (err) {
    return flowErrorResponse(err, 'load form')
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await requireRole('admin')
    const body = await readJsonObject(request)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }
    const result = await updateWaFlow(supabase, {
      accountId,
      flowId: id,
      patch: {
        name: body.name,
        categories: body.categories,
        flow_json: body.flow_json,
        first_screen: body.first_screen,
        field_mappings: body.field_mappings,
        endpoint_forward_url: body.endpoint_forward_url,
        endpoint_uri: body.endpoint_uri,
      },
    })
    return NextResponse.json(result)
  } catch (err) {
    return flowErrorResponse(err, 'update form')
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await requireRole('admin')
    await deleteWaFlow(supabase, { accountId, flowId: id })
    return NextResponse.json({ success: true })
  } catch (err) {
    return flowErrorResponse(err, 'delete form')
  }
}
