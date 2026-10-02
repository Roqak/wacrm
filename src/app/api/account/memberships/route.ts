// ============================================================
// GET /api/account/memberships — the businesses you belong to.
//
// Feeds the account switcher. Returns every membership, not only the
// active one, which is why `accounts_select` uses `is_account_member_any`
// (migration 045) — a switcher that could not name the business you are
// about to move to would be useless.
//
// Any member. The list is inherently the caller's own.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import type { AccountMembership } from "@/types";

interface MembershipRow {
  account_id: string;
  role: string;
  accounts: { id: string; name: string; brand_name: string | null } | null;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from("account_members")
      .select("account_id, role, accounts(id, name, brand_name)")
      .eq("user_id", ctx.userId);

    if (error) {
      console.error("[GET /api/account/memberships] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load your accounts" },
        { status: 500 },
      );
    }

    const memberships: AccountMembership[] = (data as unknown as MembershipRow[])
      .flatMap((row) => {
        // A membership whose account row is unreadable would render as a
        // nameless entry that switches you somewhere unidentifiable —
        // skip it rather than show that.
        if (!row.accounts || !isAccountRole(row.role)) return [];
        return [
          {
            account_id: row.account_id,
            // Prefer the operator's own branding, same as the sidebar,
            // so the switcher names businesses the way their staff do.
            name: row.accounts.brand_name?.trim() || row.accounts.name,
            role: row.role,
            is_active: row.account_id === ctx.accountId,
          },
        ];
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ memberships });
  } catch (err) {
    return toErrorResponse(err);
  }
}
