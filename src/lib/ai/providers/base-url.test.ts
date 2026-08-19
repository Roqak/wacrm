import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  normalizeBaseUrl,
  privateBaseUrlAllowed,
  resolveBaseUrl,
  assertBaseUrlAllowed,
} from './base-url'
import { OLLAMA_CLOUD_BASE_URL, OLLAMA_DEFAULT_BASE_URL } from '../defaults'

// `assertBaseUrlAllowed` resolves hostnames, so the reachability half is
// tested against a stubbed `isDeliverableUrl` — the DNS behaviour itself
// already has coverage in `src/lib/webhooks/ssrf.test.ts`.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(),
}))
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

const originalEnv = process.env.AI_ALLOW_PRIVATE_BASE_URL

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockReset()
  delete process.env.AI_ALLOW_PRIVATE_BASE_URL
})
afterEach(() => {
  if (originalEnv === undefined) delete process.env.AI_ALLOW_PRIVATE_BASE_URL
  else process.env.AI_ALLOW_PRIVATE_BASE_URL = originalEnv
})

describe('normalizeBaseUrl', () => {
  it('keeps the origin and drops any path', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1/chat/completions')).toBe(
      'http://localhost:11434',
    )
    expect(normalizeBaseUrl('  https://ollama.example.com/  ')).toBe(
      'https://ollama.example.com',
    )
  })

  it('rejects an empty value', () => {
    expect(() => normalizeBaseUrl('   ')).toThrowError(/required/i)
  })

  it('rejects a malformed URL', () => {
    expect(() => normalizeBaseUrl('not a url')).toThrowError(/not a valid URL/i)
  })

  it('rejects non-http schemes', () => {
    // file: would aim the fetch at the server's own filesystem.
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrowError(/http/i)
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrowError(/http/i)
  })

  it('rejects a host typed without a scheme', () => {
    // The likeliest thing an admin actually types. It does NOT fail
    // parsing — `new URL('localhost:11434')` succeeds, reading
    // `localhost:` as the scheme and `11434` as the path — so the
    // protocol check is what catches it, and the message says to add
    // http:// rather than claiming the URL is malformed.
    expect(() => normalizeBaseUrl('localhost:11434')).toThrowError(/http/i)
    expect(() => normalizeBaseUrl('ollama.example.com')).toThrowError(
      /not a valid URL/i,
    )
  })
})

describe('privateBaseUrlAllowed', () => {
  it('is off unless explicitly set', () => {
    expect(privateBaseUrlAllowed()).toBe(false)
    process.env.AI_ALLOW_PRIVATE_BASE_URL = 'false'
    expect(privateBaseUrlAllowed()).toBe(false)
    // A typo must not read as consent.
    process.env.AI_ALLOW_PRIVATE_BASE_URL = 'maybe'
    expect(privateBaseUrlAllowed()).toBe(false)
  })

  it('accepts the affirmative spellings', () => {
    for (const v of ['true', 'TRUE', '1', 'yes']) {
      process.env.AI_ALLOW_PRIVATE_BASE_URL = v
      expect(privateBaseUrlAllowed()).toBe(true)
    }
  })
})

describe('assertBaseUrlAllowed', () => {
  it('rejects a private address when the operator has not opted in', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false)
    await expect(
      assertBaseUrlAllowed('http://localhost:11434'),
    ).rejects.toMatchObject({ code: 'base_url_not_allowed', status: 400 })
  })

  it('allows a private address once opted in, without a lookup', async () => {
    process.env.AI_ALLOW_PRIVATE_BASE_URL = 'true'
    await expect(
      assertBaseUrlAllowed('http://localhost:11434'),
    ).resolves.toBeUndefined()
    expect(isDeliverableUrl).not.toHaveBeenCalled()
  })

  it('allows a publicly-routable address with no opt-in', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(true)
    await expect(
      assertBaseUrlAllowed('https://ollama.example.com'),
    ).resolves.toBeUndefined()
  })
})

describe('resolveBaseUrl', () => {
  it('ignores the stored value for hosted providers', () => {
    // The guarantee that matters: a row cannot redirect a hosted call.
    expect(resolveBaseUrl('openai', 'http://evil.test')).toBeNull()
    expect(resolveBaseUrl('anthropic', 'http://evil.test')).toBeNull()
    expect(resolveBaseUrl('ollama_cloud', 'http://evil.test')).toBe(
      OLLAMA_CLOUD_BASE_URL,
    )
  })

  it('uses the stored value for a self-hosted server', () => {
    expect(resolveBaseUrl('ollama', 'http://10.0.0.5:11434/')).toBe(
      'http://10.0.0.5:11434',
    )
  })

  it('falls back to the Ollama default when none is stored', () => {
    expect(resolveBaseUrl('ollama', null)).toBe(OLLAMA_DEFAULT_BASE_URL)
  })
})
