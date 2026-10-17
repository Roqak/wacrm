import { beforeEach, describe, expect, it, vi } from 'vitest';

// The routes exercise the REAL validate/serialize helpers (events,
// endpoints, encryption) — only Supabase and auth are stubbed, so the
// assertions pin the 200/400/404 contract both the dashboard UI and
// the public /api/v1/webhooks twin rely on.
const mocks = vi.hoisted(() => ({
  supabase: {
    from: vi.fn(),
  },
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err: { httpStatus?: number }) =>
    new Response(
      JSON.stringify({ error: 'auth failed' }),
      { status: err?.httpStatus ?? 401 },
    ),
  ),
}));

const ctx = {
  supabase: mocks.supabase as never,
  userId: 'user-1',
  accountId: 'account-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';

// Each .from() call records one Call (table + op chain) and can be
// given its own terminal result set by fromMock().
type Call = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  body?: Record<string, unknown>;
  eqs: [string, string][];
};

type Row = { data: unknown; error: unknown };

function makeFromMock(calls: Call[], results: Row[]) {
  return (table: string) => {
    const call: Call = { table, op: 'select', eqs: [] };
    calls.push(call);
    const chain = {
      select: () => chain,
      insert: (body: Record<string, unknown>) => {
        call.op = 'insert';
        call.body = body;
        return chain;
      },
      update: (body: Record<string, unknown>) => {
        call.op = 'update';
        call.body = body;
        return chain;
      },
      delete: () => {
        call.op = 'delete';
        return chain;
      },
      order: () => chain,
      eq: (col: string, val: string) => {
        call.eqs.push([col, val]);
        return chain;
      },
      maybeSingle: () => results[0] ?? { data: null, error: null },
      single: () => results[0] ?? { data: null, error: null },
    };
    // Postgrest builders are thenable: the awaited value of the chain is
    // the query result. Mock the same contract so the route's
    // `await supabase.from(...)...` gets the configured rows.
    (chain as { then?: unknown }).then = (
      onfulfilled: (v: { data: unknown; error: unknown }) => unknown,
    ) => onfulfilled(results[0] ?? { data: null, error: null });
    return chain;
  };
}

const ENDPOINT_ROW = {
  id: 'ep-1',
  account_id: 'account-1',
  url: 'https://hooks.example/x',
  events: ['message.received'],
  is_active: true,
  last_delivery_at: null,
  failure_count: 0,
  created_at: '2026-01-01T00:00:00Z',
};

const SERIALIZED = {
  id: 'ep-1',
  url: 'https://hooks.example/x',
  events: ['message.received'],
  is_active: true,
  last_delivery_at: null,
  failure_count: 0,
  created_at: '2026-01-01T00:00:00Z',
};

const ENDPOINT_RESULT = { data: ENDPOINT_ROW, error: null };


