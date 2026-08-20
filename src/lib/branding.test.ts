import { describe, expect, it } from 'vitest'

import {
  BRAND_NAME_MAX_LEN,
  displayBrandName,
  normalizeBrandLogoUrl,
  normalizeBrandName,
} from './branding'

describe('normalizeBrandName', () => {
  it('trims and keeps a real name', () => {
    expect(normalizeBrandName('  Acme Support  ')).toEqual({
      ok: true,
      value: 'Acme Support',
    })
  })

  it('treats blank and null as "unbranded", not as an error', () => {
    // Clearing the field has to restore the translated built-in name,
    // so empty must normalize to null rather than to a default string.
    for (const input of ['', '   ', null]) {
      expect(normalizeBrandName(input)).toEqual({ ok: true, value: null })
    }
  })

  it('rejects an over-long name', () => {
    const res = normalizeBrandName('x'.repeat(BRAND_NAME_MAX_LEN + 1))
    expect(res.ok).toBe(false)
  })

  it('rejects a non-string', () => {
    expect(normalizeBrandName(42).ok).toBe(false)
  })
})

describe('normalizeBrandLogoUrl', () => {
  it('accepts http and https', () => {
    expect(normalizeBrandLogoUrl('https://cdn.example.com/logo.png')).toEqual({
      ok: true,
      value: 'https://cdn.example.com/logo.png',
    })
    expect(normalizeBrandLogoUrl('http://example.com/l.svg').ok).toBe(true)
  })

  it('rejects script-bearing schemes', () => {
    // The value lands in an <img src> that every member of the account
    // renders, and any admin can set it.
    for (const bad of [
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'file:///etc/passwd',
    ]) {
      expect(normalizeBrandLogoUrl(bad).ok).toBe(false)
    }
  })

  it('rejects something that is not a URL at all', () => {
    expect(normalizeBrandLogoUrl('logo.png').ok).toBe(false)
  })

  it('clears on blank', () => {
    expect(normalizeBrandLogoUrl('  ')).toEqual({ ok: true, value: null })
  })
})

describe('displayBrandName', () => {
  it('prefers the brand name and falls back to the translated default', () => {
    expect(displayBrandName('Acme', 'CRM Template')).toBe('Acme')
    expect(displayBrandName(null, 'CRM Template')).toBe('CRM Template')
    expect(displayBrandName('   ', 'CRM Template')).toBe('CRM Template')
  })
})
