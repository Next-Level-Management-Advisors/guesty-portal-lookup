/**
 * Build the Guesty Guest App URL for a reservation.
 *
 * Format observed in the wild:
 *   https://guest-app.guesty.com/r/<reservationId>/<base64>
 *
 * where <base64> is the base64-encoded merge tag string
 *   {{guest_app::<accountSlug>}}
 *
 * The <accountSlug> is your Guesty account name lowercased with spaces
 * replaced by underscores. Find it by inspecting any saved-reply or sent
 * email containing the {{guest_app::...}} merge tag in your Guesty account.
 *
 * Note: Guesty gates portal access by stay-window — reservations with
 * check-in more than ~7 days in the future render an "on vacation" page.
 * That's a Guesty-side check, not a URL construction issue.
 */
export function buildGuestAppUrl(reservationId: string, accountSlug: string): string {
  const tag = Buffer.from(`{{guest_app::${accountSlug}}}`).toString('base64');
  return `https://guest-app.guesty.com/r/${encodeURIComponent(reservationId)}/${tag}`;
}
