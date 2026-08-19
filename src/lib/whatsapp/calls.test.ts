import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acceptCall,
  preAcceptCall,
  rejectCall,
  terminateCall,
  CallActionError,
} from './calls'

const BASE = {
  phoneNumberId: 'phone-1',
  accessToken: 'token-1',
  callId: 'wacid.abc',
} as const

function okFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true }),
  } as unknown as Response)
}

function errFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response)
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
  return JSON.parse(opts.body as string)
}

beforeEach(() => vi.stubGlobal('fetch', okFetch()))
afterEach(() => vi.unstubAllGlobals())

describe('call actions', () => {
  it('posts to the phone number\'s calls edge with the call id', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)

    await terminateCall(BASE)

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v21.0/phone-1/calls')
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-1',
    )
    expect(bodyOf(fetchMock)).toMatchObject({
      messaging_product: 'whatsapp',
      call_id: 'wacid.abc',
      action: 'terminate',
    })
  })

  it('carries the SDP answer on the two accept actions', async () => {
    for (const [fn, action] of [
      [preAcceptCall, 'pre_accept'],
      [acceptCall, 'accept'],
    ] as const) {
      const fetchMock = okFetch()
      vi.stubGlobal('fetch', fetchMock)

      await fn({ ...BASE, sdpAnswer: 'v=0 answer' })

      expect(bodyOf(fetchMock)).toMatchObject({
        action,
        session: { sdp_type: 'answer', sdp: 'v=0 answer' },
      })
    }
  })

  it('sends no session block on reject or terminate', async () => {
    // Meta rejects the request outright if SDP rides along with an
    // action that has no media to negotiate.
    for (const fn of [rejectCall, terminateCall]) {
      const fetchMock = okFetch()
      vi.stubGlobal('fetch', fetchMock)
      await fn(BASE)
      expect(bodyOf(fetchMock).session).toBeUndefined()
    }
  })

  it('surfaces Meta\'s own message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      errFetch(400, { error: { message: 'Call is no longer active' } }),
    )

    await expect(terminateCall(BASE)).rejects.toBeInstanceOf(CallActionError)
    await expect(terminateCall(BASE)).rejects.toThrowError(
      /Call is no longer active/,
    )
  })

  it('falls back to the status line when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error('not json')
        },
      } as unknown as Response),
    )

    await expect(preAcceptCall({ ...BASE, sdpAnswer: 'x' })).rejects.toThrowError(
      /pre_accept.*503/,
    )
  })
})
