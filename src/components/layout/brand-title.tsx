"use client";

// ============================================================
// Keeps the browser tab in step with the account's branding.
//
// Why this is a client component and not `generateMetadata`
//
//   The title template lives in the root layout, which is shared with
//   the signed-out pages — login, password reset — where there is no
//   account to read branding from. Resolving branding there would mean
//   a database round trip on every request to a public page, in a
//   layout that is otherwise static. So the server keeps shipping the
//   built-in title and this rewrites the suffix once the account is
//   known, which is only ever inside the authed shell.
//
//   The trade is a brief flash of the built-in name on first paint.
//   That is the same trade the theme boot script makes and, unlike the
//   theme, a tab title changing a beat late is not visually jarring.
// ============================================================

import { useEffect } from "react";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { displayBrandName } from "@/lib/branding";

export function BrandTitle() {
  const { account } = useAuth();
  const t = useTranslations("Sidebar");
  const brand = displayBrandName(account?.brand_name, t("title"));

  useEffect(() => {
    if (!brand) return;
    const current = document.title;
    // The root layout's template is "%s — wacrm", so a page title
    // arrives here as "Inbox — wacrm". Swap only what follows the last
    // separator, which leaves the page's own half alone — rewriting the
    // whole title would erase which page you are on.
    const SEPARATOR = " — ";
    const idx = current.lastIndexOf(SEPARATOR);
    const next =
      idx === -1 ? brand : `${current.slice(0, idx)}${SEPARATOR}${brand}`;
    if (next !== current) document.title = next;
  }, [brand]);

  return null;
}
