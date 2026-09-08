# Security policy

Security fixes are supported for the latest released version of Twitee.

Please do not open a public issue for a vulnerability. Use GitHub's **Report a vulnerability** form in the Security tab of this repository. Include the affected version, impact, a minimal reproduction, and any suggested mitigation. Do not include real X cookies, storage state, passwords, or API keys.

Twitee stores an authenticated browser session, so treat its data volume and encryption key as secrets. Keep the API and noVNC endpoints on a private network or behind a trusted TLS reverse proxy. See [docs/authentication.md](docs/authentication.md) for the deployment boundary.
