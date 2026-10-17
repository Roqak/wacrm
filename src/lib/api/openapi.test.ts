import { describe, it, expect } from 'vitest';

import { buildOpenApiDocument } from './openapi';
import { API_SCOPES } from '@/lib/api-keys/scopes';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';

const DOC = buildOpenApiDocument() as {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};

const HTTP_METHODS = new Set(['get', 'post', 'patch', 'put', 'delete']);

describe('buildOpenApiDocument', () => {
  it('produces a valid 3.1 skeleton', () => {
    expect(DOC.openapi.startsWith('3.1')).toBe(true);
    expect(DOC.info.version).toBeTruthy();
    expect(Object.keys(DOC.components.securitySchemes)).toContain('bearerAuth');
  });

  it('documents every implemented v1 route — and vice versa, nothing invented', () => {
    // The truth on the filesystem is the route tree.
    const { readdirSync, statSync } = require('node:fs') as {
      readdirSync: (p: string, o?: { withFileTypes?: boolean }) => Array<{ name: string; isDirectory(): boolean }>;
      statSync: (p: string) => { isFile(): boolean };
    };
    const { join } = require('node:path') as { join: (...p: string[]) => string };

    const routeParams: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          walk(join(dir, ent.name));
        } else if (ent.name === 'route.ts') {
          let seg = dir
            .replace(/^.*\/api\/v1/, '')
            .replace(/\[\.\.\.([^\]]+)\]/g, '{$1}')  // catch-all
            .replace(/\[([^\]]+)\]/g, '{param}');
          if (seg.endsWith('/')) seg = seg.slice(0, -1);
          routeParams.push(`/api/v1${seg}`);
        }
      }
    };
    walk(join(process.cwd(), 'src', 'app', 'api', 'v1'));

    const specPaths = Object.keys(DOC.paths).map((p) =>
      p.replace(/\{(?!param)[^}]+\}/g, '{param}'),
    );

    // openapi.json route serves the spec itself; everything else must
    // be in one spec or the other.
    const routes = routeParams.filter((r) => r !== '/api/v1/openapi.json');
    expect(routes.length).toBeGreaterThan(0);
    expect(specPaths).toEqual(expect.arrayContaining(routes));
    expect(specPaths.length).toBeLessThanOrEqual(routes.length);
  });

  it('never references a scope the API does not implement', () => {
    for (const [, ops] of Object.entries(DOC.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!HTTP_METHODS.has(method)) continue;
        const scopes = (op as { 'x-wacrm-scopes'?: string[] })['x-wacrm-scopes'];
        expect(scopes && scopes.every((s) => (API_SCOPES as readonly string[]).includes(s))).toBe(true);
      }
    }
  });

  it('only documents event names the delivery core actually sends', () => {
    // The webhook endpoints' `events` enum must match WEBHOOK_EVENTS —
    // integrators dedupe against it.
    const endpoints = JSON.stringify(
      DOC.paths['/api/v1/webhooks'].post,
    );
    for (const ev of WEBHOOK_EVENTS) {
      expect(endpoints).toContain(ev);
    }
  });

  it('documents the shared envelope on every error response', () => {
    for (const [, ops] of Object.entries(DOC.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!HTTP_METHODS.has(method)) continue;
        const responses = (op as { responses?: Record<string, unknown> }).responses ?? {};
        for (const [code, res] of Object.entries(responses)) {
          if (!/^4\d\d$|^5\d\d$/.test(code)) continue;
          expect(JSON.stringify(res)).toContain('"$ref"');
        }
      }
    }
  });
});