"use client";

// ============================================================
// The incoming-call surface.
//
// Mounted once in the dashboard shell rather than on the inbox page, so
// a call still reaches an agent who is looking at Contacts or Pipelines.
// It renders nothing at all when nothing is ringing.
//
// Deliberately not a Dialog: a modal would trap focus and block the rest
// of the app while ringing, and an agent often wants to read the thread
// before picking up. This is a floating card that stays out of the way.
// ============================================================

import { useEffect, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useIncomingCalls } from "@/hooks/use-incoming-calls";
import { useCallSession } from "@/hooks/use-call-session";
import { createClient } from "@/lib/supabase/client";
import type { Contact } from "@/types";

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function CallPanel() {
  const t = useTranslations("Calls");
  const { user } = useAuth();
  const { calls, dismiss } = useIncomingCalls(user?.id);
  const session = useCallSession();
  // Keyed by call id rather than held as a bare Contact, so a stale
  // name can never be shown against a different call: the render
  // derives from this only when the key matches. Clearing it on
  // hang-up would otherwise mean a setState in the effect body for the
  // no-call case, which is a cascading render for no benefit.
  const [contactFor, setContactFor] = useState<{
    callId: string;
    contact: Contact;
  } | null>(null);

  // The active call is the newest live one. More than one at a time is
  // possible in principle (two customers ringing at once) but the panel
  // shows one — answering is a single-microphone act anyway.
  const call = calls[0] ?? null;

  // Resolve who is calling. The call row carries only ids, and the
  // agent needs a name before deciding to pick up.
  const callId = call?.id ?? null;
  const contactId = call?.contact_id ?? null;

  useEffect(() => {
    if (!callId || !contactId) return;
    let cancelled = false;
    const supabase = createClient();
    void supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) {
          setContactFor({ callId, contact: data as Contact });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [callId, contactId]);

  useEffect(() => {
    if (session.error) toast.error(session.error);
  }, [session.error]);

  if (!call) return null;

  const contact = contactFor?.callId === call.id ? contactFor.contact : null;
  const caller = contact?.name || contact?.phone || t("unknownCaller");
  const isRinging = call.status === "ringing" && session.state === "idle";
  const isConnecting =
    session.state === "requesting_mic" || session.state === "negotiating";
  const isLive = session.state === "live";

  return (
    <div
      // aria-live so a screen-reader user is told about the call rather
      // than only seeing it — this appears without any action of theirs.
      role="alertdialog"
      aria-live="assertive"
      aria-label={t("incomingFrom", { name: caller })}
      className="fixed bottom-4 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-4 shadow-lg"
    >
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Phone className={isRinging ? "size-5 animate-pulse" : "size-5"} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-popover-foreground">
            {caller}
          </p>
          <p className="text-xs text-muted-foreground">
            {isLive
              ? formatElapsed(session.elapsed)
              : isConnecting
                ? t("connecting")
                : t("incomingCall")}
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        {isRinging && (
          <>
            <Button
              onClick={() => void session.answer(call)}
              className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Phone className="size-4" />
              {t("answer")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                void session.decline(call);
                dismiss(call.id);
              }}
              className="flex-1 border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20"
            >
              <PhoneOff className="size-4" />
              {t("decline")}
            </Button>
          </>
        )}

        {isConnecting && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {session.state === "requesting_mic" ? t("allowMic") : t("connecting")}
          </div>
        )}

        {isLive && (
          <>
            <Button
              variant="outline"
              onClick={session.toggleMute}
              aria-pressed={session.muted}
              className="flex-1"
            >
              {session.muted ? (
                <MicOff className="size-4" />
              ) : (
                <Mic className="size-4" />
              )}
              {session.muted ? t("unmute") : t("mute")}
            </Button>
            <Button
              onClick={() => {
                void session.hangup(call);
                dismiss(call.id);
              }}
              className="flex-1 bg-red-600 text-white hover:bg-red-700"
            >
              <PhoneOff className="size-4" />
              {t("hangUp")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
