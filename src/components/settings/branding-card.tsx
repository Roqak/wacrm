"use client";

// ============================================================
// Branding — Settings → Appearance.
//
// Sits under the theme controls, but is a different kind of setting and
// says so: theme and mode are per-device and save themselves, while
// this is account-wide, admin-only, and has a Save button because every
// member sees the result.
//
// Deliberately not a live preview of the whole app. The one thing worth
// previewing is how the mark and the name sit together in the sidebar,
// so that exact pairing is what the card shows.
// ============================================================

import { useEffect, useState } from "react";
import { Building2, Loader2, MessageSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import {
  BRAND_NAME_MAX_LEN,
  displayBrandName,
  normalizeBrandLogoUrl,
  normalizeBrandName,
} from "@/lib/branding";

export function BrandingCard() {
  const t = useTranslations("Settings.branding");
  const tSidebar = useTranslations("Sidebar");
  const { account, canEditSettings, refreshProfile } = useAuth();

  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [saving, setSaving] = useState(false);
  // The logo is a URL the admin types, so it is routinely broken
  // mid-edit. Tracking that lets the preview say so instead of
  // rendering a browser's broken-image glyph.
  const [logoBroken, setLogoBroken] = useState(false);

  // Seed the form from the account once it resolves. Keyed on the
  // stored values so a save (which refreshes the account) re-syncs the
  // inputs rather than leaving them holding pre-save text.
  const storedName = account?.brand_name ?? "";
  const storedLogo = account?.brand_logo_url ?? "";
  useEffect(() => {
    setName(storedName);
    setLogoUrl(storedLogo);
    setLogoBroken(false);
  }, [storedName, storedLogo]);

  const previewName = displayBrandName(name, tSidebar("title"));
  const dirty = name !== storedName || logoUrl !== storedLogo;

  async function handleSave() {
    // Validate with the same module the API route uses, so a rejection
    // is immediate rather than a round trip away.
    const nameResult = normalizeBrandName(name);
    if (!nameResult.ok) {
      toast.error(nameResult.error.message);
      return;
    }
    const logoResult = normalizeBrandLogoUrl(logoUrl);
    if (!logoResult.ok) {
      toast.error(logoResult.error.message);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_name: nameResult.value,
          brand_logo_url: logoResult.value,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t("saveFailed"));
        return;
      }
      toast.success(t("saveSuccess"));
      // Re-fetch the profile, which reloads the account alongside it,
      // so the sidebar and tab title update without a page reload —
      // they read the same context this form just wrote.
      await refreshProfile();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-8 space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Building2 className="size-4 text-muted-foreground" />
        {t("title")}
      </h3>
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t("description")}
      </p>

      <div className="max-w-2xl space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-2">
          <Label htmlFor="brand-name">{t("nameLabel")}</Label>
          <Input
            id="brand-name"
            value={name}
            maxLength={BRAND_NAME_MAX_LEN}
            onChange={(e) => setName(e.target.value)}
            placeholder={tSidebar("title")}
            disabled={!canEditSettings || saving}
          />
          <p className="text-xs text-muted-foreground">{t("nameHint")}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="brand-logo">{t("logoLabel")}</Label>
          <Input
            id="brand-logo"
            value={logoUrl}
            onChange={(e) => {
              setLogoUrl(e.target.value);
              setLogoBroken(false);
            }}
            placeholder="https://example.com/logo.png"
            disabled={!canEditSettings || saving}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{t("logoHint")}</p>
        </div>

        {/* Preview — the sidebar header, as it will actually look.
            Plain <img> for the same reason as the sidebar: next/image
            would pull an admin-supplied URL through the server. */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t("preview")}
          </p>
          <div className="flex items-center gap-2 rounded-md border border-border bg-background p-3">
            {logoUrl.trim() && !logoBroken ? (
              <img
                src={logoUrl.trim()}
                alt=""
                onError={() => setLogoBroken(true)}
                className="h-8 w-8 shrink-0 rounded-lg object-contain"
              />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <MessageSquare className="h-4 w-4" />
              </div>
            )}
            <span className="truncate text-sm font-semibold text-foreground">
              {previewName}
            </span>
          </div>
          {logoBroken && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t("logoBroken")}
            </p>
          )}
        </div>

        {canEditSettings ? (
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving || !dirty}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t("save")}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("adminOnly")}</p>
        )}
      </div>
    </div>
  );
}
