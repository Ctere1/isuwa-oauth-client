# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-09-05

The package is rewritten in TypeScript with no runtime dependencies. It stays what its
name says: an OAuth2 client, with nothing tied to one connector.

### Added

- `IsuwaClient`: token caching and refresh, JWKS verification, and `request()`, which
  sends `Authorization`, `Client-ID`, `Content-Type` and — when the application declares
  one — `Application-Type`, plus `X-Request-Id`, `User-Agent`, `X-Forwarded-For` and
  `X-Real-IP` when given.
- Typed errors: `IsuwaConfigError`, `IsuwaOAuthError`, `IsuwaRateLimitError`,
  `IsuwaHttpError`, `IsuwaTimeoutError`, `IsuwaNetworkError`,
  `IsuwaTokenVerificationError`. The server's own message is carried unchanged.
- Per-request timeout (20 s by default, 15 s minimum, enforced on per-call overrides too)
  and a single token-refresh replay on HTTP 401.
- TypeScript sources with published type declarations, a dual ESM/CommonJS build, a test
  suite, ESLint, and a CI workflow across current Node releases.
- `verifyAccessToken()` with audience, issuer, scope and clock-tolerance options. The key
  set is cached with a TTL and refreshed on an unknown `kid`, so a rotated-out key stops
  verifying; `clearJwksCache()` drops it at once.

### Changed

- **Zero runtime dependencies.** `axios` and `jsonwebtoken` are gone; the SDK uses the
  platform `fetch` and `node:crypto`. Node 20 or newer is required.
- The default export is now `IsuwaClient`.
- The token cache now refreshes 60 seconds early (was 10) and treats a response without
  `expires_in` as short-lived instead of never-expiring.

### Removed

- `OAuthClient`, with `getToken`, `fetchWithAuth`, `verifyToken` and `jwkToPEM`. Their
  replacements are `IsuwaClient.getAccessToken`, `request`, `verifyAccessToken` and the
  `jwkToPem` export; [MIGRATION.md](./MIGRATION.md) maps them one by one.

### Fixed

- `verifyToken` threw on every call: it went through `jwt.decodePublicKey`, which does not
  exist in `jsonwebtoken@9`. Verification now runs on `node:crypto` and re-fetches the JWKS
  once on an unknown `kid`, so a key rotation still verifies.
- The JWT header was decoded as base64 rather than base64url.
- `getToken(true)` could return the in-flight promise of an earlier, unforced fetch — the
  stale token the caller had just been refused with.
- `package-lock.json` was pinned to 1.0.1 while `package.json` said 1.0.2, which broke
  `npm ci` in the publish workflow.

### Migration

This is a breaking release: see [MIGRATION.md](./MIGRATION.md) for the method-by-method
mapping from 1.x.

## [1.0.2] - 2025

- Initial published SDK: `client_credentials` token fetch with caching, `fetchWithAuth`
  with a 401 replay, and a JWKS `verifyToken` that never worked.
