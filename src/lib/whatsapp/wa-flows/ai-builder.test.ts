import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateReply = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/generate', () => ({ generateReply }));

import {
  buildFormBuilderPrompt,
  buildFormWithAi,
  extractJsonObject,
  MAX_REPAIR_ROUNDS,
  parseBuilderAnswer,
  pickFlowJsonVersion,
} from './ai-builder';
import { lintFlowJson } from './lint';
import type { AiConfig } from '@/lib/ai/types';

const config = { provider: 'openai', model: 'm', apiKey: 'k' } as AiConfig;

const GOOD = {
  name: 'Newsletter',
  categories: ['SIGN_UP', 'NOT_A_CATEGORY'],
  flow: {
    version: '1.0',
    screens: [
      {
        id: 'JOIN',
        title: 'Join',
        terminal: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextInput', name: 'email', label: 'Email', 'input-type': 'email', required: true },
            { type: 'Footer', label: 'Join', 'on-click-action': { name: 'complete', payload: { email: '${form.email}' } } },
          ],
        },
      },
    ],
  },
};
const BROKEN = {
  ...GOOD,
  flow: {
    ...GOOD.flow,
    screens: [{ ...GOOD.flow.screens[0], terminal: false }],
  },
};
const reply = (obj: unknown, tokens = 10) => ({
  text: typeof obj === 'string' ? obj : JSON.stringify(obj),
  handoff: false,
  usage: { promptTokens: tokens, completionTokens: tokens, totalTokens: 2 * tokens },
});

beforeEach(() => generateReply.mockReset());

describe('prompt', () => {
  it('teaches an example that our own linter accepts', () => {
    const prompt = buildFormBuilderPrompt('7.0');
    const example = extractJsonObject(prompt.slice(prompt.indexOf('EXAMPLE')));
    const { flow } = parseBuilderAnswer(example, '7.0');
    expect(lintFlowJson(flow)).toEqual([]);
  });
});

describe('extractJsonObject / parseBuilderAnswer', () => {
  it('reads fenced and chatty replies', () => {
    expect(extractJsonObject('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('here: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJsonObject('no json')).toThrow();
  });

  it('pins the version, drops unknown categories, accepts a bare flow', () => {
    const parsed = parseBuilderAnswer(GOOD, '7.2');
    expect(parsed.flow.version).toBe('7.2');
    expect(parsed.categories).toEqual(['SIGN_UP']);
    expect(parseBuilderAnswer(GOOD.flow, '7.2').flow.screens).toBeDefined();
    expect(() => parseBuilderAnswer({ name: 'x' }, '7.2')).toThrow(/flow/);
  });
});

describe('pickFlowJsonVersion', () => {
  it('takes the newest version Meta accepted, numerically', () => {
    expect(pickFlowJsonVersion(['6.3', '7.10', '7.2', null])).toBe('7.10');
    expect(pickFlowJsonVersion([])).toBe('7.0');
    expect(pickFlowJsonVersion(['garbage'])).toBe('7.0');
  });
});

describe('buildFormWithAi', () => {
  it('returns a clean first answer directly', async () => {
    generateReply.mockResolvedValueOnce(reply(GOOD));
    const out = await buildFormWithAi({ config, instruction: 'newsletter', version: '7.0' });
    expect(out.attempts).toBe(1);
    expect(out.flowJson.version).toBe('7.0');
    expect(out.issues).toEqual([]);
    expect(generateReply.mock.calls[0][0].maxOutputTokens).toBeGreaterThan(1024);
  });

  it('feeds lint errors back and accepts the repair', async () => {
    generateReply.mockResolvedValueOnce(reply(BROKEN)).mockResolvedValueOnce(reply(GOOD, 5));
    const out = await buildFormWithAi({ config, instruction: 'newsletter', version: '7.0' });
    expect(out.attempts).toBe(2);
    expect(out.issues).toEqual([]);
    expect(out.usage).toEqual({ promptTokens: 15, completionTokens: 15, totalTokens: 30 });
    // [description, broken answer, repair request, …] — the mock holds
    // the live array, so index rather than read its tail.
    const repairTurn = generateReply.mock.calls[1][0].messages[2];
    expect(repairTurn.role).toBe('user');
    expect(repairTurn.content).toMatch(/terminal/);
  });

  it('recovers from an unparseable answer', async () => {
    generateReply.mockResolvedValueOnce(reply('I cannot')).mockResolvedValueOnce(reply(GOOD));
    const out = await buildFormWithAi({ config, instruction: 'x', version: '7.0' });
    expect(out.attempts).toBe(2);
  });

  it('returns its best attempt with the remaining issues when rounds run out', async () => {
    generateReply.mockResolvedValue(reply(BROKEN));
    const out = await buildFormWithAi({ config, instruction: 'x', version: '7.0' });
    expect(generateReply).toHaveBeenCalledTimes(MAX_REPAIR_ROUNDS + 1);
    expect(out.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('sends the current form and Meta’s errors in edit mode', async () => {
    generateReply.mockResolvedValueOnce(reply(GOOD));
    await buildFormWithAi({
      config,
      instruction: '',
      currentJson: GOOD.flow,
      metaErrors: [{ message: 'Invalid property', line_start: 4 }],
      version: '7.0',
    });
    const first = generateReply.mock.calls[0][0].messages[0].content as string;
    expect(first).toContain('"JOIN"');
    expect(first).toContain('Invalid property');
    expect(first).toContain('[line 4]');
  });

  it('refuses an empty request', async () => {
    await expect(buildFormWithAi({ config, instruction: ' ', version: '7.0' })).rejects.toThrow();
  });
});
