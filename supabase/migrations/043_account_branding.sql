-- ============================================================
-- 043_account_branding.sql — name the product after your own business
--
-- Adds two nullable columns to `accounts` so an operator can replace
-- the shipped product name and mark with their own. A self-hoster
-- running this for their agency does not want "wacrm" in the sidebar
-- and the browser tab in front of their staff.
--
-- Numbered 043 because 041 is the Ollama provider (merged) and 042 is
-- the in-flight calling branch.
--
-- Why nullable rather than NOT NULL DEFAULT 'wacrm'
--
--   NULL means "not branded", which is not the same as "branded, as it
--   happens, with the default string". The distinction is load-bearing:
--   the fallback lives in the translation files, so an unbranded
--   account renders the product name in the viewer's own language,
--   while a branded one renders the operator's name verbatim in every
--   language. Defaulting the column to an English literal would
--   silently break the Korean UI for every existing account.
--
-- Why on `accounts` and not a separate table
--
--   One row per account, always read together with the account itself,
--   never queried on its own. A second table would be a join on every
--   page load to hold two strings.
--
-- NOTE FOR MAINTAINER — `brand_logo_url` is rendered in an <img> in the
-- dashboard. Nothing on the server fetches it (no SSRF surface), but it
-- is attacker-influenceable by any account admin, so the API route
-- restricts it to http/https and the UI never interpolates it anywhere
-- but a `src`. Do not start server-side fetching this value without
-- putting it through `isDeliverableUrl` first.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS brand_logo_url text;

-- No new policies. `accounts_select` (any member) and `accounts_update`
-- (admin+) from migration 017 already cover these columns — branding is
-- read by everyone who can see the account and written by the same
-- people who can rename it.

-- ============================================================
-- Manual validation:
--
--   1. With both columns NULL, the sidebar and tab title read the same
--      as before, and still translate.
--   2. Setting brand_name changes both, for every member of that
--      account and nobody else's.
--   3. An agent (non-admin) PATCHing /api/account is rejected 403 —
--      accounts_update requires admin+.
-- ============================================================
