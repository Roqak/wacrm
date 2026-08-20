"use client";

// ============================================================
// Chimes when a customer message arrives.
//
// Mounted in the dashboard shell rather than on the inbox page, so an
// agent working in Contacts or Pipelines still hears a new message.
// Renders nothing.
//
// Its own Realtime channel, separate from the inbox page's — the two
// coexist without sharing state, the same way `useTotalUnread` already
// runs its own channel for the sidebar badge. Realtime applies the
// `messages` SELECT policy per subscriber, so an agent restricted to
// their own conversations (migration 040) is not chimed at by messages
// on threads they cannot see.
// ============================================================

import { useEffect } from "react";

import { createClient } from "@/lib/supabase/client";
import { useMessageSound } from "@/hooks/use-message-sound";
import type { Message } from "@/types";

export function MessageSound() {
  const { notify } = useMessageSound();

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("message-sound")
      .on(
        "postgres_changes",
        // INSERT only. Status updates (sent → delivered → read) fire
        // UPDATEs on this table constantly and none of them are a new
        // message.
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const row = payload.new as Message;
          // Only what a customer sent. Our own outbound messages, the
          // AI bot's replies and flow sends all arrive here too, and
          // chiming at an agent for their own message is noise.
          if (row.sender_type !== "customer") return;
          notify();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [notify]);

  return null;
}
