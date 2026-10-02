// ============================================================
// GET /api/whatsapp/webhook/logs — the inbound webhook event trail
// (migration 047), feeding the Settings → Webhook events panel.
//
// Admin of the active account. Scoping is RLS, not the query: the
// table's first policy admits rows for the account the caller is
// switched into, the second admits the account-less rows (traffic
// Meta sent that matched no connection). Live updates arrive through
// the same policies via Supabase Realtime, so GET is only the
// initial page; there is no account filter to keep in step.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import type { WebhookEventLog } from "@/types";

const MAX_EVENTS = 200;

export async function GET() {
  try {
    const ctx = await requireRole("admin");

    const { data, error } = await ctx.supabase
      .from("whatsapp_webhook_logs")
      .select(
        "id, account_id, phone_number_id, event_type, status, summary, payload, error, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(MAX_EVENTS);

    if (error) {
      console.error("[GET webhook/logs] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load webhook events" },
        { status: 500 },
      );
    }

    return NextResponse.json({ events: (data ?? []) as WebhookEventLog[] });
  } catch (err) {
    return toErrorResponse(err);
  }
}