import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: async () => true }));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s.replace(/^enc:/, '') }));

import { handleFlowEndpointRequest } from './endpoint';
import { fakeDb } from './test-db';

const ACCOUNT = 'acct-1';

function db(flowOverrides: Record<string, unknown> = {}) {
  return fakeDb({
    whatsapp_flow_tokens: [
      { token: 'tok-1', account_id: ACCOUNT, flow_id: 'f-1', meta_flow_id: 'm-1', contact_id: 'c-1', conversation_id: 'conv-1', completed_at: null },
      { token: 'tok-foreign', account_id: 'acct-2', flow_id: 'f-9', meta_flow_id: 'm-9', contact_id: null, conversation_id: null, completed_at: null },
      { token: 'tok-done', account_id: ACCOUNT, flow_id: 'f-1', meta_flow_id: 'm-1', contact_id: null, conversation_id: null, completed_at: '2026-01-01' },
    ],
    whatsapp_flows: [
      {
        id: 'f-1',
        account_id: ACCOUNT,
        meta_flow_id: 'm-1',
        name: 'Sign up',
        first_screen: null,
        flow_json: { version: '7.0', screens: [{ id: 'START' }, { id: 'END' }] },
        endpoint_forward_url: null,
        endpoint_forward_secret: null,
        ...flowOverrides,
      },
    ],
    contacts: [{ id: 'c-1', account_id: ACCOUNT, name: 'Ada', phone: '+2348000000001' }],
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('handleFlowEndpointRequest', () => {
  it('answers the health check', async () => {
    const out = await handleFlowEndpointRequest(db().client, {
      accountId: ACCOUNT,
      body: { action: 'ping', version: '3.0' },
    });
    expect(out).toEqual({ kind: 'ok', response: { data: { status: 'active' } } });
  });

  it('acknowledges client error notifications', async () => {
    const out = await handleFlowEndpointRequest(db().client, {
      accountId: ACCOUNT,
      body: { action: 'data_exchange', flow_token: 'tok-1', data: { error: 'boom' } },
    });
    expect(out).toEqual({ kind: 'ok', response: { data: { acknowledged: true } } });
  });

  it('rejects unknown, foreign and completed tokens', async () => {
    for (const flow_token of ['nope', 'tok-foreign', 'tok-done', undefined]) {
      const out = await handleFlowEndpointRequest(db().client, {
        accountId: ACCOUNT,
        body: { action: 'INIT', flow_token },
      });
      expect(out).toEqual({ kind: 'token_invalid' });
    }
  });

  it('opens the entry screen on INIT when no forward URL is set', async () => {
    const out = await handleFlowEndpointRequest(db().client, {
      accountId: ACCOUNT,
      body: { action: 'INIT', flow_token: 'tok-1' },
    });
    expect(out).toEqual({ kind: 'ok', response: { screen: 'START', data: {} } });
  });

  it('reports an error on data_exchange when no forward URL is set', async () => {
    const out = await handleFlowEndpointRequest(db().client, {
      accountId: ACCOUNT,
      body: { action: 'data_exchange', flow_token: 'tok-1', screen: 'START', data: {} },
    });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.response.screen).toBe('START');
      expect((out.response.data as Record<string, unknown>).error_message).toBeTruthy();
    }
  });

  it('forwards to the configured URL, signed, with contact context', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ screen: 'END', data: { ok: true } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await handleFlowEndpointRequest(
      db({ endpoint_forward_url: 'https://hooks.example.com/f', endpoint_forward_secret: 'enc:shh' }).client,
      {
        accountId: ACCOUNT,
        body: { action: 'data_exchange', flow_token: 'tok-1', screen: 'START', data: { q: 1 }, version: '3.0' },
      },
    );
    expect(out).toEqual({ kind: 'ok', response: { screen: 'END', data: { ok: true } } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/f');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>)['X-Wacrm-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      action: 'data_exchange',
      screen: 'START',
      data: { q: 1 },
      flow_token: 'tok-1',
      form: { id: 'f-1', meta_flow_id: 'm-1', name: 'Sign up' },
      contact: { id: 'c-1', name: 'Ada' },
      conversation_id: 'conv-1',
    });
  });

  it('surfaces a failing forward target as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const out = await handleFlowEndpointRequest(
      db({ endpoint_forward_url: 'https://hooks.example.com/f' }).client,
      { accountId: ACCOUNT, body: { action: 'INIT', flow_token: 'tok-1' } },
    );
    expect(out.kind).toBe('error');
  });
});
