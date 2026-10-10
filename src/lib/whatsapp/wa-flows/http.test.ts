import { describe, expect, it } from 'vitest';

import { flowErrorResponse, isMissingSchemaError } from './http';
import { FlowLifecycleError } from './lifecycle';

describe('flowErrorResponse', () => {
  it('names the missing migration instead of a bare 500', async () => {
    const res = flowErrorResponse(
      { code: 'PGRST205', message: "Could not find the table 'public.whatsapp_flows'" },
      'list forms',
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/050_whatsapp_flows\.sql/);
  });

  it('recognises Postgres and PostgREST missing-schema codes only', () => {
    for (const code of ['PGRST205', 'PGRST204', '42P01', '42703']) {
      expect(isMissingSchemaError({ code })).toBe(true);
    }
    expect(isMissingSchemaError({ code: '23505' })).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
  });

  it('keeps lifecycle messages and hides unknown errors', async () => {
    const known = flowErrorResponse(new FlowLifecycleError('Pick a category.'), 'x');
    expect(known.status).toBe(400);
    expect((await known.json()).error).toBe('Pick a category.');
    const unknown = flowErrorResponse(new Error('secret detail'), 'x');
    expect(unknown.status).toBe(500);
    expect((await unknown.json()).error).toBe('Internal server error');
  });
});
