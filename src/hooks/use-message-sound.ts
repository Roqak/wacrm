"use client";

// ============================================================
// Preference + playback for the inbound-message chime.
//
// Device-scoped (localStorage), like the theme: whether this machine's
// speakers should make a noise is not a fact about the account.
//
// The gesture listener is the part worth understanding. Browsers keep
// an AudioContext suspended until the user interacts with the page, so
// the chime cannot play for a message that arrives before the agent has
// clicked anything. We attach one-shot pointer/key listeners that
// resume the context on the first interaction of the session, which is
// as early as the browser permits.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MIN_CHIME_GAP_MS,
  playChime,
  primeAudio,
  readSoundPreference,
  serializeSoundPreference,
  shouldChime,
  SOUND_STORAGE_KEY,
} from "@/lib/notification-sound";

export interface UseMessageSound {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  /** Chime, subject to the preference and the burst throttle. */
  notify: () => void;
  /** Chime now regardless of the throttle — for the "test" button. */
  preview: () => void;
}

function readInitialPreference(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return readSoundPreference(localStorage.getItem(SOUND_STORAGE_KEY));
  } catch {
    // localStorage throws in private-browsing / sandboxed contexts.
    return true;
  }
}

export function useMessageSound(): UseMessageSound {
  // Lazy initializer, guarded for the server — the same shape
  // `use-theme` uses to read its localStorage keys. Reading in an
  // effect instead would set state during mount for every user, which
  // is a cascading render for a value that is knowable up front.
  const [enabled, setEnabledState] = useState(readInitialPreference);
  const lastPlayedRef = useRef<number | null>(null);

  // Unlock audio at the first interaction. `once: true` on each, and
  // both are removed as soon as either fires.
  useEffect(() => {
    const unlock = () => {
      primeAudio();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      localStorage.setItem(SOUND_STORAGE_KEY, serializeSoundPreference(next));
    } catch {
      // Same as above — the in-memory preference still applies for
      // this session even if it can't be persisted.
    }
    // Turning it on is itself a click, so it doubles as the gesture
    // that unlocks audio. Without this, switching it on and waiting
    // would still be silent until some later click.
    if (next) primeAudio();
  }, []);

  const notify = useCallback(() => {
    if (!enabled) return;
    const now = Date.now();
    if (!shouldChime(lastPlayedRef.current, now, MIN_CHIME_GAP_MS)) return;
    lastPlayedRef.current = now;
    playChime();
  }, [enabled]);

  const preview = useCallback(() => {
    primeAudio();
    playChime();
  }, []);

  return { enabled, setEnabled, notify, preview };
}
