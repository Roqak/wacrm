// ============================================================
// POST /api/account/switch  — change which business you are working in.
//
// Any member. Authority is the membership itself: you can switch to a
// business you belong to, and the RPC refuses anything else, so there
// is no role gate here beyond being signed in.
//
// The write goes through `set_active_account` rather than a direct
// UPDATE because `profiles.account_id` is a privilege boundary — the
// trigger from migration 034 blocks the browser from touching it, and
// this route runs under the caller's own client, not the service role.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(
      `account:switch:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { account_id?: unknown }
      | null;
    const accountId = body?.account_id;

    if (typeof accountId !== "string" || !accountId) {
      return NextResponse.json(
        { error: "'account_id' is required" },
        { status: 400 },
      );
    }

    // Already there — a no-op rather than a pointless write, since the
    // switcher can fire this on a double click.
    if (accountId === ctx.accountId) {
      return NextResponse.json({ ok: true, account_id: accountId });
    }

    const { error } = await ctx.supabase.rpc("set_active_account", {
      p_account_id: accountId,
    });

    if (error) {
      const pgError = error as PostgrestError;
      // 42501 is the RPC's "not a member" — a 403, and deliberately not
      // a 404: the caller supplied the id, so we are not disclosing
      // anything they did not already have.
      if (pgError.code === "42501") {
        return NextResponse.json({ error: pgError.message }, { status: 403 });
      }
      console.error("[account/switch] rpc error:", pgError);
      return NextResponse.json(
        { error: "Failed to switch account" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, account_id: accountId });
  } catch (err) {
    return toErrorResponse(err);
  }
}
