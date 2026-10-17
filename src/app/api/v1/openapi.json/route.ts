// ============================================================
// Serves `GET /api/v1/openapi.json` — the machine-readable contract.
//
// Unauthenticated on purpose: a spec documents the *reachable* API;
// gating it leaks nothing (it names no data) and every real endpoint
// stays guarded by `requireApiKey`. Cache aggressively — the document
// changes only when the code changes.
// ============================================================

import { NextResponse } from 'next/server';

import { buildOpenApiDocument } from '@/lib/api/openapi';

export async function GET() {
  return NextResponse.json(buildOpenApiDocument(), {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': 'application/json',
    },
  });
}