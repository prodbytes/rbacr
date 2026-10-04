# floci

Runs [Floci](https://floci.io/), a local AWS emulator, as rbacr's
**CloudFront** distribution. It serves the vite dev server over **HTTPS**,
the way the deployed CloudFront serves the Lambda
([infra/app.yaml](../infra/app.yaml)). The pattern follows
prodbytes/presence's `presence_floci`.

| URL | Notes |
|-----|-------|
| https://local.rbacr.nu01.com:8444/ | Public name for 127.0.0.1 (`infra/zone.yaml`). Use it for Google sign-in. |
| https://rbacr.localhost:8444/ | Works before the DNS record exists. Browsers resolve `*.localhost` to loopback. |
| http://localhost:5173/ | The dev server directly, without Floci |

`devbox services up` starts Floci as `3-floci`. The ports are 4567 (HTTP
and HTTPS) and 8444 (HTTPS), rather than Floci's defaults 4566/8443, so it
runs side by side with presence's Floci.

## Files

| Path | Holds |
|------|-------|
| [compose.yaml](compose.yaml) | The `rbacr-floci` container, bound to 127.0.0.1 |
| [init/ready.d/10-cloudfront.sh](init/ready.d/10-cloudfront.sh) | Ready hook: creates the cache policy, origin request policy and distribution |
| `certs/` (git-ignored) | The local certificate and key, from [scripts/local-certs.sh](../scripts/local-certs.sh) |

## How it works

- Storage is `memory`, so every start is clean and the hook recreates the
  distribution.
- Nothing is cached. Every viewer header except `Host`, plus all cookies
  and query strings, is forwarded, as with AWS's managed
  `AllViewerExceptHostHeader` policy. Floci doesn't model managed
  policies, so the hook creates an equivalent one.
- The origin is `dev.rbacr.localhost:5173`. Inside the container, compose
  maps that name to the Docker host (`host-gateway`), and it is allowlisted
  as a private origin. In the browser it resolves to loopback, so vite's HMR
  WebSocket, which Floci can't carry, goes straight to the dev server.
- `RBACR_PUBLIC_ORIGIN` (set by process-compose) makes Google redirect back
  to the HTTPS URL. Sign in there, not on `localhost:5173`.

## HTTPS

- `scripts/local-certs.sh` runs before Floci starts. With
  [mkcert](https://github.com/FiloSottile/mkcert) (from devbox), it writes
  `certs/rbacr.pem` and `certs/rbacr-key.pem` for `local.rbacr.nu01.com`,
  `rbacr.localhost`, `*.rbacr.localhost`, `localhost`, `127.0.0.1` and `::1`.
  It regenerates them only when they are missing, expire within 30 days,
  don't cover every name, or weren't signed by this machine's CA.
- **To make browsers trust the certificate, run once:**
  `devbox run mkcert -install`. This asks for your password, because it adds
  mkcert's CA to the system trust store.
- The health monitor's `🔒 https` check calls `/api/health` through Floci
  and validates the certificate against mkcert's CA.
- Node (for example the end-to-end tests) needs the CA as well:
  `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" RBACR_E2E_URL=https://rbacr.localhost:8444 npm run test:e2e`.

## Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `RBACR_FLOCI_PORT` | `4567` | Host port for Floci (HTTP and HTTPS) |
| `RBACR_FLOCI_HTTPS_PORT` | `8444` | Host port for Floci's HTTPS listener |
| `RBACR_CDN_ALIAS` | `rbacr.localhost` | Distribution alias |
| `RBACR_PUBLIC_HOST` | `local.rbacr.nu01.com` | Second alias with a public TLD, for Google; also in the certificate |
| `RBACR_ORIGIN_HOST` | `dev.rbacr.localhost` | Origin host: the Docker host inside the container, loopback in the browser |
| `RBACR_BIND_HOST` | `127.0.0.1` | Where vite listens. The dev container sets `0.0.0.0`, because there Floci reaches it through the Docker bridge. |

## Dev server quirks behind Floci

- **Hot reload.** process-compose sets `RBACR_HMR_HOST=dev.rbacr.localhost`, so
  vite's HMR socket (`ws://dev.rbacr.localhost:5173`) goes straight to the dev
  server. Floci can't carry WebSockets, and browsers allow a `ws://` socket to
  `*.localhost` from an `https://` page.
- **Dynamic routes.** Floci rejects raw `[` and `]` in request paths (400), and
  SvelteKit's dev server imports route modules by paths like
  `/src/routes/systems/[system]/+page.ts`. A dev-only middleware in
  [vite.config.ts](../vite.config.ts) rewrites those references in served
  JavaScript and HTML to `%5B`/`%5D`, which vite decodes. Production builds
  use hashed chunk names, so CloudFront never sees brackets.

## Limitations

- Only the CDN is emulated. Locally the app runs on vite, not as a Lambda,
  and Floci adds no origin secret.
- On Linux outside the dev container, `host-gateway` is the bridge address,
  so set `RBACR_BIND_HOST=0.0.0.0`.
