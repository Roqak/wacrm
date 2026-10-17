-- ============================================================
-- 051_ai_form_builder_usage.sql — log AI form-builder spend
--
-- "Describe your form" in Settings → WhatsApp Forms generates Flow
-- JSON on the account's own AI key. Every call is logged to
-- ai_usage_log like drafts and suggestions, under its own mode so the
-- spend reads separately — and the mode CHECK (044) has to allow it,
-- or the tokens are bought and the log INSERT is rejected.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_allowed;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_allowed
  CHECK (mode IN ('auto_reply', 'draft', 'suggestions', 'form_builder'));
