# isuwa-oauth-client

[![npm version](https://img.shields.io/npm/v/@cemiltan/isuwa-oauth-client.svg)](https://www.npmjs.com/package/@cemiltan/isuwa-oauth-client)
[![GitHub stars](https://img.shields.io/github/stars/Ctere1/isuwa-oauth-client.svg)](https://github.com/Ctere1/isuwa-oauth-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A lightweight JavaScript/TypeScript SDK for ISUWA IAM OAuth2.

Supports:
- `client_credentials` grant flow
- Token caching and refresh
- Optional JWT verification using the JWKS endpoint
- Authenticated requests with the headers an application route expects
- No runtime dependencies, ESM and CommonJS, typed

---

## 🚀 Installation

```bash
npm install @cemiltan/isuwa-oauth-client
```

Requires Node 20 or newer. Your IAM administrator gives you the base URL, the client id
and the client secret.

## Usage Example

```javascript
import { IsuwaClient } from '@cemiltan/isuwa-oauth-client';

const iam = new IsuwaClient({
  baseUrl: process.env.ISUWA_BASE_URL,
  clientId: process.env.ISUWA_CLIENT_ID,
  clientSecret: process.env.ISUWA_CLIENT_SECRET,
  applicationType: process.env.ISUWA_APPLICATION_TYPE, // optional
});

// Get an access token — cached and refreshed for you
const token = await iam.getAccessToken();

// (Optional) Verify a token against the JWKS endpoint
const claims = await iam.verifyAccessToken(token, { requiredScopes: ['app:read'] });

// Call an application route with that token
const data = await iam.request('/api/v1/...', { body: { … }, requestId });
```

`request()` sends the bearer token, `Client-ID`, `Content-Type` and, when the application
declares one, `Application-Type`. It refreshes the token and replays the call once on a
401, and turns any other non-2xx status into a typed error.

## API

```javascript
new IsuwaClient({ baseUrl, clientId, clientSecret, scope?, timeoutMs?, retryOn401?,
                  applicationType?, tokenRefreshSkewMs?, fetch? })

await iam.getAccessToken({ forceRefresh? })
await iam.verifyAccessToken(token, { audience?, issuer?, requiredScopes?, clockToleranceSeconds? })
await iam.request(path, { method?, body?, headers?, requestId?, userAgent?, forwardedFor? })
iam.clearTokenCache()
iam.clearJwksCache()
```

Errors: `IsuwaConfigError`, `IsuwaOAuthError`, `IsuwaRateLimitError`, `IsuwaHttpError`,
`IsuwaTimeoutError`, `IsuwaNetworkError`, `IsuwaTokenVerificationError`. A server message
is carried through unchanged — log it, rather than showing it to the end user.

Notes:

- Keep one client per process: it caches the access token and shares one refresh between
  concurrent callers.
- `request()` only calls `baseUrl`'s own origin, so the token cannot leave that server,
  and it keeps any path prefix the base URL carries. It sends `GET` without a body and
  `POST` with one, unless you pass `method`.
- Pass a `requestId` to correlate the calls that belong to one operation.
- Requests time out after 20 seconds by default; the minimum is 15 000 ms.

## Migration

Upgrading from 1.x replaces `OAuthClient` with `IsuwaClient`. See
[MIGRATION.md](./MIGRATION.md) and the [changelog](./CHANGELOG.md).

## License

MIT © Cemil Tan
