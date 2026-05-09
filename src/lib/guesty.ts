import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Minimal Guesty Open API client for confirmation-code lookup.
 *
 * The token endpoint allows 3 issuances per 24h per client_id, so we cache
 * tokens in memory and on disk. Configure a secondary credential pair via
 * GUESTY_OPEN_API_CLIENT_ID_2 / _SECRET_2 for failover.
 */

const TOKEN_URL = 'https://open-api.guesty.com/oauth2/token';
const API_BASE = 'https://open-api.guesty.com/v1';
const SCOPE = 'open-api';

const GUEST_APP_AUTH_URL = 'https://guest-app.guesty.com/api/public/guest-app-auth';
const GUEST_APP_RUNTIME_URL = 'https://guest-app.guesty.com/api/public/guest-app-runtime';

type TokenCache = { access_token: string; expires_at: number; client_id: string };
type Credential = { id: string; secret: string; label: 'primary' | 'secondary' };

export class GuestyError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * Thrown when Guesty's guest-app accepts the URL identifier but the
 * per-reservation runtime hasn't been published — the guest would land on
 * the "this page is on vacation" page. We surface this as a distinct error
 * so /api/lookup can return a clear message instead of redirecting.
 */
export type GuestAppNotProvisionedReason = 'too-far-out' | 'unpublished';

export class GuestAppNotProvisionedError extends Error {
  reason: GuestAppNotProvisionedReason;
  checkIn?: string;
  constructor(
    reason: GuestAppNotProvisionedReason = 'unpublished',
    checkIn?: string,
    message = 'guest-app token not yet provisioned for this reservation',
  ) {
    super(message);
    this.reason = reason;
    this.checkIn = checkIn;
  }
}

/**
 * Guesty publishes the per-reservation guest-app runtime ~7 days before
 * check-in. Anything further out gets a 404 from /initial-data even though
 * /login succeeds. We use this window to distinguish the time-gate case
 * (host can't fix) from a genuinely unpublished guest-app (host can fix).
 */
const GUEST_APP_PUBLISH_WINDOW_DAYS = 7;

function getCredentials(): Credential[] {
  const creds: Credential[] = [];
  if (process.env.GUESTY_OPEN_API_CLIENT_ID && process.env.GUESTY_OPEN_API_CLIENT_SECRET) {
    creds.push({
      id: process.env.GUESTY_OPEN_API_CLIENT_ID,
      secret: process.env.GUESTY_OPEN_API_CLIENT_SECRET,
      label: 'primary',
    });
  }
  if (process.env.GUESTY_OPEN_API_CLIENT_ID_2 && process.env.GUESTY_OPEN_API_CLIENT_SECRET_2) {
    creds.push({
      id: process.env.GUESTY_OPEN_API_CLIENT_ID_2,
      secret: process.env.GUESTY_OPEN_API_CLIENT_SECRET_2,
      label: 'secondary',
    });
  }
  return creds;
}

const memCache = new Map<string, TokenCache>();
const inflight = new Map<string, Promise<string>>();

function diskFile(clientId: string) {
  return path.join(os.tmpdir(), `guesty-open-api-token-${clientId}.json`);
}

async function loadDisk(clientId: string): Promise<TokenCache | null> {
  if (process.env.GUESTY_TOKEN_CACHE === 'off') return null;
  try {
    const buf = await fs.readFile(diskFile(clientId), 'utf8');
    const parsed = JSON.parse(buf) as TokenCache;
    if (parsed.client_id !== clientId) return null;
    if (parsed.expires_at > Date.now()) return parsed;
  } catch {
    // ignore
  }
  return null;
}

async function saveDisk(cache: TokenCache) {
  if (process.env.GUESTY_TOKEN_CACHE === 'off') return;
  try {
    await fs.writeFile(diskFile(cache.client_id), JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // ignore
  }
}

async function fetchTokenForCredential(cred: Credential): Promise<string> {
  const cached = memCache.get(cred.id);
  if (cached && cached.expires_at > Date.now()) return cached.access_token;

  const fromDisk = await loadDisk(cred.id);
  if (fromDisk) {
    memCache.set(cred.id, fromDisk);
    return fromDisk.access_token;
  }

  const existing = inflight.get(cred.id);
  if (existing) return existing;

  const promise = (async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: SCOPE,
      client_id: cred.id,
      client_secret: cred.secret,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GuestyError(res.status, text, `Guesty token error ${res.status} (${cred.label})`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    const cache: TokenCache = {
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in - 300) * 1000,
      client_id: cred.id,
    };
    memCache.set(cred.id, cache);
    await saveDisk(cache);
    return data.access_token;
  })().finally(() => inflight.delete(cred.id));

  inflight.set(cred.id, promise);
  return promise;
}

