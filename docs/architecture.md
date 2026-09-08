# Architecture

Twitee is one Node.js process with one crawl browser and one X account.

```text
API client ──Bearer key──> HTTP API ──FIFO gate──> CloakBrowser ──> x.com
                              │                       │
                              │                       └─ one isolated context per crawl
                              │
Browser ──login capability──> noVNC proxy ──loopback──> websockify ─> x11vnc
                                                      Xvfb + headed login browser

Docker volume ──> AES-256-GCM encrypted Playwright storage state
```

## Request path

Every `/v1/*` request first passes constant-time Bearer-key validation. Crawl routes validate handles, post IDs, queries, and cursor size before starting browser work. A single in-memory gate runs one crawl at a time and holds at most ten waiting requests. The 60-second deadline includes queue time.

For a crawl, Twitee decrypts the stored Playwright state, opens an isolated browser context, navigates through the live X provider, normalizes the result, and closes the context. The HTTP request receives the result directly; there is no worker or durable job state.

## Login path

`POST /v1/session/login` creates a random capability that expires after ten minutes. The Node process validates it before serving noVNC files or forwarding a WebSocket. Raw VNC on port 5900 and raw websockify on port 6081 listen only inside the container on `127.0.0.1`.

The headed login browser visits `https://x.com/login`. Twitee never renders its own password form. Once X reaches `/home`, Twitee requires both authentication cookies, encrypts the full browser storage state, and invalidates the login capability.

## Failure model

Browser crashes and X response changes produce stable public error codes without exposing upstream payloads. A client disconnect cancels queued work and attempts to abort active work. Restarting the process loses queued requests but keeps the encrypted session on the volume.
