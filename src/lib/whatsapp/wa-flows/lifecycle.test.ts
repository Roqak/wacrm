import { describe, expect, it } from 'vitest';

import {
  FlowLifecycleError,
  effectiveFirstScreen,
  normalizeFlowStatus,
  validateCategories,
  validateFieldMappings,
  validateFlowJson,
} from './lifecycle';

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
