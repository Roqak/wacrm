-- ============================================================
-- 048_webhook_app_secret.sql — numbers served by other Meta apps
--
-- Meta signs every webhook POST with the App Secret of the app whose
-- subscription delivers it. The deployment checked exactly one
-- secret — ${META_APP_SECRET} — which made connecting a business's
-- number through a different Meta app impossible to serve: the
-- payload arrived, failed HMAC verification, and was dropped as
-- "Rejected request with an invalid X-Hub-Signature-256". The event
-- log panel (047) is what finally made that visible.
--
-- The fix: each whatsapp_config row MAY carry its own Meta App
-- Secret. The webhook route verifies the signature against the
-- deployment's env secret and every account-supplied one — whoever
-- actually signed the bytes. The env secret stays the default; rows
-- that never set the column behave exactly as before.
--
-- Encrypted with the same AES-256-GCM scheme as access_token (no
-- operator should ever see it echoed back; the API round-trips it
-- as "set"/"not set").
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS meta_app_secret text;