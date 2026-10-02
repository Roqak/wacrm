// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Reads `account_members`, not `profiles`. Since migration 045 a
// profile's account_id is the business that person is *currently
// looking at*, so a roster built from it would silently omit every
// teammate who happens to be switched into another business — they
// would look removed.
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import type { AccountMember } from "@/types";

interface MemberRow {
  user_id: string;
  role: string;
  created_at: string;
  profiles: {
    full_name: string | null;
    email: string | null;
    avatar_url: string | null;
    can_view_all_conversations: boolean;
  } | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // `account_members_select` (migration 045) lets a member read the
    // roster of the business they are in, so this is account-scoped by
    // RLS as well as by the filter.
    const { data, error } = await ctx.supabase
      .from("account_members")
      .select(
        "user_id, role, created_at, profiles(full_name, email, avatar_url, can_view_all_conversations)",
      )
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    // One gate for every admin-only field on the row.
    const canSeePrivileged = canManageMembers(ctx.role);

    const members: AccountMember[] = (
      data as unknown as MemberRow[]
    ).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.role)) return [];
      // A membership whose profile is unreadable would render as a
      // nameless row nobody can act on.
      if (!row.profiles) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.profiles.full_name ?? "",
          email: canSeePrivileged ? row.profiles.email : null,
          avatar_url: row.profiles.avatar_url,
          role: row.role,
          joined_at: row.created_at,
          can_view_all_conversations: canSeePrivileged
            ? row.profiles.can_view_all_conversations
            : null,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
