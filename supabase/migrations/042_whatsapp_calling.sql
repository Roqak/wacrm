-- ============================================================
-- 042_whatsapp_calling.sql — inbound WhatsApp voice calls
--
-- Scope: customer-initiated calls only.
--
--   Business-initiated calling is unavailable on numbers registered in
--   Nigeria, the US, Canada, Egypt and Vietnam, and where it *is*
--   available it is capped at one call per customer per day (two per
--   week) behind an explicit permission grant. Customer-initiated
--   calling has none of those limits and works wherever Cloud API does,
--   so it is the whole of this feature. The `direction` column exists so
--   an outbound row is representable later without a migration, but
--   nothing writes 'outbound' today.
--
-- How a call actually works
--
--   There is no media server here. Meta sends an SDP offer to our
--   webhook, the agent's browser answers it, and audio flows browser ↔
--   Meta directly. This table is the signalling record and the
--   ringing-agent notification: the webhook inserts the row, Supabase
--   Realtime carries it to the browser, and the browser's answer comes
--   back through the API routes. Rows are also the call history.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The thread this call belongs to. Not null: a call is always about a
  -- contact, and the webhook find-or-creates both before inserting, so
  -- the call lands in the same place as their messages.
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Meta's call id. UNIQUE because the webhook can be redelivered — the
  -- terminate event for a call we already recorded must update that row,
  -- never insert a second one.
  wa_call_id        text NOT NULL UNIQUE,

  direction         text NOT NULL DEFAULT 'inbound'
                      CHECK (direction IN ('inbound', 'outbound')),

  -- ringing    — offer received, nobody has picked up yet
  -- connecting — an agent answered; SDP exchanged, media negotiating
  -- connected  — media flowing
  -- completed  — ended normally after connecting
  -- missed     — nobody answered before Meta gave up
  -- declined   — an agent explicitly rejected it
  -- failed     — negotiation or a Graph call errored
  status            text NOT NULL DEFAULT 'ringing'
                      CHECK (status IN ('ringing', 'connecting', 'connected',
                                        'completed', 'missed', 'declined', 'failed')),

  -- Who it rang for, copied from the conversation at insert time so the
  -- routing decision is a fact about the call rather than something
  -- re-derived later from a conversation that may since be reassigned.
  -- NULL means it rang everyone who can see the thread.
  assigned_agent_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Who actually picked up. Null until someone does.
  answered_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Meta's SDP offer, held only until the browser answers it. Not a
  -- secret (it describes codecs and candidate addresses, and it is
  -- useless once the call ends) but it is large, so it is cleared on
  -- terminate rather than kept in the history.
  offer_sdp         text,

  started_at        timestamptz NOT NULL DEFAULT now(),
  connected_at      timestamptz,
  ended_at          timestamptz,
  -- Denormalized on terminate. Computed rather than derived on read so
  -- the call list can sort and total by it cheaply.
  duration_seconds  integer,
  -- Meta's termination reason, or ours, verbatim — useful in support.
  end_reason        text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Thread view ("calls on this conversation") and the account-wide
-- history, which is the only other way these are read.
CREATE INDEX IF NOT EXISTS idx_calls_conversation
  ON calls(conversation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_account_started
  ON calls(account_id, started_at DESC);
-- Partial index for the "is anything ringing right now" poll that backs
-- a page load before Realtime attaches. Tiny, because live calls are
-- a handful of rows at most.
CREATE INDEX IF NOT EXISTS idx_calls_live
  ON calls(account_id, status)
  WHERE status IN ('ringing', 'connecting', 'connected');

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- RLS — same visibility rule as the conversation the call is about.
--
-- `can_access_conversation` (migration 040) is what makes a restricted
-- member see only their own threads. Gating calls on account membership
-- alone would leak, through the call history, exactly the customer
-- contact that 040 hides: who called, when, and how long they talked.
--
-- Writes are service-role only (the webhook and the signalling routes
-- both run as service-role after their own authorization), so there is
-- no INSERT/UPDATE policy for `authenticated`. Nothing about a call is
-- a client's to assert.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS calls_select ON calls;
CREATE POLICY calls_select ON calls FOR SELECT USING (
  is_account_member(account_id)
  AND EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = calls.conversation_id
      AND can_access_conversation(c.account_id, c.assigned_agent_id)
  )
);

-- Realtime: the ringing notification is a row insert, so the browser
-- has to be subscribed for a call to reach an agent at all. Realtime
-- applies the SELECT policy above, so a restricted member is not woken
-- by calls on threads they cannot see.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'calls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE calls;
  END IF;
END $$;

-- ------------------------------------------------------------
-- Per-number calling switch
--
-- Calling has to be enabled on the number at Meta before any of this
-- does anything, and that is not something we can detect reliably from
-- a webhook that simply never arrives. This flag is the operator
-- saying "I have turned it on over there", which lets the UI stay
-- quiet — no call panel, no microphone permission prompt — on the
-- numbers that haven't.
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS calling_enabled boolean NOT NULL DEFAULT false;

-- ============================================================
-- Manual validation (needs a live WABA with calling enabled):
--
--   1. Call the business number from WhatsApp. A row appears with
--      status 'ringing' and a non-null offer_sdp.
--   2. The assigned agent's browser receives the INSERT over Realtime;
--      a member restricted away from that conversation does not.
--   3. Answering moves the row ringing → connecting → connected, and
--      `answered_by` is the agent who picked up.
--   4. Hanging up on either side sets ended_at + duration_seconds and
--      clears offer_sdp.
--   5. Not answering leaves status 'missed' once Meta's terminate
--      webhook arrives.
-- ============================================================
