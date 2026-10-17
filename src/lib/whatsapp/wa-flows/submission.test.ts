import { describe, expect, it } from 'vitest';

import { applyFieldMappings, recordFlowSubmission, resolveFlowSubmission } from './submission';
import { fakeDb } from './test-db';

const ACCOUNT = 'acct-1';
const CUSTOM = '0b8f3a52-2a3c-4c0e-9d1a-3f2b1c0d9e8f';

function seed() {
  return fakeDb({
    whatsapp_flow_tokens: [
      { token: 'tok-1', account_id: ACCOUNT, flow_id: 'f-1', meta_flow_id: 'm-1', flow_run_id: 'run-1', contact_id: 'c-1', completed_at: null },
      { token: 'tok-x', account_id: 'acct-2', flow_id: 'f-9', meta_flow_id: 'm-9', flow_run_id: 'run-9', contact_id: null, completed_at: null },
    ],
    whatsapp_flows: [
      { id: 'f-1', account_id: ACCOUNT, meta_flow_id: 'm-1', name: 'Sign up', field_mappings: [{ field: 'email', target: 'email' }] },
      { id: 'f-2', account_id: ACCOUNT, meta_flow_id: 'm-2', name: 'Survey', field_mappings: [] },
      { id: 'f-9', account_id: 'acct-2', meta_flow_id: 'm-9', name: 'Other tenant', field_mappings: [] },
    ],
    messages: [
      { id: 'msg-out', conversation_id: 'conv-1', message_id: 'wamid.out', interactive_payload: { kind: 'flow', flow_id: 'm-2' } },
      { id: 'msg-tpl', conversation_id: 'conv-1', message_id: 'wamid.tpl', interactive_payload: null, template_name: 'promo' },
    ],
    message_templates: [
      { account_id: ACCOUNT, name: 'promo', buttons: [{ type: 'FLOW', text: 'Go', flow_id: 'm-1' }] },
    ],
    contacts: [{ id: 'c-1', account_id: ACCOUNT, name: 'Ada', email: null }],
    custom_fields: [{ id: CUSTOM, account_id: ACCOUNT }],
    contact_custom_values: [],
    whatsapp_flow_responses: [],
  });
}

describe('resolveFlowSubmission', () => {
  it('resolves form, run and mappings from our token', async () => {
    const db = seed();
    const r = await resolveFlowSubmission(db.client, {
      accountId: ACCOUNT,
      conversationId: 'conv-1',
      responseJson: '{"flow_token":"tok-1","email":"ada@example.com"}',
      contextWamid: null,
    });
    expect(r.flowId).toBe('f-1');
    expect(r.flowRunId).toBe('run-1');
    expect(r.flowName).toBe('Sign up');
    expect(r.fields).toEqual({ email: 'ada@example.com' });
    expect(r.fieldMappings).toEqual([{ field: 'email', target: 'email' }]);
    expect(r.summary).toBe('Form submitted: Sign up — Email: ada@example.com');
    expect(r.messageFlowResponse).toEqual({
      flow_id: 'f-1',
      meta_flow_id: 'm-1',
      flow_name: 'Sign up',
      response: { email: 'ada@example.com' },
    });
  });

  it('ignores another account’s token — it must not resume their run', async () => {
    const r = await resolveFlowSubmission(seed().client, {
      accountId: ACCOUNT,
      conversationId: 'conv-1',
      responseJson: '{"flow_token":"tok-x","a":"1"}',
      contextWamid: null,
    });
    expect(r.token).toBeNull();
    expect(r.flowRunId).toBeNull();
    expect(r.flowId).toBeNull();
  });

  it('falls back to the replied-to form message without a token', async () => {
    const r = await resolveFlowSubmission(seed().client, {
      accountId: ACCOUNT,
      conversationId: 'conv-1',
      responseJson: '{"flow_token":"unused","rating":"5"}',
      contextWamid: 'wamid.out',
    });
    expect(r.flowId).toBe('f-2');
    expect(r.flowName).toBe('Survey');
  });

  it('falls back to a replied-to template’s FLOW button', async () => {
    const r = await resolveFlowSubmission(seed().client, {
      accountId: ACCOUNT,
      conversationId: 'conv-1',
      responseJson: '{"x":"1"}',
      contextWamid: 'wamid.tpl',
    });
    expect(r.metaFlowId).toBe('m-1');
    expect(r.flowId).toBe('f-1');
  });
});

describe('applyFieldMappings', () => {
  it('writes built-in columns and account-owned custom fields, skipping blanks', async () => {
    const db = seed();
    const written = await applyFieldMappings(db.client, {
      accountId: ACCOUNT,
      contactId: 'c-1',
      mappings: [
        { field: 'email', target: 'email' },
        { field: 'company', target: 'company' },
        { field: 'size', target: `custom:${CUSTOM}` },
        { field: 'other', target: 'custom:11111111-1111-1111-1111-111111111111' },
      ],
      fields: { email: 'ada@example.com', company: '  ', size: 'L', other: 'x' },
    });
    expect(written.sort()).toEqual(['email', `custom:${CUSTOM}`].sort());
    expect(db.tables.contacts[0].email).toBe('ada@example.com');
    expect(db.tables.contact_custom_values).toEqual([
      expect.objectContaining({ contact_id: 'c-1', custom_field_id: CUSTOM, value: 'L' }),
    ]);
  });
});

describe('recordFlowSubmission', () => {
  it('stores the response, closes the token and applies mappings', async () => {
    const db = seed();
    const submission = await resolveFlowSubmission(db.client, {
      accountId: ACCOUNT,
      conversationId: 'conv-1',
      responseJson: '{"flow_token":"tok-1","email":"ada@example.com"}',
      contextWamid: null,
    });
    const out = await recordFlowSubmission(db.client, {
      accountId: ACCOUNT,
      contactId: 'c-1',
      conversationId: 'conv-1',
      messageId: 'msg-in',
      waMessageId: 'wamid.in',
      submission,
    });
    expect(out.mapped).toEqual(['email']);
    expect(db.tables.whatsapp_flow_responses[0]).toMatchObject({
      account_id: ACCOUNT,
      flow_id: 'f-1',
      flow_token: 'tok-1',
      message_id: 'msg-in',
      wa_message_id: 'wamid.in',
      response: { email: 'ada@example.com' },
    });
    expect(db.tables.whatsapp_flow_tokens[0].completed_at).toBeTruthy();
  });
});
