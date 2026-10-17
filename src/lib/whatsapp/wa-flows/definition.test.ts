import { describe, expect, it } from 'vitest';

import {
  entryScreenOf,
  formatFieldValue,
  humanizeFieldName,
  listFieldNames,
  listScreenIds,
  parseFlowSubmission,
  submissionVars,
  summarizeSubmission,
} from './definition';

const SIMPLE = {
  version: '7.0',
  screens: [
    {
      id: 'DETAILS',
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'Form',
            name: 'details_form',
            children: [
              { type: 'TextInput', name: 'name', label: 'Name' },
              { type: 'TextInput', name: 'email', label: 'Email' },
              {
                type: 'If',
                condition: '${data.vip}',
                then: [{ type: 'Dropdown', name: 'tier', label: 'Tier' }],
              },
              { type: 'Footer', label: 'Submit' },
            ],
          },
        ],
      },
    },
    { id: 'DONE', terminal: true, layout: { type: 'SingleColumnLayout', children: [] } },
  ],
};

describe('listScreenIds / entryScreenOf', () => {
  it('lists screens in definition order', () => {
    expect(listScreenIds(SIMPLE)).toEqual(['DETAILS', 'DONE']);
  });

  it('uses the first screen without a routing model', () => {
    expect(entryScreenOf(SIMPLE)).toBe('DETAILS');
  });

  it('uses the screen nothing routes to when a routing model exists', () => {
    const routed = {
      version: '7.0',
      routing_model: { B: ['C'], A: ['B'], C: [] },
      screens: [{ id: 'B' }, { id: 'C' }, { id: 'A' }],
    };
    expect(entryScreenOf(routed)).toBe('A');
  });

  it('returns null for a missing or malformed definition', () => {
    expect(entryScreenOf(null)).toBeNull();
    expect(entryScreenOf({ screens: 'nope' })).toBeNull();
  });
});

describe('listFieldNames', () => {
  it('collects input names through nested layouts, but not the Form container', () => {
    expect(listFieldNames(SIMPLE).sort()).toEqual(['email', 'name', 'tier']);
  });
});

describe('parseFlowSubmission', () => {
  it('parses the JSON string and strips the flow_token', () => {
    expect(
      parseFlowSubmission('{"flow_token":"wacrm_1","name":"Ada","age":"36"}'),
    ).toEqual({ flowToken: 'wacrm_1', fields: { name: 'Ada', age: '36' } });
  });

  it('treats Meta’s "unused" placeholder as no token', () => {
    expect(parseFlowSubmission('{"flow_token":"unused","a":1}').flowToken).toBeNull();
  });

  it('survives malformed JSON with empty fields', () => {
    expect(parseFlowSubmission('{nope')).toEqual({ flowToken: null, fields: {} });
    expect(parseFlowSubmission(undefined)).toEqual({ flowToken: null, fields: {} });
  });
});

describe('display helpers', () => {
  it('humanizes field keys', () => {
    expect(humanizeFieldName('first_name')).toBe('First name');
    expect(humanizeFieldName('dateOfBirth')).toBe('Date Of Birth');
  });

  it('formats arrays and objects', () => {
    expect(formatFieldValue(['a', 'b'])).toBe('a, b');
    expect(formatFieldValue({ x: 1 })).toBe('{"x":1}');
    expect(formatFieldValue(null)).toBe('');
  });

  it('summarizes with the form name and skips empty answers', () => {
    expect(
      summarizeSubmission('Sign up', { name: 'Ada', email: '', topics: ['a', 'b'] }),
    ).toBe('Form submitted: Sign up — Name: Ada, Topics: a, b');
  });

  it('truncates long summaries', () => {
    const s = summarizeSubmission(null, { note: 'x'.repeat(500) }, 50);
    expect(s).toHaveLength(50);
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('submissionVars', () => {
  it('flattens to interpolation-safe string vars, optionally prefixed', () => {
    expect(submissionVars({ 'e-mail': 'a@b.c', tags: ['x', 'y'] }, 'signup')).toEqual({
      signup_e_mail: 'a@b.c',
      signup_tags: 'x, y',
    });
    expect(submissionVars({ name: 'Ada' })).toEqual({ name: 'Ada' });
  });
});
