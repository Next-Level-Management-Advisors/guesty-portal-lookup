/**
 * Build and validate the Guesty Guest App URL for a reservation.
 *
 * URL shape:
 *   https://guest-app.guesty.com/r/<reservationId>/<dynamicVar>
 *
 * `dynamicVar` is the per-account token Guesty's guest-app uses to look up
 * the active guest-app instance during /api/public/guest-app-auth/login.
 * It must come from `resolveGuestAppToken()` in `guesty.ts` — never from a
 * raw base64 of the literal `{{guest_app::<slug>}}` merge tag (that was
 * the source of the "page is on vacation" bug: the SPA's /login accepts it
 * but /initial-data 404s when no guest-app runtime is provisioned, and
 * we want to fail closed in our own /api/lookup before redirecting).
 */
export const GUEST_APP_HOST = 'https://guest-app.guesty.com';

export function buildGuestAppUrl(reservationId: string, dynamicVar: string): string {
  // dynamicVar is base64 (may contain `=` padding). DO NOT encodeURIComponent it:
  // Guesty's guest-app SPA reads the trailing path segment without URL-decoding
  // and posts it verbatim to /api/public/guest-app-auth/login as the JSON
  // `dynamicVar` field. Encoding `==` to `%3D%3D` makes the API see a literal
  // `%3D%3D` suffix, which doesn't match any provisioned guest-app and returns
  // 404 "Guest app not found". Base64 chars (A-Z a-z 0-9 + / =) are safe in a
  // URL path segment in practice, so emit them raw.
  return `${GUEST_APP_HOST}/r/${encodeURIComponent(reservationId)}/${dynamicVar}`;
}

/**
 * Decode the base64 trailing segment of a guest-app URL. Returns null if
 * the URL doesn't match the expected shape or the segment isn't valid base64.
 */
export function decodeTrailingToken(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== 'r') return null;
    const tail = decodeURIComponent(parts[parts.length - 1]);
    return Buffer.from(tail, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Sanity guard: a finished URL whose trailing segment base64-decodes to a
 * value containing `{{` or `}}` is an unresolved merge tag — exactly the
 * regression we just fixed. Returns true if the URL is safe to hand to a
 * guest, false if it looks like a template literal slipped through.
 */
export function isResolvedGuestAppUrl(url: string): boolean {
  const decoded = decodeTrailingToken(url);
  if (decoded === null) return false;
  return !decoded.includes('{{') && !decoded.includes('}}');
}
