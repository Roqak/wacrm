-- ============================================================
-- 045_multi_account_membership.sql — one person, several businesses
--
-- Until now a user belonged to exactly one account. Migration 017 calls
-- that "the locked design decision — single membership" and notes it
-- would drop if we ever relaxed to many-to-many. This is that.
--
-- The shape
--
--   `account_members` becomes the truth about who belongs where, and
--   with what role. `profiles.account_id` keeps its column but changes
--   meaning: it is no longer "the account I belong to" but "the account
--   I am currently working in". Switching businesses is a write to that
--   one column.
--
-- Why reuse profiles.account_id instead of adding active_account_id
--
--   Because ~60 RLS policies and most of the app's queries already read
--   scoping from it, directly or through `is_account_member`. Giving the
--   existing column the active-account meaning makes every one of those
--   correct for free. Adding a second column would leave two sources of
--   truth for "which account is this query about", and the day they
--   disagree is a cross-tenant leak.
--
-- Why the membership check also requires "is active"
--
--   This is the subtle part, and the reason this migration is small.
--
--   `is_account_member(target)` gates almost every SELECT policy in the
--   database, and almost no query in the app filters by account itself
--   — the inbox conversation list, for one, has no account filter at
--   all and relies entirely on RLS. If membership alone granted access,
--   an agent in two businesses would open the inbox and see both
--   businesses' conversations interleaved, with no way to tell them
--   apart. Every one of those queries would need an explicit filter
--   added, and the one that got missed would be the leak.
--
--   So the predicate stays narrow: you may read an account's data when
--   you are a member of it AND it is the one you are currently in.
--   Switching is what changes what you can see. Two tables need the
--   looser rule — `accounts` and `account_members` themselves, because
--   the switcher has to list businesses you are not currently in — and
--   they get `is_account_member_any` for exactly that.
--
-- What this migration does NOT do
--
--   It does not touch a single policy body. That is the point: the
--   behaviour change lives in one function, so the blast radius is one
--   function rather than sixty policies each of which could be got
--   subtly wrong.
--
-- MAINTAINER WARNING
--
--   This file rewrites the authorization primitive the entire tenancy
--   model rests on. It has been applied to no database. Run it against
--   a staging copy and verify, with two accounts and one shared user,
--   that switching changes what the inbox returns and that nothing from
--   the inactive business is ever readable — before it goes near
--   production data.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Membership
--
-- PK on (user_id, account_id): a person holds one role per business,
-- and belongs to a business at most once.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_members (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role        account_role_enum NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_id)
);

-- "Who is in this business" (the members roster) and "which businesses
-- am I in" (the switcher) are the only two access patterns.
CREATE INDEX IF NOT EXISTS idx_account_members_account
  ON account_members(account_id);

ALTER TABLE account_members ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 2. Backfill from the single-membership world
--
-- Every existing profile with an account becomes one membership row at
-- the role it already had. ON CONFLICT so a re-run is a no-op rather
-- than an error, and so it cannot clobber a role changed since.
-- ------------------------------------------------------------
INSERT INTO account_members (user_id, account_id, role)
SELECT p.user_id, p.account_id, p.account_role
FROM profiles p
WHERE p.account_id IS NOT NULL
  AND p.account_role IS NOT NULL
ON CONFLICT (user_id, account_id) DO NOTHING;

-- ------------------------------------------------------------
-- 3. One account per owner is no longer true
--
-- 017 added this to enforce single membership. A person who starts a
-- second business owns two accounts, which is now the intended state.
-- ------------------------------------------------------------
DROP INDEX IF EXISTS idx_accounts_one_per_owner;

-- ------------------------------------------------------------
-- 4. The authorization primitive
--
-- Same signature and same ordinal hierarchy as 017 — only the source of
-- the role changes, plus the active-account requirement explained at
-- the top of this file.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM account_members m
    JOIN profiles p ON p.user_id = m.user_id
    WHERE m.user_id = auth.uid()
      AND m.account_id = target_account_id
      -- The active-account gate. Without it, a member of two businesses
      -- reads both at once through every policy in the database.
      AND p.account_id = target_account_id
      AND CASE m.role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum)
  TO authenticated, service_role;

-- Membership regardless of which account is active. ONLY for the two
-- tables the switcher reads — anything else using this would hand a
-- user their other business's data while they are not in it.
CREATE OR REPLACE FUNCTION is_account_member_any(
  target_account_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM account_members m
    WHERE m.user_id = auth.uid()
      AND m.account_id = target_account_id
  );