async function getToken(): Promise<string> {
  const creds = getCredentials();
  if (creds.length === 0) {
    throw new Error('Missing GUESTY_OPEN_API_CLIENT_ID or GUESTY_OPEN_API_CLIENT_SECRET');
  }
  let lastErr: unknown;
  for (const cred of creds) {
    try {
      return await fetchTokenForCredential(cred);
    } catch (e) {
      lastErr = e;
      if (e instanceof GuestyError && (e.status === 429 || e.status === 401 || e.status === 403)) continue;
      throw e;
    }
  }
  throw lastErr;
}

export type Reservation = {
  _id?: string;
  id?: string;
  confirmationCode?: string;
  status?: string;
  listingId?: string;
  checkIn?: string;
  checkOut?: string;
  guest?: { fullName?: string };
};

/**
 * Find a reservation by exact confirmation-code match. Returns null if no
 * match. Uses the open API's filters= param (not q=, which is fuzzy and
 * surfaces unrelated codes).
 */
export async function findReservationByCode(code: string): Promise<Reservation | null> {
  const token = await getToken();
  const url = new URL(`${API_BASE}/reservations`);
  url.searchParams.set(
    'filters',
    JSON.stringify([{ field: 'confirmationCode', operator: '$eq', value: code.trim() }]),
  );
  url.searchParams.set('limit', '1');
  url.searchParams.set('fields', '_id confirmationCode status listingId checkIn checkOut guest.fullName');

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GuestyError(res.status, text, `Guesty GET /reservations -> ${res.status}`);
  }
  const data = (await res.json()) as { results?: Reservation[]; data?: Reservation[] };
  return (data.results ?? data.data ?? [])[0] ?? null;
}

/**
 * Resolve the `dynamicVar` token used by Guesty's guest-app for a given
 * reservation, and verify the guest-app runtime is actually live before
 * returning. Mirrors what the guest-app SPA does on page load:
 *
 *   1. POST /api/public/guest-app-auth/login {reservationId, dynamicVar}
 *      Guesty maps `dynamicVar` to a configured guest-app instance for
 *      this account and mints a short-lived JWT bearing the resolved
 *      guestAppId. A 404 here means no guest-app is wired up for this
 *      account/identifier.
 *   2. GET  /api/public/guest-app-runtime/initial-data/<id>/<dynamicVar>
 *      Confirms a publishable runtime exists for this reservation. A 404
 *      ("Guest app runtime not found") is what produces the "page is on
 *      vacation" page in the SPA — we want to fail closed before redirect.
 *
 * Returns the verified `dynamicVar` (caller embeds it in the URL).
 * Throws `GuestAppNotProvisionedError` for the runtime-missing case so
 * /api/lookup can surface a distinct, host-actionable message.
 */
export async function resolveGuestAppToken(
  reservationId: string,
  accountSlug: string,
  checkIn?: string,
): Promise<string> {
  const dynamicVar = Buffer.from(`{{guest_app::${accountSlug}}}`).toString('base64');

  const reasonForCheckIn = (): GuestAppNotProvisionedReason => {
    if (!checkIn) return 'unpublished';
    const t = Date.parse(checkIn);
    if (Number.isNaN(t)) return 'unpublished';
    const daysOut = (t - Date.now()) / 86_400_000;
    return daysOut > GUEST_APP_PUBLISH_WINDOW_DAYS ? 'too-far-out' : 'unpublished';
  };

  const loginRes = await fetch(`${GUEST_APP_AUTH_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reservationId, dynamicVar }),
    cache: 'no-store',
  });
  if (!loginRes.ok) {
    if (loginRes.status === 404) throw new GuestAppNotProvisionedError(reasonForCheckIn(), checkIn);
    const body = await loginRes.text();
    throw new GuestyError(loginRes.status, body, `Guesty guest-app /login -> ${loginRes.status}`);
  }
  const loginJson = (await loginRes.json()) as { token?: string };
  const jwt = loginJson.token;
  if (!jwt) throw new GuestAppNotProvisionedError(reasonForCheckIn(), checkIn);

  const runtimeUrl = `${GUEST_APP_RUNTIME_URL}/initial-data/${encodeURIComponent(
    reservationId,
  )}/${encodeURIComponent(dynamicVar)}`;
  const runtimeRes = await fetch(runtimeUrl, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (runtimeRes.status === 404) throw new GuestAppNotProvisionedError(reasonForCheckIn(), checkIn);
  if (!runtimeRes.ok) {
    const body = await runtimeRes.text();
    throw new GuestyError(
      runtimeRes.status,
      body,
      `Guesty guest-app /initial-data -> ${runtimeRes.status}`,
    );
  }

  return dynamicVar;
}
