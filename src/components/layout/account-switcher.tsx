"use client";

// ============================================================
// Switch which business you are working in.
//
// Renders nothing at all for someone who belongs to one account, which
// is everyone until they are invited to a second — the switcher should
// not be a permanent reminder of a feature you do not use.
//
// Switching is a full reload rather than a state update. Every cached
// query, every open Realtime channel and every list in memory belongs to
// the business you are leaving, and RLS stops returning any of it the
// moment the active account moves (migration 045). Reloading is the
// honest way to get a clean tree; patching state would leave stale rows
// on screen that the database will no longer confirm.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { Building2, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AccountMembership } from "@/types";

export function AccountSwitcher() {
  const t = useTranslations("Sidebar.accountSwitcher");
  const [memberships, setMemberships] = useState<AccountMembership[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/account/memberships", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.memberships) return;
        setMemberships(data.memberships as AccountMembership[]);
      })
      .catch(() => {
        // Best-effort: on an older deployment without the endpoint, or
        // a transient failure, the switcher simply doesn't appear. It
        // is navigation, not something worth a toast on page load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSwitch = useCallback(
    async (accountId: string) => {
      if (switching) return;
      setSwitching(accountId);
      try {
        const res = await fetch("/api/account/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: accountId }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          toast.error(payload.error || t("switchFailed"));
          setSwitching(null);
          return;
        }
        // See the header comment: reload rather than re-render.
        window.location.reload();
      } catch {
        toast.error(t("switchFailed"));
        setSwitching(null);
      }
    },
    [switching, t],
  );

  // One business is the normal case; there is nothing to switch between.
  if (memberships.length < 2) return null;

  const active = memberships.find((m) => m.is_active);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="mb-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Building2 className="size-3.5 shrink-0" />
            <span className="truncate" title={active?.name}>
              {active?.name ?? t("selectAccount")}
            </span>
            <ChevronsUpDown className="ml-auto size-3.5 shrink-0" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("label")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {memberships.map((m) => (
          <DropdownMenuItem
            key={m.account_id}
            onClick={() => void handleSwitch(m.account_id)}
            className={cn("text-sm", m.is_active && "text-primary")}
          >
            <span className="truncate">{m.name}</span>
            {switching === m.account_id ? (
              <Loader2 className="ml-auto size-3.5 animate-spin" />
            ) : m.is_active ? (
              <Check className="ml-auto size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
