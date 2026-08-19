-- ============================================================
-- 041_ollama_provider.sql — Ollama as an AI provider
--
-- Adds two providers to the bring-your-own-key AI agent:
--
--   'ollama'        — an Ollama server the operator runs themselves
--                     (localhost, a docker-compose service, a GPU box
--                     on the LAN). Needs a base URL; usually needs no
--                     API key at all.
--   'ollama_cloud'  — Ollama's hosted service at https://ollama.com.
--                     Fixed endpoint, needs an API key.
--
-- Both speak the OpenAI chat-completions wire format, so the adapter
-- is the existing OpenAI one pointed at a different origin.
--
-- Three schema changes make that storable:
--
--   1. Both `provider` CHECK constraints are widened. There are two —
--      `ai_configs` (029) and `ai_usage_log` (033) — and missing the
--      second one would let a config save succeed and then fail at
--      usage-logging time, after the model call was already paid for.
--
--   2. `base_url` — where to reach a self-hosted Ollama. NULL for the
--      hosted providers, whose endpoints are fixed in code and must
--      not be user-supplied.
--
--   3. `api_key` drops NOT NULL. A local Ollama typically has no
--      authentication, and the alternative — storing an encrypted
--      empty string to satisfy the constraint — would make "no key
--      needed" indistinguishable from "key not entered yet" at every
--      read site.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Widen the provider vocabulary
--
-- The constraint name is whatever Postgres generated for the inline
-- CHECK in 029/033 (`ai_configs_provider_check`), so drop by that name
-- and re-add explicitly. IF EXISTS keeps this re-runnable, and naming
-- the new constraints means the next migration to touch them doesn't
-- have to guess either.
-- ------------------------------------------------------------
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_allowed;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_allowed
  CHECK (provider IN ('openai', 'anthropic', 'ollama', 'ollama_cloud'));

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_allowed;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_allowed
  CHECK (provider IN ('openai', 'anthropic', 'ollama', 'ollama_cloud'));

-- ------------------------------------------------------------
-- 2. Where to reach a self-hosted server
--
-- Stored in plaintext deliberately: it is an address, not a secret,
-- and the settings form has to show it back to the admin to be
-- editable — which an encrypted-and-never-returned column (the
-- treatment `api_key` gets) makes impossible.
--
-- NOTE FOR MAINTAINER: this value is fetched by the server on every
-- draft and auto-reply, so it is an SSRF sink. The application layer
-- (`src/lib/ai/providers/base-url.ts`) is what constrains it — scheme,
-- and whether a private/loopback address is permitted at all, which is
-- gated behind the AI_ALLOW_PRIVATE_BASE_URL environment variable and
-- off by default. Do not write to this column from anywhere that
-- bypasses that check.
-- ------------------------------------------------------------
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS base_url text;

-- ------------------------------------------------------------
-- 3. A key is no longer mandatory
--
-- Only for providers that need one — enforced in the API route rather
-- than here, because "needs a key" is a property of the provider and
-- encoding that as a table constraint would mean another migration
-- every time the provider list changes.
-- ------------------------------------------------------------
ALTER TABLE ai_configs ALTER COLUMN api_key DROP NOT NULL;

-- ============================================================
-- Manual validation:
--
--   1. An existing 'openai' / 'anthropic' row still saves and loads
--      unchanged — this migration adds vocabulary, it does not
--      rewrite any existing value.
--   2. INSERT ... provider = 'ollama', api_key = NULL succeeds.
--   3. INSERT ... provider = 'gemini' still fails the CHECK.
-- ============================================================
