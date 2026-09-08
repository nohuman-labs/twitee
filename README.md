# Twitee

[![CI](https://github.com/nohuman-labs/twitee/actions/workflows/ci.yml/badge.svg)](https://github.com/nohuman-labs/twitee/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![A browser session flowing through encrypted storage into a JSON API](docs/images/twitee-hero.png)

Twitee turns a real browser session into a small, self-hosted JSON API for X. Deploy one container, sign in to X through the built-in browser, then request profiles, posts, and search results over HTTP.

Twitee crawls the website a person sees in a browser. It does not use the official X API, ask for your X password, or depend on a database, worker, or job queue.

## How it works

```mermaid
flowchart LR
    A[Deploy Twitee] --> B[Open the noVNC login URL]
    B --> C[Sign in on x.com]
    C --> D[(Encrypted session in /data)]
    E[Authenticated API request] --> F[Browser crawler]
    D --> F
    F --> G[Normalized JSON response]
```

1. Twitee starts a browser and a small HTTP API.
2. `POST /v1/session/login` returns a short-lived noVNC URL. You sign in on the real X page shown there.
3. Twitee saves the resulting browser session as AES-256-GCM encrypted data on the Docker volume.
4. Each API request opens an isolated browser context with that session, reads X, returns normalized JSON, and closes the context.

One instance uses one X account and runs one crawl at a time. Up to ten requests can wait in memory; each request has a 60-second deadline.

> [!WARNING]
> Browser automation can break when X changes its site and may be subject to X's terms and local law. Use an account and data you are authorized to access. Twitee is not affiliated with X Corp.

## Quick start

You need Docker with Compose v2.

### 1. Configure Twitee

```bash
git clone https://github.com/nohuman-labs/twitee.git
cd twitee
cp .env.example .env
```

Generate two different secrets:

```bash
# Use this value for TWITEE_API_KEY
openssl rand -hex 32

# Use this value for TWITEE_ENCRYPTION_KEY
openssl rand -hex 32
```

Paste them into `.env`, then start the service:

```bash
docker compose up --build -d
curl http://127.0.0.1:8080/healthz
```

A healthy process returns:

```json
{"ok":true,"service":"twitee"}
```

### 2. Sign in to X

Load your configuration and start a login session:

```bash
set -a; . ./.env; set +a

curl -X POST \
  -H "Authorization: Bearer $TWITEE_API_KEY" \
  http://127.0.0.1:8080/v1/session/login
```

Open the returned `no_vnc_url` in your browser and sign in directly on X. The URL expires after ten minutes and stops working as soon as login completes.

Check the session:

```bash
curl -H "Authorization: Bearer $TWITEE_API_KEY" \
  http://127.0.0.1:8080/v1/session
```

Continue when its status is `ready`. Twitee has verified the `auth_token` and `ct0` cookies, encrypted the browser session, and closed the login browser.

### 3. Make your first request

```bash
curl -H "Authorization: Bearer $TWITEE_API_KEY" \
  http://127.0.0.1:8080/v1/profiles/openai
```

Every `/v1/*` endpoint returns the same envelope:

```json
{
  "ok": true,
  "data": {
    "handle": "openai",
    "displayName": "OpenAI",
    "availabilityStatus": "available"
  },
  "next_cursor": null,
  "error": null
}
```

## API

All `/v1/*` routes require `Authorization: Bearer <TWITEE_API_KEY>`.

| Method | Route | Result |
| --- | --- | --- |
| `POST` | `/v1/session/login` | Start interactive X login |
| `GET` | `/v1/session` | Read session status |
| `DELETE` | `/v1/session` | Delete the stored session |
| `GET` | `/v1/profiles/:handle` | Get a profile |
| `GET` | `/v1/profiles/:handle/posts` | List profile posts |
| `GET` | `/v1/posts/:handle/:postId` | Get one post |
| `GET` | `/v1/search/posts?q=...` | Search latest posts |
| `GET` | `/v1/search/people?q=...` | Search accounts |

Profile-post and search responses may include `next_cursor`. Pass it back unchanged as the `cursor` query parameter to fetch the next page.

See the complete request, response, and error schemas in [openapi.yaml](openapi.yaml). More curl examples are in [examples/curl.sh](examples/curl.sh).

## Deployment and security

Docker Compose binds the API and noVNC ports to `127.0.0.1` by default:

| Port | Purpose | Exposure |
| --- | --- | --- |
| `8080` | JSON API | Keep private or place behind authenticated TLS |
| `6080` | Interactive login | Keep private; never expose directly to the internet |

For a remote deployment, put both ports behind a trusted TLS reverse proxy and network-level access control. Set `TWITEE_NOVNC_URL` to the external HTTPS address used for port `6080`.

The `twitee-data` volume contains the encrypted X session and browser cache. Keep `TWITEE_ENCRYPTION_KEY` stable and store it separately from the volume. Losing or changing the key makes the session unreadable and requires another login.

The noVNC URL contains a random capability rather than your API key. Raw VNC and websockify remain bound to loopback inside the container. Login profiles use temporary storage and are removed after the browser closes.

Read [authentication and session storage](docs/authentication.md) before deploying outside a local machine. Operational details are in [architecture](docs/architecture.md) and [troubleshooting](docs/troubleshooting.md).

## Tech stack

- Node.js 22 and TypeScript
- CloakBrowser and Playwright Core
- Native Node.js HTTP, crypto, and filesystem APIs
- Zod for input validation and Pino for redacted logs
- Xvfb, Fluxbox, x11vnc, noVNC, and websockify for interactive login
- Docker, Docker Compose, and Vitest

Linux `amd64` and `arm64` are supported.

## Limits

- One X account and one active crawl per instance
- No durable jobs; callers wait for the HTTP response
- No official X API compatibility layer
- X can impose login challenges, account locks, or rate limits
- Site changes can require parser updates

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
docker build -t twitee:dev .
```

Tests use sanitized fixtures and never log in to X. Live-X verification is manual because it needs an account and may encounter account-specific challenges.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and report security issues through GitHub's private vulnerability reporting flow described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
