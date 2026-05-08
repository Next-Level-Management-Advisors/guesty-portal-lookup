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

2. **[src/lib/guest-app-url.ts](src/lib/guest-app-url.ts)** — Builds the Guest App URL as `https://guest-app.guesty.com/r/<reservationId>/<base64({{guest_app::<accountSlug>}})>`. The base64'd merge tag is not secret; Guesty validates the URL on its side using the stay window. Stays >~7 days out render Guesty's "this page is on vacation" page — that gate lives at `guest-app.guesty.com` and cannot be bypassed from the URL.

3. **[src/app/api/lookup/route.ts](src/app/api/lookup/route.ts)** — POST endpoint. Validates the code against `/^[A-Za-z0-9_-]{4,64}$/`, looks up the reservation, returns `{ ok, url }` or `{ ok: false, error }`. **Auth model:** possession of the confirmation code is treated as authorization (same trust model Guesty uses for its emailed magic links). Don't add a separate auth layer. Don't log the code or PII — only `console.error` for unexpected exceptions.

The client (`src/app/LookupForm.tsx`) is a thin form that POSTs to `/api/lookup` and does `window.location.href = data.url` on success.

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
- `deploy/vps-bootstrap.sh` runs on the VPS: `npm ci && npm run build`, writes a systemd unit on **port 3014**, configures nginx vhost, runs certbot. Idempotent.
- `.env.local` is **not** in git — scp it up separately before bootstrap.

## Conventions

- Repo is intentionally tiny. Don't introduce new dependencies, frameworks, or abstractions without a guest-facing reason.
- Server code uses `import 'server-only'` at the top of `src/lib/guesty.ts` to prevent accidental client-side bundling of credentials.
- `robots: { index: false, follow: false }` in [src/app/layout.tsx](src/app/layout.tsx) — keep it that way; this is not a public marketing page.
