"use client";

// ============================================================
// Switch which business you are working in — and, since migration
// 046, start a new one.
//
// Solo users (one membership) get only a compact "create a business"
// entry: an account-switching dropdown with one row is noise. Members
// of two or more businesses get the full switcher, with creation at
// the bottom of its list.
//
// Switching is a full reload rather than a state update. Every cached
// query, every open Realtime channel and every list in memory belongs to
// the business you are leaving, and RLS stops returning any of it the
// moment the active account moves (migration 045). Reloading is the
// honest way to get a clean tree; patching state would leave stale rows
// on screen that the database will no longer confirm. Creating works
// the same way — the RPC switches you into the new business, and the
// same reload is what lands you there.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { Building2, Check, ChevronRight, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { AccountMembership } from "@/types";

const MAX_NAME_LENGTH = 80;

export function AccountSwitcher() {
  const t = useTranslations("Sidebar.accountSwitcher");
  const [memberships, setMemberships] = useState<AccountMembership[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

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

  const canSwitch = memberships.length >= 2;
  const active = memberships.find((m) => m.is_active);

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

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return;
    setCreating(true);
    try {
      const res = await fetch("/api/account/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t("createFailed"));
        setCreating(false);
        return;
      }
      // The RPC switched us into the new business; a reload is how
      // every other business move in this component ends up on screen.
      window.location.reload();
    } catch {
      toast.error(t("createFailed"));
      setCreating(false);
    }
  }, [name, t]);

  const triggerClassName =
    "mb-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  // Solo users: creation only. The button opens the same dialog the
  // dropdown's item does, so one owner path regardless of membership count.
  if (!canSwitch) {
    return (
      <>
        <button
          type="button"
          className={triggerClassName}
          onClick={() => {
            setName("");
            setCreateOpen(true);
          }}
        >
          <Plus className="size-3.5 shrink-0" />
          <span className="truncate">{t("createBusiness")}</span>
        </button>
        <CreateBusinessDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          name={name}
          onNameChange={setName}
          creating={creating}
          onCreate={() => void handleCreate()}
        />
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button type="button" className={triggerClassName}>
              <Building2 className="size-3.5 shrink-0" />
              <span className="truncate" title={active?.name}>
                {active?.name ?? t("selectAccount")}
              </span>
              <ChevronsUpDown className="ml-auto size-3.5 shrink-0" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="w-56">
          {/* GroupLabel reads MenuGroupContext: wrapping label and items
              in a Group is required or opening the menu crashes the page
              (see ui/dropdown-menu-group-label.test.tsx). */}
          <DropdownMenuGroup>
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
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setName("");
              setCreateOpen(true);
            }}
            className="text-sm"
          >
            <span className="truncate">{t("createBusiness")}</span>
            <ChevronRight className="ml-auto size-3.5" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateBusinessDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        name={name}
        onNameChange={setName}
        creating={creating}
        onCreate={() => void handleCreate()}
      />
    </>
  );
}

interface CreateBusinessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (name: string) => void;
  creating: boolean;
  onCreate: () => void;
}

function CreateBusinessDialog({
  open,
  onOpenChange,
  name,
  onNameChange,
  creating,
  onCreate,
}: CreateBusinessDialogProps) {
  const t = useTranslations("Sidebar.accountSwitcher");
  const valid =
    name.trim().length > 0 && name.trim().length <= MAX_NAME_LENGTH;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("createBusinessTitle")}</DialogTitle>
          <DialogDescription>{t("createBusinessDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="new-business-name" className="text-sm">
            {t("businessName")}
          </Label>
          <Input
            id="new-business-name"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            placeholder={t("businessNamePlaceholder")}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid && !creating) onCreate();
            }}
            disabled={creating}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            {t("cancel")}
          </Button>
          <Button onClick={onCreate} disabled={!valid || creating}>
            {creating && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {creating ? t("creating") : t("createBusinessConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}