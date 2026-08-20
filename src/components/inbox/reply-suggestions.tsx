"use client";

// ============================================================
// AI reply suggestions, above the composer.
//
// Click a chip and its text lands in the composer for the agent to edit
// and send. Nothing is sent by clicking — this is the "draft with AI"
// button's output, offered before it is asked for.
//
// What controls the spend
//
//   Each render of this bar can cost a provider call, so the rules for
//   asking are strict and all of them are here rather than spread
//   through the composer:
//
//     - the account's admin turned suggestions on
//     - a customer message is the most recent thing in the thread
//       (if we spoke last, the agent is not waiting on a reply)
//     - the composer is empty (an agent mid-sentence has already
//       decided what to say)
//     - the 24h session is open, since a freeform reply cannot be sent
//       after it closes anyway
//
//   And it asks once per inbound message, not once per render or per
//   visit: the fetch is keyed on the triggering message id, so
//   switching away and back re-reads the same suggestions rather than
//   buying them twice.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";

interface ReplySuggestionsProps {
  conversationId: string;
  /**
   * Id of the customer message the suggestions should answer. Null when
   * there is nothing to answer — we sent the last message, the thread is
   * empty, or the session has expired. Changing it is what triggers a
   * fresh fetch; a null clears the bar without spending anything.
   */
  triggerMessageId: string | null;
  /** Account setting. False keeps this component completely silent. */
  enabled: boolean;
  /** True when the agent has typed something. */
  composerBusy: boolean;
  onPick: (text: string) => void;
}

export function ReplySuggestions({
  conversationId,
  triggerMessageId,
  enabled,
  composerBusy,
  onPick,
}: ReplySuggestionsProps) {
  const t = useTranslations("Inbox.suggestions");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  // Dismissed for this particular message — an agent who closes the bar
  // should not have it reappear until the customer says something new.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // Which message id we have already spent a call on, so a remount or a
  // conversation switch-and-back does not buy the same answer twice.
  const fetchedForRef = useRef<string | null>(null);

  const shouldAsk =
    enabled && !composerBusy && !!triggerMessageId && dismissedFor !== triggerMessageId;

  useEffect(() => {
    if (!shouldAsk || !triggerMessageId) {
      if (!triggerMessageId) setSuggestions([]);
      return;
    }
    if (fetchedForRef.current === triggerMessageId) return;
    fetchedForRef.current = triggerMessageId;

    let cancelled = false;
    setLoading(true);
    setSuggestions([]);

    (async () => {
      try {
        const res = await fetch("/api/ai/suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: conversationId }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        // Failures are silent by design. This is an unrequested
        // convenience: an agent who never asked for suggestions should
        // not be shown an error about them, and a misconfigured key
        // already surfaces loudly on the ✨ button and in Settings.
        if (!res.ok || !Array.isArray(data.suggestions)) return;
        setSuggestions(data.suggestions.filter((s: unknown) => typeof s === "string"));
      } catch {
        // Same reasoning — stay quiet.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [shouldAsk, triggerMessageId, conversationId]);

  const handlePick = useCallback(
    (text: string) => {
      onPick(text);
      // Clear rather than leave them under a composer that now holds
      // the chosen text — the other options are no longer offers.
      setSuggestions([]);
      if (triggerMessageId) setDismissedFor(triggerMessageId);
    },
    [onPick, triggerMessageId],
  );

  if (!enabled || composerBusy) return null;
  if (!loading && suggestions.length === 0) return null;

  return (
    <div className="mb-2" aria-live="polite">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Sparkles className="size-3 text-primary" />
        <span className="text-[11px] font-medium text-muted-foreground">
          {loading ? t("thinking") : t("label")}
        </span>
        {!loading && (
          <button
            type="button"
            onClick={() => triggerMessageId && setDismissedFor(triggerMessageId)}
            aria-label={t("dismiss")}
            className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {loading ? (
        // Skeleton chips rather than a spinner: they hold the space the
        // real chips will take, so the composer doesn't jump when they
        // land.
        <div className="flex flex-wrap gap-2">
          <div className="h-7 w-40 animate-pulse rounded-full bg-muted" />
          <div className="h-7 w-32 animate-pulse rounded-full bg-muted" />
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s, i) => (
            <button
              key={`${i}-${s.slice(0, 24)}`}
              type="button"
              onClick={() => handlePick(s)}
              title={s}
              className="max-w-full truncate rounded-full border border-border bg-muted/60 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-muted"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
