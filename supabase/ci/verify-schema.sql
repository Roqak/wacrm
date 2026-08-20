-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- Conversation scoping (040). Asserted because it is a security
  -- boundary: if the column is missing the policy below silently
  -- degrades, and if the policy never got rewritten every member
  -- keeps seeing every thread. Both fail open, which is the failure
  -- mode worth a check.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'can_view_all_conversations'
  ) THEN
    RAISE EXCEPTION
      'profiles.can_view_all_conversations is missing — migration 040 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'conversations'
      AND policyname = 'conversations_select'
      AND qual LIKE '%can_access_conversation%'
  ) THEN
    RAISE EXCEPTION
      'conversations_select does not apply can_access_conversation — migration 040 did not rewrite the policy';
  END IF;

  -- Ollama support (041). The CHECK widening is the load-bearing half:
  -- without it a save is rejected by the database after the model call
  -- has already been made and paid for.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_configs'
      AND column_name = 'base_url'
  ) THEN
    RAISE EXCEPTION
      'ai_configs.base_url is missing — migration 041 did not apply';
  END IF;

  BEGIN
    INSERT INTO ai_configs (account_id, provider, model)
    VALUES ('00000000-0000-0000-0000-000000000000', 'ollama', 'probe');
    RAISE EXCEPTION
      'inserting a config for a non-existent account succeeded — the account_id FK is missing';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;  -- reached the FK, so the provider CHECK and the nullable
             -- api_key both accepted the row. That is what we are testing.
    WHEN check_violation THEN
      RAISE EXCEPTION
        'the ai_configs provider CHECK still rejects ''ollama'' — migration 041 did not widen it';
    WHEN not_null_violation THEN
      RAISE EXCEPTION
        'ai_configs.api_key is still NOT NULL — migration 041 did not drop it';
  END;

  -- Branding (043). Both columns are nullable and purely additive, so
  -- the only failure mode is the migration not running at all — which
  -- would surface as the settings form erroring on a column that isn't
  -- there.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name = 'brand_name'
  ) THEN
    RAISE EXCEPTION 'accounts.brand_name is missing — migration 043 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
