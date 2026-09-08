# Troubleshooting

## The container does not become healthy

Check `docker compose logs twitee`. Both secrets must contain at least 32 characters. The image downloads the pinned CloakBrowser binary during build, so the build needs network access; normal startup does not update it.

## Readiness returns 503

`/readyz` requires both a running crawl browser and a decryptable X session. Check `/v1/session` with the Bearer key. A `missing`, `invalid`, or `error` status requires a new login.

## The login page is blank or disconnected

Start a new login and use the newly returned URL within ten minutes. Do not reuse the URL after login completes. Confirm that port 6080 is reachable through the same trusted network path as the API and that a reverse proxy supports WebSocket upgrades.

## X asks for an extra challenge

Complete the challenge in the noVNC browser. X controls challenges, account locks, and login policy. Twitee cannot bypass them and does not collect credentials outside X's page.

## A crawl returns `upstream_changed`

X likely changed a rendered page or GraphQL response. Reproduce on the newest Twitee release before filing an issue. Share the route and sanitized structural details, never raw cookies, authorization headers, storage state, or private response data.

## A crawl returns `queue_full` or times out

One instance intentionally runs one browser crawl at a time and queues ten more. Reduce concurrent calls or run separate instances with separate X accounts and data volumes. A request deadline is 60 seconds from arrival, including time in the queue.

## Resetting the local session

Use `DELETE /v1/session` first. If the encrypted file is damaged and the API cannot remove it, stop Compose, remove only the `credential.json.enc` file from the Twitee data volume, then start and log in again. Do not delete the whole volume unless you also want to discard browser profiles and cache.
