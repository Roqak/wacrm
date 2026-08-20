// ============================================================
// Branding — the operator's own product name and mark.
//
// Pure validation + normalization, no I/O, so the API route and the
// settings form apply the same rules and a rejection never comes as a
// surprise after the round trip.
//
// What "unbranded" means
//
//   Both fields are nullable, and null is not the same as "the default
//   string". An unbranded install reads its name out of the translation
//   files, so it says "CRM Template for WhatsApp" in English and the
//   Korean equivalent in Korean. Storing the English literal as a
//   default would freeze every account into English. That is why the
//   normalizers below turn an empty string into null rather than into a
//   fallback: clearing the field must restore the translated name.
// ============================================================

export const BRAND_NAME_MAX_LEN = 40;
export const BRAND_LOGO_URL_MAX_LEN = 2048;

export type BrandingFieldError =
  | { field: 'brand_name'; message: string }
  | { field: 'brand_logo_url'; message: string };

/**
 * Normalize a submitted product name.
 *
 * Returns `null` for anything blank — that is the "go back to the
 * built-in, translated name" signal, not an error.
 */
export function normalizeBrandName(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: BrandingFieldError } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: { field: 'brand_name', message: "'brand_name' must be a string or null" },
    };
  }
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > BRAND_NAME_MAX_LEN) {
    return {
      ok: false,
      error: {
        field: 'brand_name',
        message: `Name must be ${BRAND_NAME_MAX_LEN} characters or fewer`,
      },
    };
  }
  return { ok: true, value };
}

/**
 * Normalize a submitted logo URL.
 *
 * Restricted to http/https. Nothing on the server fetches this value —
 * it only ever reaches an `<img src>` in the browser — so this is not
 * an SSRF guard. It is there to keep `javascript:` and `data:` out of
 * an attribute that an account admin controls and every member of the
 * account renders.
 */
export function normalizeBrandLogoUrl(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: BrandingFieldError } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: {
        field: 'brand_logo_url',
        message: "'brand_logo_url' must be a string or null",
      },
    };
  }
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > BRAND_LOGO_URL_MAX_LEN) {
    return {
      ok: false,
      error: { field: 'brand_logo_url', message: 'Logo URL is too long' },
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      error: {
        field: 'brand_logo_url',
        message: 'Logo URL must be a full URL, e.g. https://example.com/logo.png',
      },
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      error: {
        field: 'brand_logo_url',
        message: 'Logo URL must start with http:// or https://',
      },
    };
  }
  return { ok: true, value: url.toString() };
}

/**
 * The product name to display. `fallback` is the translated built-in,
 * which is why it is a parameter rather than a constant in here — this
 * module has no business knowing what language the viewer reads.
 */
export function displayBrandName(
  brandName: string | null | undefined,
  fallback: string,
): string {
  const trimmed = brandName?.trim();
  return trimmed ? trimmed : fallback;
}
