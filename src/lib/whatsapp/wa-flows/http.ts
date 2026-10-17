import { NextResponse } from 'next/server'

import {
  ForbiddenError,
  UnauthorizedError,
  toErrorResponse,
} from '@/lib/auth/account'
import { FlowLifecycleError, flowHttpStatus } from './lifecycle'

/**
 * Map an error thrown by a WhatsApp Forms dashboard route to a JSON
 * response: lifecycle errors keep their message (it's user-facing —
 * often Meta's own rejection text), auth errors keep their status,
 * anything else is a generic 500.
 */
/**
 * Postgres / PostgREST codes for "that table or column doesn't exist" —
 * on a WhatsApp Forms route that means migration 050 was never applied.
 */
const MISSING_SCHEMA_CODES = new Set(['PGRST205', 'PGRST204', '42P01', '42703'])

export function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && MISSING_SCHEMA_CODES.has(code)
}

export function flowErrorResponse(err: unknown, context: string): NextResponse {
  if (isMissingSchemaError(err)) {
    console.error(`[wa-flows] ${context}: schema missing —`, err)
    return NextResponse.json(
      {
        error:
          'WhatsApp Forms isn\'t set up in the database yet — apply migration 050_whatsapp_flows.sql, then reload.',
        code: 'migration_missing',
      },
      { status: 503 },
    )
  }
  if (err instanceof FlowLifecycleError) {
    return NextResponse.json(
      { error: err.message },
      { status: flowHttpStatus(err) },
    )
  }
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return toErrorResponse(err)
  }
  console.error(`[wa-flows] ${context}:`, err)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

/** Parse a JSON body, or null when it isn't an object. */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}
