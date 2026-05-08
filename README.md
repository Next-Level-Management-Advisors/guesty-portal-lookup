# Guesty Portal Lookup

A tiny self-hostable web app that lets your guests find their Guesty Guest App by entering their reservation confirmation code.

> Live at [portal.fidumcompany.com](https://portal.fidumcompany.com).

## Why

Guesty's Guest App lives at a per-reservation URL. Guests typically receive that URL only via channel messages (Airbnb DM, Booking.com inbox, email). When a guest can't find that message, they have nowhere to go.

This app gives them a public form: enter the confirmation code, get redirected to the Guest App.

## How it works

1. Guest enters their confirmation code.
2. The server queries the Guesty Open API for an exact-match reservation by `confirmationCode`.
3. If a match exists, it constructs the Guest App URL and redirects the guest:

   ```
   https://guest-app.guesty.com/r/<reservationId>/<base64({{guest_app::<accountSlug>}})>
   ```

4. Guesty validates the URL on its side. If the stay is in its active window (currently checked-in, or checking in within ~7 days), the guest sees their full portal. Outside that window, Guesty shows a "this page is on vacation" page — that's a Guesty-side gating decision, not something this app controls.

The credential the user types is the same code Guesty itself accepts. We don't add our own auth layer — possession of the code is treated as proof, same as the Guesty-issued magic link.

## Setup

### 1. Create a Guesty Open API integration

In Guesty admin → **Integrations** → **API**, create a new integration with the **`open-api`** scope (NOT Booking Engine — that's a different scope and won't work here). Save the client ID and secret.

> The token endpoint allows **3 issuances per 24 hours per client_id**. Create a second integration if you want failover headroom across server restarts.

### 2. Find your account slug

The Guest App URL embeds your Guesty account name as a slug, like `fidum_company`. To find yours:

- Open any saved reply in Guesty that uses the Guest App merge tag, e.g. `{{guest_app::fidum_company}}`.
- The part after `::` is your account slug. It's usually your account name lowercased with spaces replaced by underscores.

### 3. Configure environment

```bash
cp .env.example .env.local
# Edit .env.local with your credentials and account slug.
```

Required:

| Variable | Notes |
|---|---|
| `GUESTY_OPEN_API_CLIENT_ID` | From step 1 |
| `GUESTY_OPEN_API_CLIENT_SECRET` | From step 1 |
| `GUESTY_ACCOUNT_SLUG` | From step 2 |

Optional (failover):

| Variable | Notes |
|---|---|
| `GUESTY_OPEN_API_CLIENT_ID_2` | A second Open API integration |
| `GUESTY_OPEN_API_CLIENT_SECRET_2` | A second Open API integration |

### Branding (optional)

Every NEXT_PUBLIC_* var below is optional with a sensible default — set only what you want to override, then rebuild.

| Variable | Default | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_NAME` | `Guest Portal` | Used in `<title>` and footer |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | Canonical URL for metadata |
| `NEXT_PUBLIC_LOGO_URL` | `/logo.svg` | The repo ships a bundled `public/logo.svg`. Override with a path or absolute URL, or set to `none` to hide the logo entirely. |
| `NEXT_PUBLIC_FAVICON_URL` | `/favicon.svg` | The repo ships a generic `public/favicon.svg`. Drop your own at `public/favicon.svg` (or any path) and point this here. |
| `NEXT_PUBLIC_ACCENT_COLOR` | `#111111` | Submit button / focus ring |
| `NEXT_PUBLIC_ACCENT_HOVER_COLOR` | `#000000` | |
| `NEXT_PUBLIC_ACCENT_INK` | `#ffffff` | Text color drawn on top of the accent |
| `NEXT_PUBLIC_HEADLINE` | `Find your trip` | |
| `NEXT_PUBLIC_SUBHEAD` | _(see .env.example)_ | |
| `NEXT_PUBLIC_INPUT_LABEL` | `Confirmation code` | |
| `NEXT_PUBLIC_INPUT_PLACEHOLDER` | `e.g. HMABCD12345` | |
| `NEXT_PUBLIC_SUBMIT_LABEL` | `Find my reservation` | |
| `NEXT_PUBLIC_SUBMIT_LOADING_LABEL` | `Looking up…` | |
| `NEXT_PUBLIC_HELPER_TEXT` | _(see .env.example)_ | |
| `NEXT_PUBLIC_SUPPORT_URL` | _none_ | If set, the footer site-name becomes a link to this URL |

These are read in one place — [`src/lib/brand.ts`](src/lib/brand.ts) — so a fork that wants opinionated defaults can just edit that file instead of setting env vars.

### 4. Run locally

```bash
npm install
npm run dev
# open http://localhost:3000
```

## Deploying

### Vercel / Cloudflare Pages / Netlify

Push the repo, connect to the platform, set the env vars in the project settings. The `vercel.json` is included for convenience but the app is plain Next.js so any Next-aware host works.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Next-Level-Management-Advisors/guesty-portal-lookup&env=GUESTY_OPEN_API_CLIENT_ID,GUESTY_OPEN_API_CLIENT_SECRET,GUESTY_ACCOUNT_SLUG)

### Self-hosted on a VPS (nginx + systemd + Let's Encrypt)

The `deploy/` directory contains scripts mirroring the layout used at `portal.fidumcompany.com`:

```bash
# From your dev box, push code:
DEPLOY_VPS=root@<your-vps-ip> bash deploy/rsync-up.sh

# scp your .env.local up separately:
scp .env.local root@<your-vps-ip>:/opt/guesty-portal-lookup/.env.local

# Then on the VPS:
DOMAIN=portal.example.com bash /opt/guesty-portal-lookup/deploy/vps-bootstrap.sh
```

The bootstrap script installs deps, builds, registers a systemd service on port 3014, configures nginx, and runs certbot for a Let's Encrypt cert.

## Token caching

Open API tokens are cached in memory and on disk (`os.tmpdir()/guesty-open-api-token-<clientId>.json`). This lets the app survive a restart without burning a fresh token issuance against the 3/day limit.

Disable disk caching with `GUESTY_TOKEN_CACHE=off` if your environment forbids writing tokens to disk (e.g. read-only filesystem, multi-tenant edge runtime).

## Security notes

- The endpoint takes only the confirmation code. We treat possession of the code as authorization to look up the reservation, same as Guesty does with their email magic links.
- The Open API credentials never leave the server.
- The constructed URL contains the reservation `_id` and a base64 of a literal merge tag string — neither is secret. Guesty validates the URL on its side using the stay window.
- We don't log confirmation codes or PII. Errors include `console.error` for unexpected exceptions only.

## Limitations

- **Guesty's stay-window gate.** Guesty currently shows a "this page is on vacation" page for stays more than ~7 days out. There's no way around this from the URL side; the gate is server-side at `guest-app.guesty.com`.
- **Cross-channel only.** This works for any reservation visible to your Open API integration: Airbnb, Booking.com, Vrbo, direct, manual. It does NOT work with the Booking Engine API (which only sees direct-website reservations).
- **Account slug is per-tenant.** If you operate under multiple Guesty accounts, you'd need a per-domain or per-route deployment.

## Contributing

PRs welcome. The repo is tiny on purpose — keep it that way unless adding genuine guest value.

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # production build smoke test
```

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

Originally extracted from the [Fidum STR booking site](https://str.fidumcompany.com).
