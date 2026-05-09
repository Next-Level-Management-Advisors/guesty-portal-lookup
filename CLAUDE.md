# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev         # next dev — local at http://localhost:3000
npm run build       # production build (also a smoke test)
npm run start       # start built app
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
```

There is no test runner. `typecheck` + `build` is the gate.

## Architecture

Single-purpose Next.js 16 (App Router, React 19) app: a guest enters a Guesty reservation confirmation code and gets redirected to their Guesty Guest App URL. Three pieces matter:

1. **[src/lib/guesty.ts](src/lib/guesty.ts)** — Open API client. Two non-obvious behaviors:
   - **Token caching is load-bearing.** Guesty's token endpoint enforces **3 issuances per 24h per `client_id`**. Tokens are cached in-memory and on disk (`os.tmpdir()/guesty-open-api-token-<clientId>.json`, mode 0600). An in-flight `Promise` map de-dupes concurrent token fetches. Disable disk cache with `GUESTY_TOKEN_CACHE=off`.
   - **Failover across credential pairs.** If `GUESTY_OPEN_API_CLIENT_ID_2` / `_SECRET_2` are set, `getToken()` falls through to the secondary pair on 401/403/429 from the primary. Other errors do not fall through. This is why `GuestyError` carries `status` — the fallthrough logic depends on it.
   - Reservation lookup uses `filters=[{field:'confirmationCode',operator:'$eq',value:code}]`. **Do not switch to `q=`** — that endpoint is fuzzy and surfaces unrelated codes.

2. **[src/lib/guest-app-url.ts](src/lib/guest-app-url.ts) + `resolveGuestAppToken` in [src/lib/guesty.ts](src/lib/guesty.ts)** — Builds the Guest App URL as `https://guest-app.guesty.com/r/<reservationId>/<dynamicVar>`. `dynamicVar` is `base64({{guest_app::<accountSlug>}})` — the literal merge tag, not secret. Despite the function name, `resolveGuestAppToken` does NOT swap in a different value; it computes the merge-tag form and **pre-verifies** it against Guesty's `/api/public/guest-app-auth/login` (mints a JWT) and `/api/public/guest-app-runtime/initial-data/<id>/<dynamicVar>` (confirms a published runtime). A 404 from either becomes `GuestAppNotProvisionedError`, which `/api/lookup` surfaces as a host-actionable message instead of redirecting the guest to the "this page is on vacation" SPA page. Stays >~7 days out still render that page — that gate is server-side at `guest-app.guesty.com` and can't be bypassed from the URL.
   - **Don't `encodeURIComponent` the trailing `dynamicVar`.** Guesty's guest-app SPA reads the path segment verbatim (no URL-decoding) and posts it as the JSON `dynamicVar` to `/api/public/guest-app-auth/login`. If we encode the `==` padding to `%3D%3D`, the API sees a literal `%3D%3D` suffix, doesn't match any provisioned guest-app, and 404s with `"Guest app not found"` — the page renders empty. Server-to-server calls from `/api/lookup` happen to work either way (we send raw bytes), so this only breaks the browser path. Emit base64 chars (`A-Za-z0-9+/=`) raw in the path.

3. **[src/app/api/lookup/route.ts](src/app/api/lookup/route.ts)** — POST endpoint. Validates the code against `/^[A-Za-z0-9_-]{4,64}$/`, looks up the reservation, calls `resolveGuestAppToken`, returns `{ ok, url }` or `{ ok: false, error }`. **Auth model:** possession of the confirmation code is treated as authorization (same trust model Guesty uses for its emailed magic links). Don't add a separate auth layer. Don't log the code or PII — only `console.error` for unexpected exceptions.

The client ([src/app/LookupForm.tsx](src/app/LookupForm.tsx)) is a thin form that POSTs to `/api/lookup` and does `window.location.href = data.url` on success. It also auto-submits when the URL has a `?code=<...>` query param (matching `CODE_RE`), rendering an "Opening your trip…" spinner — this is the flow used by the in-Guesty saved reply (`https://portal.fidumcompany.com/?code={{reservation.confirmationCode}}`), so don't break that contract.

## Environment

Required: `GUESTY_OPEN_API_CLIENT_ID`, `GUESTY_OPEN_API_CLIENT_SECRET`, `GUESTY_ACCOUNT_SLUG` (e.g. `fidum_company` — find by inspecting any saved-reply containing `{{guest_app::<slug>}}`).
Optional: `_2` failover pair, `GUESTY_TOKEN_CACHE=off`.

The Open API integration must have the **`open-api`** scope, **not** Booking Engine — Booking Engine only sees direct-website reservations.

## Branding

All branding flows through one module: [src/lib/brand.ts](src/lib/brand.ts). It reads `NEXT_PUBLIC_*` env vars at build time and provides defaults. Every user-visible string, the logo, the favicon, and the accent color are env-driven; no code edits are needed to rebrand.

- Copy: `NEXT_PUBLIC_HEADLINE`, `_SUBHEAD`, `_INPUT_LABEL`, `_INPUT_PLACEHOLDER`, `_SUBMIT_LABEL`, `_SUBMIT_LOADING_LABEL`, `_HELPER_TEXT`.
- Identity: `NEXT_PUBLIC_SITE_NAME`, `_SITE_URL`, `_LOGO_URL`, `_FAVICON_URL`, `_SUPPORT_URL`.
- Color: `NEXT_PUBLIC_ACCENT_COLOR`, `_ACCENT_HOVER_COLOR`, `_ACCENT_INK`. These are injected into `:root` as CSS variables by [src/app/layout.tsx](src/app/layout.tsx) via a `<style>` tag — `globals.css` carries fallbacks of the same names so the page renders correctly if the injection is somehow stripped.

Adding a new brand knob = (1) add the field + default in `brand.ts`, (2) consume `brand.x` where you need it, (3) document it in `.env.example`. Don't sprinkle `process.env.NEXT_PUBLIC_*` reads anywhere else.

## Deploying

`vercel.json` is included for one-click Vercel/Netlify-style hosting.

For the self-hosted VPS deploy (production at `portal.fidumcompany.com`):

- `deploy/rsync-up.sh` rsyncs (or tars) the repo to `/opt/guesty-portal-lookup` on `root@178.16.141.166`. Excludes `.next`, `node_modules`, `.git`, `.env.local`.
- `deploy/vps-bootstrap.sh` runs on the VPS: `npm ci && npm run build`, writes a systemd unit on **port 3014**, configures nginx vhost, runs certbot (HTTP-01 with DNS-01 fallback via `HOSTINGER_API_TOKEN`, supports `EXTRA_DOMAINS` for SAN aliases). Idempotent.
- `.env.local` is **not** in git — scp it up separately before bootstrap.

`scripts/backfill-portal-url.py` is a one-off helper that pushes the portal URL onto existing Guesty reservations as a custom field; not part of the runtime app.

## Conventions

- Repo is intentionally tiny. Don't introduce new dependencies, frameworks, or abstractions without a guest-facing reason.
- Server code uses `import 'server-only'` at the top of `src/lib/guesty.ts` to prevent accidental client-side bundling of credentials.
- `robots: { index: false, follow: false }` in [src/app/layout.tsx](src/app/layout.tsx) — keep it that way; this is not a public marketing page.
