# Twitee

Twitee turns a real browser session into a small, self-hosted JSON API for X. Run one container, sign in to X through the built-in noVNC page, then request profiles, posts, or search results over HTTP.

Twitee uses the website that a person sees in a browser. It does not use the official X API, and it does not ask for or store your X password. The saved browser session is encrypted on your Docker volume.

> [!WARNING]
> Browser automation can break when X changes its site and may be subject to X's terms and local law. Use an account and data you are authorized to access. Twitee is not affiliated with X Corp.

## What it provides

- One X account and one serialized browser slot per instance
- Synchronous profile, post, and search endpoints
- Manual login in a headed browser through capability-protected noVNC
- AES-256-GCM encrypted session storage
- A bounded queue with a 60-second request deadline
- Docker and Docker Compose deployment on Linux `amd64` and `arm64`

Twitee has no database, background worker, durable job queue, scheduler, or web dashboard.

## Quick start

You need Docker with Compose v2.

```bash
git clone https://github.com/nohuman-labs/twitee.git
cd twitee
cp .env.example .env
```

Generate two different secrets and paste them into `.env`:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Start Twitee:

```bash
docker compose up --build -d
curl http://127.0.0.1:8080/healthz
```

Keep `TWITEE_ENCRYPTION_KEY` stable. Losing or changing it makes the saved X session unreadable and requires a new login.

## Sign in to X

Start a login session with your API key:

```bash
set -a; . ./.env; set +a
curl -X POST \
  -H "Authorization: Bearer $TWITEE_API_KEY" \
  http://127.0.0.1:8080/v1/session/login
```

Open the returned `no_vnc_url` in a browser and sign in directly on X's page. Twitee waits for `x.com/home`, verifies the `auth_token` and `ct0` cookies, encrypts the browser storage state, and closes the login browser.

Check the result:

```bash
curl -H "Authorization: Bearer $TWITEE_API_KEY" \
  http://127.0.0.1:8080/v1/session
```

The status changes from `login_pending` to `ready`. A login URL expires after ten minutes and stops working as soon as login completes.

## Call the API

```bash
# Profile
curl -H "Authorization: Bearer $TWITEE_API_KEY" \
  http://127.0.0.1:8080/v1/profiles/openai

# Profile posts
curl -H "Authorization: Bearer $TWITEE_API_KEY" \
  http://127.0.0.1:8080/v1/profiles/openai/posts

# One post
curl -H "Authorization: Bearer $TWITEE_API_KEY" \
  http://127.0.0.1:8080/v1/posts/openai/1234567890

# Latest post search
curl -G -H "Authorization: Bearer $TWITEE_API_KEY" \
  --data-urlencode "q=open source" \
  http://127.0.0.1:8080/v1/search/posts

# People search
curl -G -H "Authorization: Bearer $TWITEE_API_KEY" \
  --data-urlencode "q=OpenAI" \
  http://127.0.0.1:8080/v1/search/people
```

Pass a returned cursor unchanged with `?cursor=...` to continue profile-post or search results. The complete route, schema, and error contract is in [openapi.yaml](openapi.yaml). Ready-to-run commands are also in [examples/curl.sh](examples/curl.sh).

Success responses have one envelope:

```json
{
  "ok": true,
  "data": {},
  "next_cursor": null,
  "error": null
}
```

## Deployment notes

Compose binds the API and noVNC ports to `127.0.0.1`. Keep that default for a local deployment. For a remote host, put both ports behind a trusted TLS reverse proxy, require network-level access control, and set `TWITEE_NOVNC_URL` to the external HTTPS URL. Do not expose port 6080 directly to the public internet.

The named `twitee-data` volume contains the encrypted X session and browser cache. Login profiles live in the container's temporary filesystem and are deleted when the login browser closes. Back up the encryption key separately from the volume.

See [authentication and session storage](docs/authentication.md), [architecture](docs/architecture.md), and [troubleshooting](docs/troubleshooting.md) before running Twitee on a remote host.

## Tech stack

- Node.js 22 and TypeScript, using the native HTTP, crypto, and filesystem APIs
- CloakBrowser with Playwright Core for browser control
- Zod for boundary validation and Pino for redacted crawler logs
- Xvfb, Fluxbox, x11vnc, noVNC, and websockify for interactive login
- Vitest for tests

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
docker build -t twitee:dev .
```

Unit and integration tests use sanitized fixtures and never log in to X. Live-X verification is manual because it needs an account and can encounter account-specific challenges.

## Limits

- One X account and one crawl at a time per instance
- No durable jobs: callers wait for the HTTP response
- No official X API compatibility layer
- Site changes can require parser updates
- Login challenges, locks, and rate limits remain controlled by X

## License

[MIT](LICENSE)
