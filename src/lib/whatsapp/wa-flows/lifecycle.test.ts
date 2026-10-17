import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt } from '@/lib/whatsapp/encryption';

import {
  createFlow,
  getFlow,
  getFlowJson,
  publishFlow,
} from './api';
import {
  createWaFlow,
  FlowLifecycleError,
  effectiveFirstScreen,
  normalizeFlowStatus,
  validateCategories,
  validateFieldMappings,
  validateFlowJson,
} from './lifecycle';
import { fakeDb } from './test-db';

// Meta responses are faked so the create/publish round-trip can be
// driven without network. getFlow is mutable so tests can move the
// flow's status between the draft and published phases.
const FLOW_JSON = {
  version: '7.0',
  screens: [
    {
      id: 'CONSENT',
      title: 'Consent',
      layout: { type: 'SingleColumnLayout', components: [] },
    },
  ],
};

function metaState(status: 'DRAFT' | 'PUBLISHED') {
  return {
    id: 'meta-9',
    name: 'consent',
    status,
    categories: ['OTHER'],
    json_version: '7.0',
    validation_errors: [],
  };
}

vi.mock('./api', () => ({
  createFlow: vi.fn(),
  deleteFlow: vi.fn(),
  deprecateFlow: vi.fn(),
  getFlow: vi.fn(),
  getFlowJson: vi.fn(),
  getFlowPreviewUrl: vi.fn(),
  listFlows: vi.fn(),
  publishFlow: vi.fn(),
  updateFlowJson: vi.fn(),
  updateFlowMetadata: vi.fn(),
}));

const ACCOUNT = 'acct-1';

function db() {
  return fakeDb({
    whatsapp_flows: [],
    whatsapp_config: [
      {
        account_id: ACCOUNT,
        waba_id: 'waba-1',
        phone_number_id: 'pn-1',
        access_token: encrypt('access-token'),
      },
    ],
  });
}

describe('validateCategories', () => {
  it('accepts and de-duplicates Meta categories', () => {
    expect(validateCategories(['SURVEY', 'SURVEY', 'OTHER'])).toEqual(['SURVEY', 'OTHER']);
  });
  it('rejects empty and unknown', () => {
    expect(() => validateCategories([])).toThrow(FlowLifecycleError);
    expect(() => validateCategories(['MAGIC'])).toThrow(/Unknown category/);
  });
});

describe('validateFlowJson', () => {
  it('accepts an object or JSON string with a version and screens', () => {
    const json = { version: '7.0', screens: [{ id: 'A' }] };
    expect(validateFlowJson(json)).toEqual(json);
    expect(validateFlowJson(JSON.stringify(json))).toEqual(json);
  });
  it('rejects bad JSON, missing version, no screens', () => {
    expect(() => validateFlowJson('{nope')).toThrow(/not valid JSON/);
    expect(() => validateFlowJson({ screens: [{ id: 'A' }] })).toThrow(/version/);
    expect(() => validateFlowJson({ version: '7.0', screens: [] })).toThrow(/screen/);
  });
});

describe('validateFieldMappings', () => {
  it('accepts built-in and custom targets', () => {
    const custom = 'custom:0b8f3a52-2a3c-4c0e-9d1a-3f2b1c0d9e8f';
    expect(
      validateFieldMappings([
        { field: ' email ', target: 'email' },
        { field: 'size', target: custom },
      ]),
    ).toEqual([
      { field: 'email', target: 'email' },
      { field: 'size', target: custom },
    ]);
  });
  it('rejects unknown targets (no writing arbitrary contact columns)', () => {
    expect(() => validateFieldMappings([{ field: 'x', target: 'phone' }])).toThrow();
    expect(() => validateFieldMappings([{ field: 'x', target: 'account_id' }])).toThrow();
    expect(() => validateFieldMappings([{ field: '', target: 'name' }])).toThrow();
    expect(() => validateFieldMappings('nope')).toThrow();
  });
});

describe('status + screen helpers', () => {
  it('normalizes Meta statuses', () => {
    expect(normalizeFlowStatus('published')).toBe('PUBLISHED');
    expect(normalizeFlowStatus('WEIRD')).toBe('DRAFT');
  });
  it('prefers the configured first screen over the entry screen', () => {
    const flow_json = { version: '7.0', screens: [{ id: 'A' }, { id: 'B' }] };
    expect(effectiveFirstScreen({ first_screen: null, flow_json })).toBe('A');
    expect(effectiveFirstScreen({ first_screen: 'B', flow_json })).toBe('B');
  });
});

describe('createWaFlow', () => {
  const input = {
    accountId: ACCOUNT,
    userId: null,
    name: 'consent',
    categories: ['OTHER'],
    flowJson: FLOW_JSON,
  };

  beforeEach(() => {
    // config's clearMocks only clears call history — drop stale
    // impls/once-queues so tests can't read each other's sequences.
    vi.resetAllMocks();
    vi.mocked(createFlow).mockResolvedValue({ id: 'meta-9', validation_errors: [] });
    vi.mocked(getFlowJson).mockResolvedValue(FLOW_JSON);
  });

  it('publishes in a second call and stores Meta’s final state', async () => {
    const d = db();
    // Draft state on create; published by the time publish returns.
    vi.mocked(getFlow)
      .mockResolvedValueOnce(metaState('DRAFT'))
      .mockResolvedValueOnce(metaState('PUBLISHED'));
    vi.mocked(publishFlow).mockResolvedValue(undefined);

    const result = await createWaFlow(d.client, { ...input, publish: true });

    expect(vi.mocked(createFlow).mock.calls[0][0]).not.toHaveProperty('publish');
    expect(vi.mocked(publishFlow).mock.calls[0][0].flowId).toBe('meta-9');
    expect(result.flow.status).toBe('PUBLISHED');
    expect(d.tables.whatsapp_flows[0].meta_flow_id).toBe('meta-9');
  });

  it('keeps the draft when Meta’s integrity check blocks the publish', async () => {
    const d = db();
    // Create succeeds (Meta really does create the draft), publish is
    // refused — Meta's wording for its account-level integrity gate.
    vi.mocked(getFlow).mockResolvedValue(metaState('DRAFT'));
    vi.mocked(publishFlow).mockRejectedValue(
      new Error(
        'Publishing attempt failed: Flow was created, but publishing failed: Flow publishing failed: Integrity requirements not met. (subcode 4233046) (code 139002)',
      ),
    );

    const err = await createWaFlow(d.client, { ...input, publish: true }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(FlowLifecycleError);
    const message = (err as FlowLifecycleError).message;
    expect(message).toMatch(/account-level check/);
    expect(message).toMatch(/4233046/);
    // The user's JSON must not be stranded in the open dialog.
    expect(d.tables.whatsapp_flows).toHaveLength(1);
    const row = d.tables.whatsapp_flows[0];
    expect(row.status).toBe('DRAFT');
    expect(row.flow_json).toEqual(FLOW_JSON);
  });

  it('passes other publish failures through unchanged', async () => {
    const d = db();
    vi.mocked(getFlow).mockResolvedValue(metaState('DRAFT'));
    vi.mocked(publishFlow).mockRejectedValue(
      new Error('Flow publishing failed: Endpoint not available. (code 139002)'),
    );

    const err = await createWaFlow(d.client, { ...input, publish: true }).then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as Error).message).not.toMatch(/account-level check/);
    expect(d.tables.whatsapp_flows).toHaveLength(1);
  });
});
