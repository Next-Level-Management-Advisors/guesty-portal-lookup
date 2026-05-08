/**
 * Brand configuration, read from NEXT_PUBLIC_* env vars at build time.
 *
 * Every field has a sensible default so an unconfigured deploy still looks
 * fine. To rebrand, set the relevant vars in .env.local (or your host's
 * environment) and rebuild — no code changes required.
 *
 * NEXT_PUBLIC_* values are inlined into the client bundle, so don't put
 * anything secret here.
 */

export type Brand = {
  siteName: string;
  brandName: string;
  siteUrl: string;
  logoUrl: string | null;
  faviconUrl: string;
  headline: string;
  subhead: string;
  inputLabel: string;
  inputPlaceholder: string;
  submitLabel: string;
  submitLoadingLabel: string;
  helperText: string;
  supportUrl: string | null;
  accentColor: string;
  accentHoverColor: string;
  accentInk: string;
};

function pick(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v && v.length > 0 ? v : fallback;
}

function pickOptional(value: string | undefined): string | null {
  const v = value?.trim();
  return v && v.length > 0 ? v : null;
}

/**
 * Logo URL resolution:
 *   unset / blank → /logo.svg (the bundled default in /public)
 *   "none"        → no logo rendered
 *   anything else → that exact value
 */
function resolveLogoUrl(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return '/logo.svg';
  if (v.toLowerCase() === 'none') return null;
  return v;
}

const siteName = pick(process.env.NEXT_PUBLIC_SITE_NAME, 'Guest Portal');
const brandName = pick(process.env.NEXT_PUBLIC_BRAND_NAME, siteName.replace(/\s+guest\s+portal$/i, '').trim() || siteName);

export const brand: Brand = {
  siteName,
  brandName,
  siteUrl: pick(process.env.NEXT_PUBLIC_SITE_URL, 'http://localhost:3000'),
  logoUrl: resolveLogoUrl(process.env.NEXT_PUBLIC_LOGO_URL),
  faviconUrl: pick(process.env.NEXT_PUBLIC_FAVICON_URL, '/favicon.svg'),
  headline: pick(process.env.NEXT_PUBLIC_HEADLINE, `${brandName} guest portal`),
  subhead: pick(
    process.env.NEXT_PUBLIC_SUBHEAD,
    "Enter your reservation code and we'll take you straight to your trip — address, Wi-Fi, door code, and your host's number.",
  ),
  inputLabel: pick(process.env.NEXT_PUBLIC_INPUT_LABEL, 'Reservation code'),
  inputPlaceholder: pick(process.env.NEXT_PUBLIC_INPUT_PLACEHOLDER, 'HMABCD12345'),
  submitLabel: pick(process.env.NEXT_PUBLIC_SUBMIT_LABEL, 'Open my trip'),
  submitLoadingLabel: pick(process.env.NEXT_PUBLIC_SUBMIT_LOADING_LABEL, 'Finding your trip…'),
  helperText: pick(
    process.env.NEXT_PUBLIC_HELPER_TEXT,
    "Look for it in the booking confirmation from Airbnb, Vrbo, Booking.com, or your host's email.",
  ),
  supportUrl: pickOptional(process.env.NEXT_PUBLIC_SUPPORT_URL),
  accentColor: pick(process.env.NEXT_PUBLIC_ACCENT_COLOR, '#ff385c'),
  accentHoverColor: pick(process.env.NEXT_PUBLIC_ACCENT_HOVER_COLOR, '#e31c5f'),
  accentInk: pick(process.env.NEXT_PUBLIC_ACCENT_INK, '#ffffff'),
};
