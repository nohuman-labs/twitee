# Authentication and session storage

Twitee has two separate credentials.

`TWITEE_API_KEY` protects every `/v1/*` route. Send it as `Authorization: Bearer <key>`. Generate at least 32 random bytes and do not put it in URLs, images, logs, or source control.

`TWITEE_ENCRYPTION_KEY` encrypts the X browser session with AES-256-GCM. Twitee derives a fixed-size key with SHA-256, uses a fresh random nonce for every write, writes atomically, and sets the credential file to mode `0600`. The file is `/data/credential.json.enc` in the container.

## Logging in

Start login through the authenticated API, then open only the returned noVNC URL. The URL contains a random, ten-minute capability; it does not contain the API key. After the first valid page request, the capability is kept in an HttpOnly, SameSite cookie for noVNC reconnects.

Sign in on X's own page. Twitee does not accept an X username or password through its API. A session becomes ready only after the browser reaches X home and contains `auth_token` and `ct0` cookies.

## Removing or rotating credentials

Delete the saved X session with:

```bash
curl -X DELETE \
  -H "Authorization: Bearer $TWITEE_API_KEY" \
  http://127.0.0.1:8080/v1/session
```

You can rotate the API key by changing the environment variable and restarting the container. To rotate the encryption key, delete the session first, change the key, restart, and log in again. There is no recovery path for a credential encrypted with a lost key.

## Remote deployment

Keep the Compose loopback bindings unless you have a TLS reverse proxy and a private access layer. Protect both ports and set `TWITEE_NOVNC_URL` to the external HTTPS URL: the API key is confidential, and the noVNC capability grants control of the short-lived login browser. Twitee does not terminate TLS itself.
