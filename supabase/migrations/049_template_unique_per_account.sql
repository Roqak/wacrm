-- ============================================================
-- 049_template_unique_per_account.sql — a name is unique per business
--
-- Migration 014 uniquely-keyed a template on (user_id, name, language)
-- — "the same person can't have two templates with one name". Under
-- one-membership-per-user that was account-scoping through a side
-- door. Migration 045 made a person a member of several businesses,
-- and that side door became a collision: one human creating
-- "beel_invite" in Beels and in their other business shares ONE
-- user_id, so the second business's insert upsert-updates the FIRST
-- business's row — and the first business (as this app's message
-- templates are settings-class, admin-only) refuses the surprise
-- cross-tenant UPDATE with a using-clause violation:
--
--   "Submitted to Meta but failed to save locally: new row violates
--    row-level security policy (USING expression)"
--
-- Worse than the error was the silent version: the RLS check would
-- have failed only AFTER Meta had accepted the submission, meaning
-- the local row and Meta drifted apart.
--
-- The truth was always (account_id, name, language): every
-- upsertTemplateRow already writes account_id. Make the unique key
-- match it. The TODO(account-sharing) comment in the submit core
-- predates 045 and pointed at exactly this.
--
-- Note this changes what "duplicate" means for EXISTING data: two
-- TEAMMATES who individually created a same-named template inside one
-- account were both legal to 014 and become one template under the
-- new key. Those shadows are deleted here — newest row wins (they
-- shadowed each other in the UI before this migration anyway).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Collapse teammate shadows inside one account: same name +
--    language twice in the same business. Keep the most recently
--    edited row of each group; ties break on id so a re-run picks
--    the same survivor.
BEGIN;

DELETE FROM message_templates t
USING message_templates s
WHERE t.account_id = s.account_id
  AND t.name      = s.name
  AND t.language  = s.language
  AND t.id       <> s.id
  AND (s.updated_at > t.updated_at
       OR (s.updated_at = t.updated_at AND s.id > t.id));

COMMIT;

-- 2. Drop the per-USER key.
DROP INDEX IF EXISTS message_templates_user_name_language_key;

-- 3. Install the per-ACCOUNT key. Postgres applies a UNIQUE on
--    creation; step 1 should have left no duplicates, so guard the
--    build: if step 1 didn't run or rows drifted in mid-flight, fail
--    loudly with the offenders instead of silently refusing the
--    whole migration.
DO $$
DECLARE
  sample TEXT;
BEGIN
  SELECT string_agg(format('  account %s / name %s / lang %s', account_id, name, language), E'\n')
    INTO sample
  FROM (
    SELECT account_id, name, language
    FROM message_templates
    GROUP BY account_id, name, language
    HAVING count(*) > 1
    ORDER BY account_id, name, language
    LIMIT 5
  ) offenders;

  IF sample IS NOT NULL THEN
    RAISE EXCEPTION
      E'Cannot add UNIQUE(account_id, name, language) on message_templates — duplicate combination(s):\n%\nA teammate of the account has two same-named templates; delete the stale one (or let migration 049 dedup again after fixing the drift) and re-run.',
      sample;
  END IF;
END $$;

ALTER TABLE message_templates
  ADD CONSTRAINT message_templates_account_name_language_key
  UNIQUE (account_id, name, language);

-- 4. The webhook handler matches templates by meta_template_id —
--    unchanged and still unique per 014's partial index.