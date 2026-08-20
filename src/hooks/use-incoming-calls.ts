"use client";

// ============================================================
// Live inbound calls for the signed-in agent.
//
// The webhook inserts a `calls` row; Supabase Realtime delivers it here.
// Realtime evaluates the table's SELECT policy per subscriber, so an
// agent restricted to their own conversations (migration 040) is never
// woken by a call on a thread they cannot see — the filtering is the
// database's, not this hook's.
//
// This hook owns *which* calls exist and who they are for. The WebRTC
// session itself lives in `use-call-session`, so the ringing list stays
// mounted (and keeps receiving events) independently of whether a call
// is currently being answered.
// ============================================================

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { Call } from "@/types";

/** Statuses that mean "this call is still happening". */
const LIVE_STATUSES: Call["status"][] = ["ringing", "connecting", "connected"];

function isLive(call: Call): boolean {
  return LIVE_STATUSES.includes(call.status);
}

export interface UseIncomingCalls {
  /** Live calls, newest first. Usually zero or one. */
  calls: Call[];
  /** Drop a call from local state without waiting for the row update. */
  dismiss: (callId: string) => void;
}

export function useIncomingCalls(currentUserId?: string): UseIncomingCalls {
  const [calls, setCalls] = useState<Call[]>([]);

  const dismiss = useCallback((callId: string) => {
    setCalls((prev) => prev.filter((c) => c.id !== callId));
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // Catch up on anything already ringing. A page load mid-call (a
    // refresh, or a second tab) should show it rather than wait for an
    // event that has already been and gone.
    (async () => {
      const { data, error } = await supabase
        .from("calls")
        .select("*")
        .in("status", LIVE_STATUSES)
        .order("started_at", { ascending: false });
      if (cancelled || error || !data) return;
      setCalls(data as Call[]);
    })();

    const channel = supabase
      .channel("calls-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "calls" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<Call>;
            if (old.id) dismiss(old.id);
            return;
          }
          const row = payload.new as Call;
          setCalls((prev) => {
            const without = prev.filter((c) => c.id !== row.id);
            // A call that has ended leaves the list entirely — the
            // history view reads the table directly, so there is no
            // reason to hold a finished call in live state.
            if (!isLive(row)) return without;
            return [row, ...without];
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [dismiss]);

  // Show a ringing call to the agent it was routed to, and to everyone
  // when it is unassigned. Once someone picks up, it belongs to them
  // alone — otherwise a teammate's browser keeps ringing for a call
  // that is already being handled.
  return {
    calls: calls.filter((call) => {
      if (call.answered_by) return call.answered_by === currentUserId;
      if (!call.assigned_agent_id) return true;
      return call.assigned_agent_id === currentUserId;
    }),
    dismiss,
  };
}
