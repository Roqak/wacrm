-- ============================================================
-- 047_webhook_event_log.sql — see what Meta actually sent us
--
-- When a message doesn't land, the only evidence today is server
-- console.error lines, which a self-hoster cannot see at all —
-- issue #301's "thread with an empty message list" was debugged
-- entirely with print statements. This table is that evidence,
-- promoted to a database table and a live settings panel.
--
-- One row per webhook change (plus verification attempts), written by
-- the webhook route itself via the service-role client — Meta traffic
-- has no user session, so there is no other client that could write
-- here and none that should.
--
-- The shape
--
--   event_type  message | status | template | verification | error
--   status      processed | ignored | dropped | error
--
-- account_id is NULL exactly where the event could not be matched to
-- a config: an unknown phone_number_id ("No config found"), a
-- duplicate-config error, or a verification attempt against a
-- foreign webhook. Those rows are what the panel exists for — "Meta
-- sent traffic we didn't match" — but they name no account, and
-- membership-only access would show them to every session of every
-- member. So a second policy shows NULL-account rows to admins of
-- ANY account they belong to (is_account_admin_any, below), while
-- matched rows keep the ordinary scoping: admin of the account, and
-- the account is the one they are currently switched into — the same
-- rule every other table in the app uses. In a deployment where a
-- browser admin can belong to several businesses, this is the
-- difference between diagnosing a dropped number and silently
-- hiding it because it belongs to the business you are not in.
--
-- Realtime: the panel appends on INSERT through the supabase_realtime
-- publication. postgres_changes evaluates the table's RLS with the
-- subscriber's own token, so an admin only ever streams events their
-- policies admit — matched events of their active account, plus the
-- unmatched ones.
--
-- Retention: the route prunes rows older than 7 days opportunistically
-- right after each webhook POST (one DELETE per webhook, no new
-- infrastructure). Payloads are Meta's own bodies — message text,
-- status ladders, template definitions — and contain no credentials.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_webhook_logs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      uuid REFERENCES accounts(id) ON DELETE CASCADE,
  phone_number_id text,
  event_type      text NOT NULL
    CHECK (event_type IN ('message', 'status', 'template', 'verification', 'error')),
  status          text NOT NULL
    CHECK (status IN ('processed', 'ignored', 'dropped', 'error')),
  summary         text,
  payload         jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The panel's only two access patterns: latest N for the active
-- account, and the live stream, both newest-first.
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_logs_account_created
  ON whatsapp_webhook_logs(account_id, created_at DESC);

-- The webhook route writes (and prunes) via the service-role client;
-- a bare `db reset` creates tables owned by postgres with no grants,
-- which would leave the route silently failing to record. Hosted
-- projects already grant these by default; this makes self-hosted
-- replays equally correct.
GRANT SELECT, INSERT, DELETE ON public.whatsapp_webhook_logs TO service_role;
GRANT SELECT ON public.whatsapp_webhook_logs TO authenticated;

ALTER TABLE whatsapp_webhook_logs ENABLE ROW LEVEL SECURITY;

-- Admin of at least one membership, regardless of which account is
-- active. Must exist before the policies below reference it.
CREATE OR REPLACE FUNCTION public.is_account_admin_any()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM account_members m
    WHERE m.user_id = auth.uid()
      AND m.role IN ('owner', 'admin')
  );
$$;

ALTER FUNCTION public.is_account_admin_any() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_account_admin_any()
  TO authenticated, service_role;

-- Admins read their active account's events.
DROP POLICY IF EXISTS whatsapp_webhook_logs_select ON whatsapp_webhook_logs;
CREATE POLICY whatsapp_webhook_logs_select ON whatsapp_webhook_logs FOR SELECT
  USING (
    account_id IS NOT NULL
    AND is_account_member(account_id, 'admin')
  );

-- Unmatched traffic (NULL account) is visible to admins of any
-- account they belong to — it names Meta's phone numbers only, and
-- hiding it per-active-account would make a dropped webhook
-- undiagnosable whenever it belongs to a business the admin is not
-- currently in. Nothing here grants write; the route's service-role
-- client is the only writer.
DROP POLICY IF EXISTS whatsapp_webhook_logs_unmatched_select ON whatsapp_webhook_logs;
CREATE POLICY whatsapp_webhook_logs_unmatched_select ON whatsapp_webhook_logs FOR SELECT
  USING (
    account_id IS NULL
    AND is_account_admin_any()
  );

-- ------------------------------------------------------------
-- Realtime publication
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'whatsapp_webhook_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_webhook_logs;
  END IF;
END
$$;