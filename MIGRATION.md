# Migration guide

## 1.x → 2.0

2.0 is a rewrite of the same idea: an OAuth2 client for ISUWA IAM. `OAuthClient` becomes
`IsuwaClient`, `axios` and `jsonwebtoken` are gone, and Node 20 or newer is required.

The upgrade is mechanical: construct `IsuwaClient` with the same three values and rename
the calls.

### Method mapping

| 1.x | 2.0 |
| --- | --- |
| `new OAuthClient({ baseUrl, clientId, clientSecret, scope })` | `new IsuwaClient({ baseUrl, clientId, clientSecret, scope })` |
| `getToken()` | `getAccessToken()` |
| `getToken(true)` | `getAccessToken({ forceRefresh: true })` |
| `verifyToken(token)` | `verifyAccessToken(token, options?)` |
| `jwkToPEM(jwk)` | `jwkToPem(jwk)`, a named export rather than a method |
| `fetchWithAuth(url, { method, headers, body })` | `request(path, { method, headers, body })` |

### Before

```js
import OAuthClient from '@cemiltan/isuwa-oauth-client';

const oauth = new OAuthClient({ baseUrl, clientId, clientSecret, scope: 'app:read' });

const token = await oauth.getToken();
const res = await oauth.fetchWithAuth(`${baseUrl}/api/v1/...`, {
  method: 'POST',
  headers: { 'Client-ID': clientId },
  body: JSON.stringify(payload),
});
const body = res.data;
```

### After

```js
import { IsuwaClient } from '@cemiltan/isuwa-oauth-client';

const iam = new IsuwaClient({ baseUrl, clientId, clientSecret });

const token = await iam.getAccessToken();
const body = await iam.request('/api/v1/...', { body: payload, requestId });
```

The headers, the token refresh and the error mapping are the SDK's job now, not yours.

### What else changed

- **`request()` returns the parsed body**, not an axios response. There is no `res.data`
  wrapper, no `config`, and no interceptors. A non-2xx status throws a typed error whose
  `status`, `body` and `requestId` carry what you used to read off `error.response`.
- **`request()` takes a path**, resolved against `baseUrl` and keeping any path prefix it
  carries. An absolute URL works only on the same origin: the bearer token belongs to that
  server and is not sent elsewhere. The method defaults to `GET` without a body and `POST`
  with one.
- **Requests now time out** after 20 seconds by default, and `timeoutMs` cannot be set
  below 15 000. 1.x had no timeout at all, so a stalled call could pin a request forever.
- **Errors are typed.** Catch `IsuwaOAuthError`, `IsuwaRateLimitError`, `IsuwaHttpError`,
  `IsuwaTimeoutError`, `IsuwaNetworkError` or their shared base `IsuwaError` instead of
  inspecting `err.response.status`.
- **The default export is now `IsuwaClient`.** `import Client from '@cemiltan/isuwa-oauth-client'`
  still resolves, but the object it gives you has `getAccessToken`, not `getToken`, so a
  call site that was not updated fails loudly rather than silently.
- **`applicationType` is an option.** The client sends the header only when the
  application declares one, so the same client works whichever type it is registered as.

### Bugs this fixes

If your integration worked around any of these, you can drop the workaround:

- `verifyToken()` threw on every call. It went through `jwt.decodePublicKey`, which does
  not exist in `jsonwebtoken@9`. Verification now runs on `node:crypto` and re-fetches the
  key set once on an unknown `kid`, so a key rotation still verifies.
- The JWT header was decoded as base64 rather than base64url.
- `getToken(true)` could hand back the in-flight promise of an earlier, unforced fetch —
  the same token the server had just refused.
- A token response without `expires_in` produced a cache entry that was never valid, so
  every call refetched.
