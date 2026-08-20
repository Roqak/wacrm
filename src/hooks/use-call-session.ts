"use client";

// ============================================================
// The WebRTC half of a WhatsApp call.
//
// There is no media server in this product. Meta hands us an SDP offer
// through the webhook; this hook builds the answer in the browser and
// audio then flows directly between the agent's machine and Meta. The
// server only ferries SDP.
//
// The sequence, and why it is in this order:
//
//   1. getUserMedia            — must succeed before answering, or we
//                                accept a call with no microphone
//   2. setRemoteDescription    — Meta's offer
//   3. createAnswer            — POST action:'answer' (Meta pre_accept)
//   4. …ICE…                   — connection state reaches 'connected'
//   5. POST action:'connected' — Meta accept; audio is live
//
// Accepting at step 3 instead of step 5 produces a call that Meta
// considers answered while the media path is still being negotiated —
// the customer hears silence. The split is the point of pre-accept.
//
// Meta abandons an unanswered call in well under a minute, so every
// step here avoids anything that could block: no awaits on state the
// user has to provide beyond the one microphone prompt.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

import type { Call } from "@/types";

export type CallSessionState =
  | "idle"
  | "requesting_mic"
  | "negotiating"
  | "live"
  | "ended"
  | "error";

export interface UseCallSession {
  state: CallSessionState;
  /** Human-readable failure, set when `state === 'error'`. */
  error: string | null;
  /** Seconds since media went live. 0 until then. */
  elapsed: number;
  muted: boolean;
  answer: (call: Call) => Promise<void>;
  decline: (call: Call) => Promise<void>;
  hangup: (call: Call) => Promise<void>;
  toggleMute: () => void;
}

async function postAction(
  callId: string,
  action: "answer" | "connected" | "decline" | "hangup",
  sdpAnswer?: string,
): Promise<void> {
  const res = await fetch(`/api/whatsapp/calls/${callId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, sdp_answer: sdpAnswer }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Call action "${action}" failed`);
  }
}

export function useCallSession(): UseCallSession {
  const [state, setState] = useState<CallSessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  // The <audio> element is created imperatively rather than rendered:
  // it has no visual presence, and mounting it through React would
  // race the peer connection's `track` event on fast answers.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const teardown = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    // Stopping the tracks is what actually releases the microphone and
    // turns off the browser's recording indicator. Closing the peer
    // connection alone leaves it on, which reads as the app still
    // listening after the call ended.
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
      audioRef.current = null;
    }
    setMuted(false);
    setElapsed(0);
  }, []);

  // Release the microphone if the component unmounts mid-call — a
  // navigation should not leave the mic hot.
  useEffect(() => teardown, [teardown]);

  useEffect(() => {
    if (state !== "live") return;
    const started = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [state]);

  const answer = useCallback(
    async (call: Call) => {
      if (!call.offer_sdp) {
        setState("error");
        setError("This call arrived without an audio offer.");
        return;
      }
      try {
        setError(null);
        setState("requesting_mic");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        localStreamRef.current = stream;

        setState("negotiating");
        const pc = new RTCPeerConnection();
        pcRef.current = pc;

        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        pc.ontrack = (event) => {
          if (!audioRef.current) {
            const el = document.createElement("audio");
            el.autoplay = true;
            document.body.appendChild(el);
            audioRef.current = el;
          }
          audioRef.current.srcObject = event.streams[0];
        };

        pc.onconnectionstatechange = () => {
          const cs = pc.connectionState;
          if (cs === "connected") {
            // Tell Meta only now — see the header comment.
            void postAction(call.id, "connected", pc.localDescription?.sdp)
              .then(() => setState("live"))
              .catch((err: Error) => {
                setState("error");
                setError(err.message);
              });
          } else if (cs === "failed" || cs === "disconnected") {
            setState("ended");
            teardown();
          }
        };

        await pc.setRemoteDescription({ type: "offer", sdp: call.offer_sdp });
        const sdpAnswer = await pc.createAnswer();
        await pc.setLocalDescription(sdpAnswer);

        await postAction(call.id, "answer", sdpAnswer.sdp);
      } catch (err) {
        setState("error");
        setError(
          err instanceof Error
            ? err.name === "NotAllowedError"
              ? "Microphone access was blocked — allow it to take calls."
              : err.message
            : "Could not start the call",
        );
        teardown();
      }
    },
    [teardown],
  );

  const decline = useCallback(
    async (call: Call) => {
      try {
        await postAction(call.id, "decline");
      } finally {
        setState("idle");
        teardown();
      }
    },
    [teardown],
  );

  const hangup = useCallback(
    async (call: Call) => {
      try {
        await postAction(call.id, "hangup");
      } finally {
        setState("ended");
        teardown();
      }
    },
    [teardown],
  );

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    // Disabling the track keeps the connection up and the negotiated
    // media intact; removing it would renegotiate mid-call.
    const next = !muted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }, [muted]);

  return { state, error, elapsed, muted, answer, decline, hangup, toggleMute };
}
