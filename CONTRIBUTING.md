# Contributing

Twitee accepts focused fixes for browser lifecycle, X extraction, the public API, container deployment, and documentation.

Before opening a pull request:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Add the smallest test that would fail without your change. Keep fixtures sanitized: never commit cookies, browser storage, API keys, account credentials, local paths, or raw private X responses.

For parser changes, include a reduced fixture that contains only the fields needed to reproduce the behavior. For API changes, update `openapi.yaml` in the same pull request. Breaking API changes need an issue and a versioning plan first.

Do not use a real X account in automated tests. Describe any manual live-X checks in the pull request without posting account or session details.
