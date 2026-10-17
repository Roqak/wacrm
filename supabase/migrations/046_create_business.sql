-- ============================================================
-- 046_create_business.sql — start a new business yourself
--
-- Until now a second account could only reach you one way: an owner
-- of one invited you into it, or your login bootstrapped a personal
-- account at signup (017's handle_new_user). A user with one business
-- who wanted to start a second had no button anywhere.
--
-- This is that button, at the level where it belongs: an RPC the
-- browser can call the same way it already switches businesses.
-- It does three things in one transaction, mirroring exactly what
-- `redeem_invitation` (045) does when you accept an invitation:
--
--   1. INSERT accounts           — you are the owner of what you made.
--   2. INSERT account_members    — membership as 'owner' (the 045
--                                  shape; profiles alone stopped
--                                  being the truth about who is in).
--   3. UPDATE profiles           — switch you into the new account,
--                                  because that is where you want to
--                                  be looking next, and the switcher
--                                  will now offer it.
--
-- Why SECURITY DEFINER
--
--   accounts has no INSERT policy for clients (017: creation is owned
--   by signup and RPCs), and the 034 trigger refuses a browser write
--   to profiles.account_id — both are deliberate privilege
--   boundaries. A DEFINER function is the same pattern every other
--   entry point (redeem_invitation, set_active_account,
--   remove_account_member) uses to cross them under supervision.
--
-- Ownership semantics: creating a business makes you its owner and
-- leaves your existing ownerships untouched. An owner of several
-- businesses is now the intended state, since 045 dropped
-- idx_accounts_one_per_owner.
--
-- Reuses the invitation label cap (80 chars) so every human-facing
-- name in the product behaves the same.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_account(
  p_name TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller_id UUID := auth.uid();
  v_name TEXT := Trim(p_name);
  v_account_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Same cap as invite labels (src/app/api/account/invitations/route.ts),
  -- so the switcher and the account-settings form can truncate the same
  -- way everywhere.
  IF v_name = '' OR v_name IS NULL THEN
    RAISE EXCEPTION 'A business name is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_name) > 80 THEN
    RAISE EXCEPTION 'Business names are capped at 80 characters'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO accounts (name, owner_user_id)
  VALUES (v_name, v_caller_id)
  RETURNING id INTO v_account_id;

  INSERT INTO account_members (user_id, account_id, role)
  VALUES (v_caller_id, v_account_id, 'owner');

  -- Switch into the new business. SECURITY DEFINER runs as postgres,
  -- so the 034 trigger (current_user = 'authenticated') does not fire —
  -- the same supervised crossing set_active_account relies on.
  UPDATE profiles
  SET account_id = v_account_id,
      account_role = 'owner'
  WHERE user_id = v_caller_id;

  RETURN v_account_id;
END;
$fn$;

ALTER FUNCTION public.create_account(TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_account(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_account(TEXT) TO authenticated;