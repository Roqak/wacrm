import { NextResponse } from 'next/server'

import { getCurrentAccount } from '@/lib/auth/account'
import { loadLocalFlowRow } from '@/lib/whatsapp/wa-flows/lifecycle'
import { flowErrorResponse } from '@/lib/whatsapp/wa-flows/http'

const PAGE_SIZE = 50

/**
 * Submissions of one form, newest first, with the contact who sent
 * each. Cursor-paginated by `created_at` (`?before=<iso>`); `?format=csv`
 * returns every submission as a CSV download. Any member — the same
 * people who can read the conversations these came from.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { supabase, accountId } = await getCurrentAccount()
    const flow = await loadLocalFlowRow(supabase, accountId, id)
    const url = new URL(request.url)
    const asCsv = url.searchParams.get('format') === 'csv'
    const before = url.searchParams.get('before')

    let query = supabase
      .from('whatsapp_flow_responses')
      .select('id, response, created_at, conversation_id, contact:contacts(id, name, phone)')
      .eq('account_id', accountId)
      .eq('flow_id', flow.id)
      .order('created_at', { ascending: false })
      .limit(asCsv ? 10_000 : PAGE_SIZE + 1)
    if (before && !Number.isNaN(Date.parse(before))) {
      query = query.lt('created_at', before)
    }
    const { data, error } = await query
    if (error) throw error
    const rows = (data ?? []) as unknown as {
      id: string
      response: Record<string, unknown>
      created_at: string
      conversation_id: string | null
      contact: { id: string; name: string | null; phone: string | null } | null
    }[]

    if (asCsv) {
      const fieldNames = [...new Set(rows.flatMap((r) => Object.keys(r.response ?? {})))]
      const cell = (v: unknown) => {
        const s =
          v === null || v === undefined
            ? ''
            : typeof v === 'object'
              ? JSON.stringify(v)
              : String(v)
        // Quote everything; neutralise spreadsheet formula injection.
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
        return `"${safe.replace(/"/g, '""')}"`
      }
      const lines = [
        ['submitted_at', 'contact_name', 'contact_phone', ...fieldNames].map(cell).join(','),
        ...rows.map((r) =>
          [
            r.created_at,
            r.contact?.name ?? '',
            r.contact?.phone ?? '',
            ...fieldNames.map((f) => r.response?.[f]),
          ]
            .map(cell)
            .join(','),
        ),
      ]
      const filename = `${flow.name.replace(/[^\w-]+/g, '_') || 'form'}-responses.csv`
      return new NextResponse(lines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    }

    const hasMore = rows.length > PAGE_SIZE
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows
    return NextResponse.json({
      responses: page,
      next_before: hasMore ? page[page.length - 1].created_at : null,
    })
  } catch (err) {
    return flowErrorResponse(err, 'list form responses')
  }
}
