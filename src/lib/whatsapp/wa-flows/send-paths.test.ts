import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendInteractiveFlow, INTERACTIVE_LIMITS } from '../meta-api';
import { validateInteractivePayload, interactivePayloadPreviewText } from '../interactive';
import { buildSendComponents } from '../template-send-builder';
import { buildMetaTemplatePayload } from '../template-components';
import { validateButtons } from '../template-validators';
import { templateFlowButton } from './send';
import type { MessageTemplate } from '@/types';

afterEach(() => vi.unstubAllGlobals());

describe('validateInteractivePayload — forms', () => {
  const base = { kind: 'flow', body: 'Fill this in', flow_id: '123', cta: 'Open' } as const;

  it('accepts a minimal form payload', () => {
    expect(validateInteractivePayload(base)).toEqual({ ok: true });
  });

  it('requires a form, a button label and Meta’s CTA limit', () => {
    expect(validateInteractivePayload({ ...base, flow_id: '' }).ok).toBe(false);
    expect(validateInteractivePayload({ ...base, cta: ' ' }).ok).toBe(false);
    expect(
      validateInteractivePayload({ ...base, cta: 'x'.repeat(INTERACTIVE_LIMITS.flowCtaMaxLength + 1) }).ok,
    ).toBe(false);
  });

  it('rejects unknown actions and non-object data', () => {
    expect(validateInteractivePayload({ ...base, flow_action: 'teleport' }).ok).toBe(false);
    expect(validateInteractivePayload({ ...base, data: [1] }).ok).toBe(false);
  });

  it('previews as the body, or [form]', () => {
    expect(interactivePayloadPreviewText(base)).toBe('Fill this in');
    expect(interactivePayloadPreviewText({ ...base, body: '' })).toBe('[form]');
  });
});

describe('sendInteractiveFlow', () => {
  it('posts Meta’s flow message shape', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendInteractiveFlow({
      phoneNumberId: 'PN',
      accessToken: 'tok',
      to: '2348000000001',
      bodyText: 'Sign up below',
      headerText: 'Welcome',
      flowId: '999',
      flowCta: 'Sign up',
      flowToken: 'wacrm_abc',
      screen: 'DETAILS',
      data: { plan: 'pro' },
    });
    expect(result.messageId).toBe('wamid.1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/PN/messages');
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '2348000000001',
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: { type: 'text', text: 'Welcome' },
        body: { text: 'Sign up below' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: 'wacrm_abc',
            flow_id: '999',
            flow_cta: 'Sign up',
            flow_action: 'navigate',
            flow_action_payload: { screen: 'DETAILS', data: { plan: 'pro' } },
          },
        },
      },
    });
  });

  it('omits the payload for data_exchange and refuses navigate without a screen', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: 'w' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const args = {
      phoneNumberId: 'PN',
      accessToken: 'tok',
      to: '1',
      bodyText: 'b',
      flowId: '9',
      flowCta: 'Go',
      flowToken: 't',
    };
    await sendInteractiveFlow({ ...args, flowAction: 'data_exchange', mode: 'draft' });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.interactive.action.parameters.flow_action_payload).toBeUndefined();
    expect(sent.interactive.action.parameters.mode).toBe('draft');
    await expect(sendInteractiveFlow(args)).rejects.toThrow(/screen/);
  });
});

const flowTemplate = {
  id: 't',
  user_id: 'u',
  name: 'signup',
  category: 'Utility',
  body_text: 'Hi {{1}}, sign up below',
  buttons: [
    { type: 'QUICK_REPLY', text: 'Later' },
    { type: 'FLOW', text: 'Sign up', flow_id: '999', flow_action: 'navigate', navigate_screen: 'DETAILS' },
  ],
  created_at: '',
} as MessageTemplate;

describe('template FLOW buttons', () => {
  it('submits the button with its form and screen', () => {
    const payload = buildMetaTemplatePayload({
      name: 'signup',
      category: 'Utility',
      language: 'en_US',
      body_text: 'Hi',
      buttons: flowTemplate.buttons,
    });
    expect(payload.components.at(-1)?.buttons?.[1]).toEqual({
      type: 'FLOW',
      text: 'Sign up',
      flow_id: '999',
      flow_action: 'navigate',
      navigate_screen: 'DETAILS',
    });
  });

  it('adds the flow token as a send-time action parameter', () => {
    const components = buildSendComponents(flowTemplate, {
      body: ['Ada'],
      flowToken: 'wacrm_x',
    });
    expect(components).toContainEqual({
      type: 'button',
      sub_type: 'flow',
      index: '1',
      parameters: [{ type: 'action', action: { flow_token: 'wacrm_x' } }],
    });
  });

  it('sends no button component without a token', () => {
    const components = buildSendComponents(flowTemplate, { body: ['Ada'] });
    expect(components.some((c) => c.type === 'button')).toBe(false);
  });

  it('validates form buttons', () => {
    expect(() => validateButtons(flowTemplate.buttons)).not.toThrow();
    expect(() =>
      validateButtons([{ type: 'FLOW', text: 'Go', flow_id: '' }]),
    ).toThrow(/needs a form/);
    expect(() =>
      validateButtons([{ type: 'FLOW', text: 'Go', flow_id: '1', flow_action: 'navigate' }]),
    ).toThrow(/screen/);
    expect(() =>
      validateButtons([
        { type: 'FLOW', text: 'A', flow_id: '1', flow_action: 'data_exchange' },
        { type: 'FLOW', text: 'B', flow_id: '2', flow_action: 'data_exchange' },
      ]),
    ).toThrow(/At most 1/);
  });

  it('finds the template’s form button', () => {
    expect(templateFlowButton(flowTemplate)).toEqual({ flow_id: '999' });
    expect(templateFlowButton({ buttons: [{ type: 'QUICK_REPLY', text: 'x' }] })).toBeNull();
    expect(templateFlowButton(null)).toBeNull();
  });
});
