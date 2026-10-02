"use client";

// ============================================================
// Whether this account has AI reply suggestions turned on.
//
// Read once per page load and shared across every consumer. The inbox
// mounts the suggestion bar for each conversation an agent opens, and
// without the shared promise below each of those would re-fetch a
// setting that changes roughly never.
//
// The value can go stale if an admin flips it mid-session. That is
// deliberate rather than overlooked: the server re-checks the flag on
// every /api/ai/suggest call and refuses when it is off, so a stale
// `true` costs one rejected request, not unwanted spend.
// ============================================================

import { useEffect, useState } from "react";

let cached: Promise<boolean> | null = null;

function fetchSetting(): Promise<boolean> {
  if (cached) return cached;
  cached = fetch("/api/ai/config")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => Boolean(data?.configured && data?.is_active && data?.suggestions_enabled))
    .catch(() => false);
  return cached;
}

export function useAiSuggestionsEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchSetting().then((value) => {
      if (!cancelled) setEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}