$$;

ALTER FUNCTION is_account_member_any(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member_any(UUID)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Policies for the switcher's two tables
--
-- Read-only to the client. Membership is written by the invitation and
-- member RPCs (SECURITY DEFINER), never by a browser — the same model
-- 018 established for roles.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS account_members_select ON account_members;
CREATE POLICY account_members_select ON account_members FOR SELECT
  USING (
    -- Your own memberships (so the switcher can list them), plus the
    -- roster of whichever business you are currently in.
    user_id = auth.uid()
    OR is_account_member(account_id)
  );

-- `accounts` must be readable for every business you belong to, not
-- just the active one, or the switcher has nothing to name.
DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT
  USING (is_account_member_any(id));

-- ------------------------------------------------------------
-- 6. Switching
--
-- SECURITY DEFINER because the 034 trigger deliberately stops the
-- browser writing profiles.account_id — that column is a privilege
-- boundary, and this is the one supervised way to move it.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_active_account(
  p_account_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role
  FROM account_members
  WHERE user_id = auth.uid() AND account_id = p_account_id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of that account'
      USING ERRCODE = '42501';
  END IF;

  -- Keep account_role in step. It is still read in places as the
  -- caller's role, and after a switch it must describe the business
  -- they are now in rather than the one they left.
  UPDATE profiles
  SET account_id = p_account_id,
      account_role = v_role
  WHERE user_id = auth.uid();
END;
$$;

ALTER FUNCTION public.set_active_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_active_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_active_account(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 7. Membership writes follow the role writes
--
-- set_member_role and remove_account_member (018) still update
-- `profiles`, which is now only the active pointer. They have to move
-- the membership row too, or a role change would apply until the member
-- next switched and then silently revert.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_membership_from_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.account_id IS NULL OR NEW.account_role IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO account_members (user_id, account_id, role)
  VALUES (NEW.user_id, NEW.account_id, NEW.account_role)
  ON CONFLICT (user_id, account_id)
  DO UPDATE SET role = EXCLUDED.role;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_membership_from_profile() OWNER TO postgres;

-- AFTER, not BEFORE: the profile row must exist before a membership can
-- reference the account it points at.
DROP TRIGGER IF EXISTS sync_membership_from_profile ON public.profiles;
CREATE TRIGGER sync_membership_from_profile
  AFTER INSERT OR UPDATE OF account_id, account_role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_membership_from_profile();

-- ------------------------------------------------------------
-- 8. Joining a business no longer means leaving yours
--
-- `redeem_invitation` (019) MOVED the caller: it reassigned their
-- profile to the inviter's account and deleted their own. That is why
-- it refuses anyone whose account holds data, and anyone already in a
-- shared account — under single membership, joining really did orphan
-- whatever you had.
--
-- None of that applies now. Accepting an invitation adds a membership
-- and switches you into it; your own business stays exactly where it
-- is, and so does any other you belong to. So the guards that existed
-- to prevent data loss are removed along with the data loss.
--
-- Kept: the token checks, and the refusal to join a business you are
-- already in.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv RECORD;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash;

  IF v_inv IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_members
    WHERE user_id = v_caller_id AND account_id = v_inv.account_id
  ) THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO account_members (user_id, account_id, role)
  VALUES (v_caller_id, v_inv.account_id, v_inv.role);

  -- Switch them in. Someone who just accepted an invitation wants to be
  -- looking at that business, not the one they were in a moment ago.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  RETURN v_inv.account_id;
END;
$fn$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 9. Removing a member takes away one business, not their login
--
-- `remove_account_member` (018) spun up a fresh personal account for
-- the removed user, because under single membership they would
-- otherwise have had nowhere to be. Now they usually do: drop the
-- membership, and if that was the business they were looking at, move
-- them to another they still belong to.
--
-- The fresh-account path survives for the case that still needs it —
-- removing someone's only membership.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- the account they end up in
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_target_active UUID;
  v_next_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  -- Membership in the CALLER'S account is what is being revoked. An
  -- admin of business A has no say over the target's membership of B.
  SELECT role INTO v_target_role
  FROM account_members
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM account_members
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;

  SELECT account_id INTO v_target_active
  FROM profiles WHERE user_id = p_user_id;

  -- Still somewhere else to be? Only relocate them if the business they
  -- were looking at is the one they just lost.
  IF v_target_active IS DISTINCT FROM v_caller_account_id THEN
    RETURN v_target_active;
  END IF;

  SELECT account_id INTO v_next_account_id
  FROM account_members
  WHERE user_id = p_user_id
  ORDER BY created_at
  LIMIT 1;

  IF v_next_account_id IS NULL THEN
    -- Their only membership. Same as before 045: a fresh personal
    -- account so the login still leads somewhere.
    SELECT full_name, email INTO v_target_name, v_target_email
    FROM profiles WHERE user_id = p_user_id;

    INSERT INTO accounts (name, owner_user_id)
    VALUES (
      COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
      p_user_id
    )
    RETURNING id INTO v_next_account_id;

    INSERT INTO account_members (user_id, account_id, role)
    VALUES (p_user_id, v_next_account_id, 'owner')
    ON CONFLICT (user_id, account_id) DO NOTHING;

    UPDATE profiles
    SET account_id = v_next_account_id, account_role = 'owner'
    WHERE user_id = p_user_id;
  ELSE
    UPDATE profiles
    SET account_id = v_next_account_id,
        account_role = (
          SELECT role FROM account_members
          WHERE user_id = p_user_id AND account_id = v_next_account_id
        )
    WHERE user_id = p_user_id;
  END IF;

  RETURN v_next_account_id;
END;
$fn$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 10. Role writes target the membership, not the profile
--
-- `set_member_role` and `transfer_account_ownership` (018) both write
-- `profiles.account_role`, which used to be the person's only role.
-- It is now their role *in whatever business they happen to be looking
-- at*. Left alone, an admin of business A changing someone's role while
-- that person is switched into business B would rewrite their role in
-- B — the wrong business, by an admin with no authority over it.
--
-- Both now write `account_members` for the caller's account, and touch
-- the profile only when the target is currently in that same business,
-- where the two must agree.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_members
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  UPDATE account_members
  SET role = p_new_role
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;

  -- Only if they are actually looking at this business right now.
  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id AND account_id = v_caller_account_id;
END;
$fn$;

ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;
  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM account_members
    WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id
  ) THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Demote first so the account is never visibly ownerless; both
  -- writes are in one function transaction.
  UPDATE account_members SET role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_caller_account_id;
  UPDATE account_members SET role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;

  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_caller_account_id;
  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_caller_account_id;

  UPDATE accounts SET owner_user_id = p_new_owner_user_id
  WHERE id = v_caller_account_id;
END;
$fn$;

ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 11. Conversation-scope writes check membership too
--
-- `set_member_conversation_access` (040) established the target is "in
-- your account" by comparing profiles.account_id. That is now the
-- target's *active* business, so an admin could be told a teammate is
-- not in their account purely because that teammate is looking at a
-- different one.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_conversation_access(
  p_user_id UUID,
  p_can_view_all BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_can_view_all IS NULL THEN
    RAISE EXCEPTION 'can_view_all_conversations must be true or false'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own conversation access'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM account_members
    WHERE user_id = p_user_id AND account_id = v_caller_account_id
  ) THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- NOTE: the flag itself still lives on `profiles`, so it applies to
  -- the person everywhere rather than per business. That is a known
  -- limitation of doing multi-business in one pass, not an oversight —
  -- moving it onto account_members is a follow-up.
  UPDATE profiles
  SET can_view_all_conversations = p_can_view_all
  WHERE user_id = p_user_id;
END;
$fn$;

ALTER FUNCTION public.set_member_conversation_access(UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_conversation_access(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_conversation_access(UUID, BOOLEAN) TO authenticated;

-- ============================================================
-- Manual validation — do this on staging before production:
--
--   1. Existing single-account users are unaffected: one membership
--      row each, same role, same data visible.
--   2. Give one user memberships in two accounts. With account A
--      active, the inbox returns only A's conversations; nothing from
--      B is reachable through any table.
--   3. set_active_account(B) flips that, and A becomes unreachable.
--   4. set_active_account() for an account you are not a member of
--      raises 42501.
--   5. The switcher can still *name* both accounts while only one is
--      active (accounts_select uses is_account_member_any).
--   6. A direct PATCH of profiles.account_id from the browser is still
--      refused by the 034 trigger.
--   7. Redeeming an invitation while already owning a business with
--      data now succeeds, adds a membership, and leaves that business
--      intact — the pre-045 refusal is gone because the data loss it
--      guarded against is gone.
--   8. Removing a member who belongs to two businesses drops only the
--      one they were removed from; removing their last one still
--      lands them in a fresh personal account.
--   9. Changing someone's role in business A while they are switched
--      into business B changes only their A role — check both
--      account_members rows and their profile afterwards.
-- ============================================================
