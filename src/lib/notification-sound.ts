// ============================================================
// The inbound-message chime.
//
// Synthesized with the Web Audio API rather than shipped as an audio
// file. Two reasons: there is no asset to license, host, cache-bust or
// fetch (so it also works with the tab offline), and a generated tone
// is a few hundred bytes of code against ~20KB of MP3 that every page
// load would pull.
//
// Autoplay is the constraint that shapes everything here. Browsers
// start an AudioContext suspended until the user has interacted with
// the page, so a chime for a message that arrives before the agent has
// clicked anything is simply not allowed to play. `primeAudio` resumes
// the context on the first interaction; until then `playChime` is a
// no-op rather than an error. That is a browser rule, not something
// this app can opt out of.
//
// Device-scoped like the theme: a preference about this machine's
// speakers has no business syncing to a teammate's browser.
// ============================================================

export const SOUND_STORAGE_KEY = 'wacrm.messageSound';

/** Minimum gap between chimes. */
export const MIN_CHIME_GAP_MS = 2_000;

/**
 * Read the stored preference. Defaults to on: an agent watching an
 * inbox expects to be told when something lands, and the browser's own
 * autoplay rule already prevents this from making noise at someone who
 * has not interacted with the page yet.
 */
export function readSoundPreference(raw: string | null): boolean {
  if (raw === null) return true;
  return raw !== 'off';
}

export function serializeSoundPreference(enabled: boolean): string {
  return enabled ? 'on' : 'off';
}

/**
 * Whether a chime is due, given when the last one played.
 *
 * A burst — a customer sending six messages in four seconds, or a
 * Realtime reconnect replaying a backlog — should sound once, not six
 * times. Pure so the rule is testable without an AudioContext.
 */
export function shouldChime(
  lastPlayedAt: number | null,
  now: number,
  minGapMs: number = MIN_CHIME_GAP_MS,
): boolean {
  if (lastPlayedAt === null) return true;
  return now - lastPlayedAt >= minGapMs;
}

// ------------------------------------------------------------
// Audio
// ------------------------------------------------------------

type WindowWithWebkitAudio = Window &
  typeof globalThis & { webkitAudioContext?: typeof AudioContext };

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (context) return context;
  const w = window as WindowWithWebkitAudio;
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null; // No Web Audio (very old browser) — stay silent.
  context = new Ctor();
  return context;
}

/**
 * Resume the audio context. Must be called from a real user gesture —
 * calling it on mount does nothing, because that is precisely what the
 * autoplay policy is there to stop.
 */
export function primeAudio(): void {
  const ctx = getContext();
  if (ctx && ctx.state === 'suspended') void ctx.resume();
}

/**
 * Play the chime: two short notes, a rising fourth, at low volume.
 *
 * Every note is shaped with an attack/decay envelope. A bare oscillator
 * switched on and off produces a click at each end — the discontinuity
 * is audible as a pop, and on a notification sound it reads as a bug.
 */
export function playChime(volume = 0.15): void {
  const ctx = getContext();
  // Suspended means the user has not interacted yet, so playing is not
  // permitted. Return quietly: this is an expected state, not a fault.
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;
  const notes = [
    { freq: 660, at: 0, length: 0.12 },
    { freq: 880, at: 0.1, length: 0.18 },
  ];

  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    // Sine rather than square/saw: no harmonics means no harshness at
    // the volume a notification should sit at.
    osc.type = 'sine';
    osc.frequency.value = note.freq;

    const start = now + note.at;
    const end = start + note.length;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}
