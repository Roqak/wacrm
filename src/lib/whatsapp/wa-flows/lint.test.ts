import { describe, expect, it } from 'vitest';

import { lintErrors, lintFlowJson } from './lint';
import { STARTER_FLOW_JSON } from '@/components/settings/forms/starter-flow';

const screen = (over: Record<string, unknown>) => ({
  id: 'A',
  title: 'A',
  layout: { type: 'SingleColumnLayout', children: [] as unknown[] },
  ...over,
});
const footer = (action: Record<string, unknown>, label = 'Go') => ({
  type: 'Footer',
  label,
  'on-click-action': action,
});
const complete = (payload: Record<string, unknown> = {}) => footer({ name: 'complete', payload });
const navigate = (to: string, payload?: Record<string, unknown>) =>
  footer({ name: 'navigate', next: { type: 'screen', name: to }, ...(payload ? { payload } : {}) });
const flow = (...screens: unknown[]) => ({ version: '7.0', screens });
const messages = (json: unknown) => lintErrors(lintFlowJson(json)).map((i) => i.message);

describe('lintFlowJson', () => {
  it('passes the starter form', () => {
    expect(lintFlowJson(STARTER_FLOW_JSON)).toEqual([]);
  });

  it('passes a correct two-screen form that carries data forward', () => {
    const json = flow(
      screen({
        id: 'ONE',
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextInput', name: 'email', label: 'Email', 'input-type': 'email' },
            navigate('TWO', { email: '${form.email}' }),
          ],
        },
      }),
      screen({
        id: 'TWO',
        terminal: true,
        data: { email: { type: 'string', __example__: 'a@b.c' } },
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'RadioButtonsGroup', name: 'plan', label: 'Plan', 'data-source': [{ id: 'a', title: 'A' }] },
            complete({ email: '${data.email}', plan: '${form.plan}' }),
          ],
        },
      }),
    );
    expect(lintFlowJson(json)).toEqual([]);
  });

  it('requires a version and screens', () => {
    expect(messages({ screens: [] })).toEqual(
      expect.arrayContaining(['Missing "version".', 'Needs at least one screen.']),
    );
  });

  it('rejects bad / duplicate / reserved screen ids', () => {
    const term = { terminal: true, layout: { type: 'SingleColumnLayout', children: [complete()] } };
    expect(messages(flow(screen({ ...term, id: 'my-screen' })))[0]).toMatch(/letters and underscores/);
    expect(messages(flow(screen({ ...term, id: 'SUCCESS' })))[0]).toMatch(/reserved/);
    expect(messages(flow(screen({ ...term, id: 'X' }), screen({ ...term, id: 'X' })))).toEqual(
      expect.arrayContaining([expect.stringMatching(/Duplicate screen id/)]),
    );
  });

  it('flags complete off a terminal screen, dead ends and missing terminal', () => {
    const out = messages(
      flow(
        screen({ id: 'A', layout: { type: 'SingleColumnLayout', children: [complete()] } }),
        screen({ id: 'B', layout: { type: 'SingleColumnLayout', children: [] } }),
      ),
    );
    expect(out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/only allowed on a terminal screen/),
        expect.stringMatching(/dead end/),
        expect.stringMatching(/At least one screen must be terminal/),
      ]),
    );
  });

  it('flags navigation to unknown screens and undeclared payload keys', () => {
    const out = messages(
      flow(
        screen({ id: 'A', layout: { type: 'SingleColumnLayout', children: [navigate('NOPE')] } }),
        screen({
          id: 'B',
          terminal: true,
          layout: { type: 'SingleColumnLayout', children: [navigate('A', { x: '1' }), complete()] },
        }),
      ),
    );
    expect(out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/"NOPE", which isn't a screen/),
        expect.stringMatching(/Passes "x" to A/),
        'A screen can have only one Footer.',
      ]),
    );
  });

  it('flags data types that disagree with what the payload sends', () => {
    const input = (name: string, extra: Record<string, unknown> = {}) => ({
      type: 'TextInput',
      name,
      label: name,
      ...extra,
    });
    const out = lintFlowJson(
      flow(
        screen({
          id: 'A',
          layout: {
            type: 'SingleColumnLayout',
            children: [
              input('bvn', { 'input-type': 'number' }),
              { type: 'OptIn', name: 'ok', label: 'I agree' },
              navigate('B', { bvn: '${form.bvn}', ok: '${form.ok}', note: 'literal' }),
            ],
          },
        }),
        screen({
          id: 'B',
          data: {
            bvn: { type: 'number', __example__: 1 },
            ok: { type: 'boolean', __example__: true },
            note: { type: 'number', __example__: 1 },
          },
          layout: { type: 'SingleColumnLayout', children: [navigate('C', { bvn: '${data.bvn}' })] },
        }),
        screen({
          id: 'C',
          terminal: true,
          data: { bvn: { type: 'string', __example__: '1' } },
          layout: { type: 'SingleColumnLayout', children: [complete({ bvn: '${data.bvn}' })] },
        }),
      ),
    );
    expect(lintErrors(out).map((i) => [i.path, i.message])).toEqual([
      ['screens[1].data.bvn', expect.stringMatching(/B declares "bvn" as "number", but A sends a string/)],
      ['screens[2].data.bvn', expect.stringMatching(/C declares "bvn" as "string", but B sends a number/)],
    ]);
  });

  it('flags dangling ${form.x} / ${data.x} references', () => {
    const out = messages(
      flow(
        screen({
          terminal: true,
          layout: {
            type: 'SingleColumnLayout',
            children: [complete({ a: '${form.ghost}', b: '${data.missing}' })],
          },
        }),
      ),
    );
    expect(out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/no input named "ghost"/),
        expect.stringMatching(/doesn't declare "missing"/),
      ]),
    );
  });

  it('checks inputs: names, labels, options, unknown components, limits', () => {
    const out = messages(
      flow(
        screen({
          terminal: true,
          layout: {
            type: 'SingleColumnLayout',
            children: [
              { type: 'TextInput', name: 'bad name', label: 'X' },
              { type: 'TextInput', name: 'a', label: 'A' },
              { type: 'TextArea', name: 'a', label: 'Dup' },
              { type: 'Dropdown', name: 'd', label: 'D', 'data-source': [] },
              { type: 'RadioButtonsGroup', name: 'r', label: 'R', 'data-source': [{ id: 'x', title: 'y'.repeat(31) }] },
              { type: 'Slider', name: 's' },
              complete({}),
            ],
          },
        }),
      ),
    );
    expect(out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/needs a "name"/),
        expect.stringMatching(/Duplicate input name "a"/),
        expect.stringMatching(/non-empty "data-source"/),
        expect.stringMatching(/Meta allows 30/),
        'Unknown component type "Slider".',
      ]),
    );
  });

  it('requires a routing model and data_api_version for data_exchange', () => {
    const out = messages(
      flow(screen({ terminal: true, layout: { type: 'SingleColumnLayout', children: [footer({ name: 'data_exchange' })] } })),
    );
    expect(out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/need a "routing_model"/),
        expect.stringMatching(/data_api_version/),
      ]),
    );
  });

  it('warns about unreachable screens without failing', () => {
    const term = { terminal: true, layout: { type: 'SingleColumnLayout', children: [complete()] } };
    const issues = lintFlowJson(flow(screen({ ...term, id: 'A' }), screen({ ...term, id: 'B' })));
    expect(lintErrors(issues)).toEqual([]);
    expect(issues.some((i) => i.severity === 'warning' && /never reach/.test(i.message))).toBe(true);
  });
});