const request = (
  method: string,
  body?: unknown,
  path = 'http://localhost/api/webhook-endpoints',
) =>
  new Request(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

const idParams = { params: Promise.resolve({ id: 'ep-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue(ctx);
  mocks.getCurrentAccount.mockResolvedValue({
    supabase: mocks.supabase,
    accountId: ctx.accountId,
  });
});

describe('GET /api/webhook-endpoints', () => {
  it('lists serialized endpoints; no secret in the payload', async () => {
    const calls: Call[] = [];
    mocks.supabase.from.mockImplementation(
      makeFromMock(calls, [{ data: [ENDPOINT_ROW], error: null }]),
    );

    const res = await GET();
    const json = await res.json();

    expect(mocks.supabase.from).toHaveBeenCalledWith('webhook_endpoints');
    expect(json.endpoints).toEqual([SERIALIZED]);
    expect(JSON.stringify(json)).not.toContain('secret');
  });

  it('answers 401 through toErrorResponse when there is no session', async () => {
    mocks.getCurrentAccount.mockRejectedValue(new Error('no session'));
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe('POST /api/webhook-endpoints', () => {
  it('rejects non-admin callers with the auth error status', async () => {
    mocks.requireRole.mockRejectedValue({ httpStatus: 403, message: 'forbidden' });
    const res = await POST(
      request('POST', { url: 'https://x.test/h', events: ['message.received'] }),
    );
    expect(res.status).toBe(403);
  });

  it('refuses an http:// URL', async () => {
    const res = await POST(
      request('POST', { url: 'http://x.test/h', events: ['message.received'] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/https/);
  });

  it('refuses unknown or empty event lists', async () => {
    const res = await POST(
      request('POST', { url: 'https://x.test/h', events: ['bogus.event'] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/known event names/);
  });

  it('creates endpoint + encrypted secret; returns the secret once', async () => {
    const calls: Call[] = [];
    mocks.supabase.from.mockImplementation(
      makeFromMock(calls, [ENDPOINT_RESULT]),
    );

    const res = await POST(
      request('POST', {
        url: 'https://hooks.example/y',
        events: ['message.received', 'form.submitted', 'message.received'],
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    const insertCall = calls[0];
    expect(insertCall.op).toBe('insert');
    expect(insertCall.body!.account_id).toBe('account-1');
    expect(insertCall.body!.created_by).toBe('user-1');
    // duplicate events de-duplicated by normalizeEvents
    expect(insertCall.body!.events).toEqual(['message.received', 'form.submitted']);
    // the stored copy is ciphertext, not the plaintext from the response
    const storedSecret = String(insertCall.body!.secret);
    expect(json.secret).toMatch(/^whsec_/);
    expect(storedSecret.startsWith(json.secret)).toBe(false);
    expect(json.endpoint).toEqual(SERIALIZED);
    expect(calls[0].table).toBe('webhook_endpoints');
  });
});

describe('PATCH /api/webhook-endpoints/[id]', () => {
  it('updates events and clears the failure streak on re-enable', async () => {
    const calls: Call[] = [];
    mocks.supabase.from.mockImplementation(
      makeFromMock(calls, [
        { data: { ...ENDPOINT_ROW, is_active: true, failure_count: 0 }, error: null },
      ]),
    );

    const res = await PATCH(
      request('PATCH', { events: ['message.received'], is_active: true }),
      idParams,
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    const updateCall = calls[0];
    expect(updateCall.body).toEqual({
      events: ['message.received'],
      is_active: true,
      failure_count: 0,
    });
    expect(updateCall.eqs).toContainEqual(['id', 'ep-1']);
    expect(updateCall.eqs).toContainEqual(['account_id', 'account-1']);
    expect(json.endpoint.events).toEqual(['message.received']);
  });

  it('refuses an empty update with 400 before touching the table', async () => {
    const res = await PATCH(request('PATCH', {}), idParams);
    expect(res.status).toBe(400);
    expect(mocks.supabase.from).not.toHaveBeenCalled();
  });

  it('answers 404 (not 403) for a foreign endpoint id', async () => {
    const calls: Call[] = [];
    mocks.supabase.from.mockImplementation(makeFromMock(calls, []));

    const res = await PATCH(
      request('PATCH', { is_active: false }),
      idParams,
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/webhook-endpoints/[id]', () => {
  it('deletes the row and reports the id', async () => {
    const calls: Call[] = [];
    mocks.supabase.from.mockImplementation(
      makeFromMock(calls, [{ data: { id: 'ep-1' }, error: null }]),
    );

    const res = await DELETE(request('DELETE'), idParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ id: 'ep-1', deleted: true });
    expect(calls[0].eqs).toContainEqual(['account_id', 'account-1']);
  });

  it('answers 404 when the row is not this account’s', async () => {
    const calls: Call[] = [];
    mocks.supabase.from.mockImplementation(makeFromMock(calls, []));
    const res = await DELETE(request('DELETE'), idParams);
    expect(res.status).toBe(404);
  });
});