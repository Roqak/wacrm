-- ============================================================
-- 044_ai_reply_suggestions.sql — auto-suggested replies
--
-- Adds one flag: whether the inbox should generate reply suggestions on
-- its own when a customer message is waiting, rather than only when an
-- agent asks for a draft.
--
-- Why it defaults to FALSE
--
--   Every other AI surface in this app is agent-initiated: the ✨ button
--   spends the account's provider key because someone clicked it.
--   Suggestions spend it *automatically*, once per waiting customer
--   message, across every agent who opens the thread. That is a real
--   change in how the key gets billed, so it is opt-in — an account
--   that upgrades and does nothing sees no new spend.
--
--   The auto-reply bot has the same property and the same treatment
--   (`auto_reply_enabled`, default false, migration 029). This mirrors
--   it deliberately.
--
-- Why on ai_configs rather than a per-agent preference
--
--   It is the account's key being spent, so it is the account's admin
--   who decides. An agent turning it on for themselves would be
--   spending someone else's budget.
--
-- Numbered 044: 041 Ollama, 042 calling (in flight), 043 branding.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS suggestions_enabled boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- Suggestions get their own usage mode
--
-- Logging them as 'draft' would fold automatic spend into the figure
-- for spend an agent asked for — which is precisely the distinction an
-- operator needs when the bill looks wrong. The CHECK from migration
-- 033 has to be widened for that, and missing it would mean the tokens
-- are bought and then the log INSERT is rejected, hiding the spend
-- entirely.
-- ------------------------------------------------------------
ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_allowed;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_allowed
  CHECK (mode IN ('auto_reply', 'draft', 'suggestions'));

-- No policy changes. `ai_configs` is already readable by any member
-- (so the inbox can tell whether to ask for suggestions) and writable
-- by admin+ (migration 029).

-- ============================================================
-- Manual validation:
--
--   1. With the flag off, opening a conversation with an unanswered
--      customer message issues no provider call — ai_usage_log gains
--      no rows with mode = 'suggestions'.
--   2. With it on, opening such a conversation produces suggestions,
--      and re-opening the same conversation does not spend again until
--      a new customer message arrives.
--   3. An agent (non-admin) cannot flip the flag — the settings form
--      is admin-gated and ai_configs_update requires admin+.
-- ============================================================
