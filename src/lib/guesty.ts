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
 * Thrown when Guesty's guest-app /initial-data 404s after we've already
 * tried to publish the runtime by posting the merge-tag note.
 */
export class GuestAppNotProvisionedError extends Error {
  constructor(message = 'guest-app runtime not provisioned for this reservation') {
    super(message);
  }
}

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
 * Find the conversation for a reservation. Returns the conversationId or
 * null if none exists (rare — typically only HOST-... reservations created
 * without a guest channel).
 */
async function findConversationForReservation(reservationId: string): Promise<string | null> {
  const token = await getToken();
  const url = new URL(`${API_BASE}/communication/conversations`);
  url.searchParams.set(
    'filters',
    JSON.stringify([{ field: 'reservation._id', operator: '$eq', value: reservationId }]),
  );
  url.searchParams.set('limit', '1');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: { conversations?: Array<{ _id: string }> } };
  return data.data?.conversations?.[0]?._id ?? null;
}

/**
 * Trigger Guesty to publish the guest-app runtime for a reservation by
 * posting an internal `module.type: "note"` post containing the literal
 * `{{guest_app::<slug>}}` merge tag. Guesty renders the tag server-side,
 * and as a side effect publishes the runtime — typically within ~15s.
 * The note is internal-only; guests never see it.
 *
 * Idempotent: posting the note again on an already-published reservation
 * just adds another internal note entry, no harm done.
 */
async function publishGuestAppRuntime(reservationId: string, accountSlug: string): Promise<void> {
  const conversationId = await findConversationForReservation(reservationId);
  if (!conversationId) return; // nothing to do
  const token = await getToken();
  await fetch(
    `${API_BASE}/communication/conversations/${conversationId}/send-message`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        body: `{{guest_app::${accountSlug}}}`,
        module: { type: 'note' },
      }),
      cache: 'no-store',
    },
  );
  // Don't throw on non-OK — we'll observe the result via the runtime retry.
}

const RUNTIME_RETRY_DELAYS_MS = [3_000, 5_000, 7_000];

async function loginToGuestApp(reservationId: string, dynamicVar: string): Promise<string | null> {
  const res = await fetch(`${GUEST_APP_AUTH_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reservationId, dynamicVar }),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new GuestyError(res.status, body, `Guesty guest-app /login -> ${res.status}`);
  }
  const json = (await res.json()) as { token?: string };
  return json.token ?? null;
}

async function fetchRuntimeStatus(
  reservationId: string,
  dynamicVar: string,
  jwt: string,
): Promise<number> {
  const url = `${GUEST_APP_RUNTIME_URL}/initial-data/${encodeURIComponent(
    reservationId,
  )}/${encodeURIComponent(dynamicVar)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  return res.status;
}

/**
 * Resolve the `dynamicVar` token used by Guesty's guest-app for a given
 * reservation. Verifies the runtime is live before returning. If the
 * runtime is unprovisioned, posts a merge-tag internal note to publish
 * it and retries with a short backoff. Throws GuestAppNotProvisionedError
 * if the retries don't succeed.
 */
export async function resolveGuestAppToken(
  reservationId: string,
  accountSlug: string,
): Promise<string> {
  const dynamicVar = Buffer.from(`{{guest_app::${accountSlug}}}`).toString('base64');

  const jwt = await loginToGuestApp(reservationId, dynamicVar);
  if (!jwt) throw new GuestAppNotProvisionedError();

  let status = await fetchRuntimeStatus(reservationId, dynamicVar, jwt);
  if (status === 200) return dynamicVar;
  if (status !== 404) {
    throw new GuestyError(status, '', `Guesty guest-app /initial-data -> ${status}`);
  }

  // Runtime not published yet — kick Guesty to publish it, then retry.
  await publishGuestAppRuntime(reservationId, accountSlug);
  for (const delay of RUNTIME_RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay));
    status = await fetchRuntimeStatus(reservationId, dynamicVar, jwt);
    if (status === 200) return dynamicVar;
    if (status !== 404) {
      throw new GuestyError(status, '', `Guesty guest-app /initial-data -> ${status}`);
    }
  }
  throw new GuestAppNotProvisionedError();
}
