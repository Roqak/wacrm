import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Meta resumable upload so the helper is tested in isolation.
vi.mock('./meta-api', () => {
  return {
    uploadResumableMedia: vi.fn(async () => ({ handle: 'HANDLE123' })),
    resolveMetaAppId: vi.fn(async () => null),
  };
});

// The SSRF guard does a real DNS lookup, so stub it — the fixtures below use
// a `.test` hostname that would never resolve. Each test sets the verdict.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { ensureMediaHeaderHandle } from './template-header-handle';
import { resolveMetaAppId, uploadResumableMedia } from './meta-api';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { TemplatePayload } from './template-validators';

function payload(over: Partial<TemplatePayload> = {}): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'image',
    header_media_url: 'https://x.test/img.jpg',
    ...over,
  };
}

function mediaResponse(type = 'image/jpeg', size = 1024, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Response;
}

describe('ensureMediaHeaderHandle', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
    vi.mocked(resolveMetaAppId).mockClear();
    // Token-derived app id fails by default: the env-fallback tests below
    // exercise that path, and the pre-existing tests read META_APP_ID.
    vi.mocked(resolveMetaAppId).mockResolvedValue(null);
    vi.mocked(isDeliverableUrl).mockClear();
    vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is a no-op for text headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi' });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op when a handle already exists', async () => {
    const p = payload({ header_handle: 'existing' });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBe('existing');
  });

  it('throws an actionable error when neither the token nor META_APP_ID names an app', async () => {
    const p = payload();
    await expect(ensureMediaHeaderHandle(p, 'tok')).rejects.toThrow(/META_APP_ID/);
  });

  it('prefers the app id derived from the access token over META_APP_ID', async () => {
    vi.mocked(resolveMetaAppId).mockResolvedValue('app-from-token');
    vi.stubEnv('META_APP_ID', 'app-from-env');
    vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('image/jpeg', 2048)));

    const p = payload();
    await ensureMediaHeaderHandle(p, 'tok');

    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(vi.mocked(uploadResumableMedia).mock.calls[0][0]).toMatchObject({
      appId: 'app-from-token',
    });
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('falls back to META_APP_ID when the token does not name an app', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('image/jpeg', 2048)));

    const p = payload();
    await ensureMediaHeaderHandle(p, 'tok');

    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(vi.mocked(uploadResumableMedia).mock.calls[0][0]).toMatchObject({
      appId: 'app-1',
    });
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('derives + sets header_handle from a valid image URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a non-image content type on an image header', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('text/html')));
    await expect(ensureMediaHeaderHandle(payload(), 'tok')).rejects.toThrow(/JPEG or PNG/);
  });

  it('rejects an image over 5 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mediaResponse('image/png', 6 * 1024 * 1024)),
    );
    await expect(ensureMediaHeaderHandle(payload(), 'tok')).rejects.toThrow(/5 MB/);
  });

  it('derives a handle for a video header and labels the upload MP4', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('video/mp4', 4096)));

    const p = payload({ header_type: 'video', header_media_url: 'https://x.test/promo.mp4' });
    await ensureMediaHeaderHandle(p, 'tok');

    expect(vi.mocked(uploadResumableMedia).mock.calls[0][0]).toMatchObject({
      mimeType: 'video/mp4',
      fileName: 'header.mp4',
    });
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a non-video content type on a video header', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('video/webm')));
    await expect(
      ensureMediaHeaderHandle(
        payload({ header_type: 'video', header_media_url: 'https://x.test/promo.webm' }),
        'tok',
      ),
    ).rejects.toThrow(/MP4 or 3GP/);
  });

  it('rejects a video over 25 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mediaResponse('video/mp4', 26 * 1024 * 1024)),
    );
    await expect(
      ensureMediaHeaderHandle(
        payload({ header_type: 'video', header_media_url: 'https://x.test/promo.mp4' }),
        'tok',
      ),
    ).rejects.toThrow(/25 MB/);
  });

  it('derives a handle for a document header and labels the upload PDF', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mediaResponse('application/pdf', 4096)),
    );

    const p = payload({ header_type: 'document', header_media_url: 'https://x.test/brochure.pdf' });
    await ensureMediaHeaderHandle(p, 'tok');

    expect(vi.mocked(uploadResumableMedia).mock.calls[0][0]).toMatchObject({
      mimeType: 'application/pdf',
      fileName: 'header.pdf',
    });
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a document with an unsupported content type', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mediaResponse('application/zip')),
    );
    await expect(
      ensureMediaHeaderHandle(
        payload({ header_type: 'document', header_media_url: 'https://x.test/archive.zip' }),
        'tok',
      ),
    ).rejects.toThrow(/PDF, DOC/);
  });

  // Regression: `header_media_url` is caller-supplied and any authenticated
  // member can submit a template, so a non-public destination has to be
  // refused *before* the server issues the request — otherwise the status
  // and content-type carried back in the thrown error are an SSRF oracle for
  // loopback, RFC1918 and cloud-metadata addresses.
  it('refuses a non-public header URL without fetching it', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchSpy = vi.fn(async () => mediaResponse('application/json'));
    vi.stubGlobal('fetch', fetchSpy);

    const p = payload({ header_media_url: 'http://169.254.169.254/latest/meta-data/' });
    await expect(ensureMediaHeaderHandle(p, 'tok')).rejects.toThrow(/publicly reachable/);

    expect(isDeliverableUrl).toHaveBeenCalledWith('http://169.254.169.254/latest/meta-data/');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('reports a blocked URL exactly like an unreachable one', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');

    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn(async () => mediaResponse()));
    const blocked = await ensureMediaHeaderHandle(payload(), 'tok').catch(
      (e: Error) => e.message,
    );

    vi.mocked(isDeliverableUrl).mockResolvedValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const unreachable = await ensureMediaHeaderHandle(payload(), 'tok').catch(
      (e: Error) => e.message,
    );

    expect(blocked).toBe(unreachable);
  });

  it('does not follow redirects, so a public URL cannot bounce to an internal one', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.mocked(resolveMetaAppId).mockResolvedValue('app-from-token');
    const fetchSpy = vi.fn(async () => mediaResponse('image/jpeg', 1024));
    vi.stubGlobal('fetch', fetchSpy);

    await ensureMediaHeaderHandle(payload(), 'tok');

    const init = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init).toMatchObject({ redirect: 'manual' });
  });
});