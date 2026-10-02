// ============================================================
// POST /api/account/create — start a new business yourself.
//
// Any signed-in member. The RPC (`create_account`, migration 046) is
// the authority: it makes the caller the owner of the new account and
// switches them into it, so there is no role gate here beyond being
// signed in — the same shape as /api/account/switch.
//
// Naming follows the invite-label cap (80 chars) enforced inside the
// RPC; the route mirrors it so a too-long name is a 400 from a guard
// clause rather than a database round-trip.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const MAX_NAME_LENGTH = 80;

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(
      `account:create:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown }
      | null;

    const name =
      typeof body?.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";

    if (!name || name.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: "A business name of at most 80 characters is required" },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase.rpc("create_account", {
      p_name: name,
    });

    if (error) {
      const pgError = error as PostgrestError;
      // 42501 is the RPC's "Unauthorized"; 22023 its invalid input.
      // Anything else is a failure the caller did not cause.
      if (pgError.code === "42501" || pgError.code === "22023") {
        console.error("[account/create] rpc refusal:", pgError);
        return NextResponse.json({ error: pgError.message }, { status: 400 });
      }
      console.error("[account/create] rpc error:", pgError);
      return NextResponse.json(
        { error: "Failed to create the business" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, account_id: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}