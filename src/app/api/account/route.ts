// ============================================================
// /api/account
//
//   GET   — current caller's account + role. Any member.
//   PATCH — rename the account, and set its branding.  Admin+.
//
// Rename vs branding
//   `name` is what the workspace is called — it shows up in invites and
//   on the account switcher. `brand_name` is what the *product* is
//   called, in the sidebar and the browser tab. An agency running this
//   for a client wants those to be different things, so they are
//   separate columns rather than one overloaded field.
//
// Why both verbs share a route file
//   They speak about the same singular resource (the caller's
//   account) and reuse the same `requireRole` plumbing. Splitting
//   them across files would duplicate the `account_id` lookup
//   without buying anything.
// ============================================================

import { NextResponse } from "next/server";

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import {
  normalizeBrandLogoUrl,
  normalizeBrandName,
} from "@/lib/branding";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: ctx.account,
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const MAX_NAME_LEN = 80;

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("admin");

    // Per-user limit on admin-class mutations. Bounds accidental
    // abuse (script run in a loop) and a compromised admin session
    // spamming renames. Each admin endpoint keys its own bucket so
    // one route doesn't starve another.
    const limit = checkRateLimit(
      `admin:rename:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; brand_name?: unknown; brand_logo_url?: unknown }
      | null;

    // Every field is optional and applied only when present, so the
    // rename form and the branding form can each PATCH just their own
    // fields without wiping the other's.
    const patch: Record<string, unknown> = {};

    if (body && "name" in body) {
      const rawName = body.name;
      if (typeof rawName !== "string") {
        return NextResponse.json(
          { error: "'name' must be a string" },
          { status: 400 },
        );
      }
      const name = rawName.trim();
      if (name.length === 0) {
        return NextResponse.json(
          { error: "Account name cannot be empty" },
          { status: 400 },
        );
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `Account name must be ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 },
        );
      }
      patch.name = name;
    }

    if (body && "brand_name" in body) {
      const result = normalizeBrandName(body.brand_name);
      if (!result.ok) {
        return NextResponse.json({ error: result.error.message }, { status: 400 });
      }
      patch.brand_name = result.value;
    }

    if (body && "brand_logo_url" in body) {
      const result = normalizeBrandLogoUrl(body.brand_logo_url);
      if (!result.ok) {
        return NextResponse.json({ error: result.error.message }, { status: 400 });
      }
      patch.brand_logo_url = result.value;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "Provide 'name', 'brand_name' and/or 'brand_logo_url'" },
        { status: 400 },
      );
    }

    // RLS allows this UPDATE because accounts_update requires
    // `is_account_member(id, 'admin')`, and requireRole already
    // guaranteed the caller is admin+.
    const { data, error } = await ctx.supabase
      .from("accounts")
      .update(patch)
      .eq("id", ctx.accountId)
      .select("id, name, brand_name, brand_logo_url")
      .single();

    if (error) {
      console.error("[PATCH /api/account] update error:", error);
      return NextResponse.json(
        { error: "Failed to update account" },
        { status: 500 },
      );
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
