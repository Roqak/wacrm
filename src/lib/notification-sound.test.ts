import { describe, expect, it } from 'vitest'

import {
  MIN_CHIME_GAP_MS,
  readSoundPreference,
  serializeSoundPreference,
  shouldChime,
} from './notification-sound'

describe('readSoundPreference', () => {
  it('defaults to on when nothing is stored', () => {
    expect(readSoundPreference(null)).toBe(true)
  })

  it('is off only for the explicit off value', () => {
    expect(readSoundPreference('off')).toBe(false)
    expect(readSoundPreference('on')).toBe(true)
    // Anything unrecognized (a hand-edited key, a value from a future
    // version) falls back to on rather than silently muting.
    expect(readSoundPreference('yes please')).toBe(true)
  })

  it('round-trips', () => {
    for (const enabled of [true, false]) {
      expect(readSoundPreference(serializeSoundPreference(enabled))).toBe(enabled)
    }
  })
})

describe('shouldChime', () => {
  it('always plays the first one', () => {
    expect(shouldChime(null, 1_000)).toBe(true)
  })

  it('collapses a burst into a single chime', () => {
    // Six messages inside the gap — or a Realtime reconnect replaying a
    // backlog — must not machine-gun.
    const first = 10_000
    expect(shouldChime(first, first + 100)).toBe(false)
    expect(shouldChime(first, first + MIN_CHIME_GAP_MS - 1)).toBe(false)
  })

  it('plays again once the gap has passed', () => {
    const first = 10_000
    expect(shouldChime(first, first + MIN_CHIME_GAP_MS)).toBe(true)
    expect(shouldChime(first, first + MIN_CHIME_GAP_MS + 5_000)).toBe(true)
  })
})
