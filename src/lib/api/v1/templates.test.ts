import { describe, it, expect } from 'vitest';

import {
  serializeTemplate,
  templateLifecycleToApi,
} from './templates';
import { TemplateLifecycleError } from '@/lib/whatsapp/template-lifecycle';

describe('serializeTemplate', () => {
  const row = {
    id: 't1',
    name: 'order_update',
    category: 'Utility',
    language: 'en_US',
    header_type: 'text',
    header_content: 'Order {{1}}',
    header_media_url: null,
    body_text: 'Your order {{1}} ships today.',
    footer_text: 'Acme Inc',
    buttons: [{ type: 'URL', text: 'Track', url: 'https://x.co/t' }],
    sample_values: { body: ['A123'], header: ['A123'] },
    status: 'APPROVED',
    meta_template_id: '123456',
    submission_error: null,
    rejection_reason: null,
    last_submitted_at: '2026-01-02T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-03T00:00:00Z',
  };

  it('maps a row onto the public template shape', () => {
    expect(serializeTemplate(row)).toEqual({
      id: 't1',
      status: 'APPROVED',
      name: 'order_update',
      category: 'Utility',
      language: 'en_US',
      header_type: 'text',
      header_content: 'Order {{1}}',
      header_media_url: null,
      body_text: 'Your order {{1}} ships today.',
      footer_text: 'Acme Inc',
      buttons: [{ type: 'URL', text: 'Track', url: 'https://x.co/t' }],
      sample_values: { body: ['A123'], header: ['A123'] },
      meta_template_id: '123456',
      submission_error: null,
      rejection_reason: null,
      last_submitted_at: '2026-01-02T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-03T00:00:00Z',
    });
  });

  it('normalizes missing optional fields to null', () => {
    const minimal = {
      id: 't2',
      name: 'hello_world',
      category: 'Marketing',
      language: 'en_US',
      body_text: 'Hi',
      status: 'DRAFT',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const out = serializeTemplate(minimal);
    expect(out.footer_text).toBe(null);
    expect(out.header_type).toBe(null);
    expect(out.meta_template_id).toBe(null);
    expect(out.buttons).toBe(null);
    expect(out.sample_values).toBe(null);
    expect(out.last_submitted_at).toBe(null);
  });

  it('never exposes internal header_handle', () => {
    const withHandle = { ...row, header_handle: 'resumable-handle-id' };
    expect(Object.keys(serializeTemplate(withHandle))).not.toContain(
      'header_handle'
    );
    expect(JSON.stringify(serializeTemplate(withHandle))).not.toContain(
      'resumable-handle-id'
    );
  });
});

describe('templateLifecycleToApi', () => {
  it('maps statuses onto the envelope code vocabulary', () => {
    expect(
      templateLifecycleToApi(
        new TemplateLifecycleError('never submitted', 400),
      ),
    ).toEqual({ code: 'bad_request', message: 'never submitted', status: 400 });
    expect(
      templateLifecycleToApi(new TemplateLifecycleError('nope', 404)),
    ).toEqual({ code: 'not_found', message: 'nope', status: 404 });
    expect(
      templateLifecycleToApi(new TemplateLifecycleError('limit', 429)),
    ).toEqual({ code: 'rate_limited', message: 'limit', status: 429 });
    // 409 — unused today, but the mapping should be total if the core
    // ever raises it.
    expect(
      templateLifecycleToApi(new TemplateLifecycleError('dup', 409)),
    ).toEqual({ code: 'conflict', message: 'dup', status: 409 });
    expect(
      templateLifecycleToApi(
        new TemplateLifecycleError('Meta edit failed.', 502),
      ),
    ).toEqual({ code: 'internal', message: 'Meta edit failed.', status: 502 });
  });
});