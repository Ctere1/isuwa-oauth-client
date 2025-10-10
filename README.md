# @isuwa/oauth-client

[![npm version](https://img.shields.io/npm/v/@isuwa/oauth-client.svg)](https://www.npmjs.com/package/@isuwa/oauth-client)
[![GitHub stars](https://img.shields.io/github/stars/Ctere1/isuwa-oauth-client.svg)](https://github.com/Ctere1/isuwa-oauth-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A lightweight JavaScript SDK for interacting with the ISUWA IAM server.

Supports:
- `client_credentials` grant flow
- Optional JWT verification using JWKS endpoint
- Token caching
- Easy authenticated API requests

---

## 🚀 Installation

```bash
npm install @isuwa/oauth-client
```

## Usage Example

```javascript
import OAuthClient from '@isuwa/oauth-client';

const oauth = new OAuthClient({
  baseUrl: 'https://auth.yourdomain.com',
  clientId: 'my-client-id',
  clientSecret: 'my-client-secret',
  scope: 'app:read'
});

(async () => {
  // Get access token
  const token = await oauth.getToken();
  console.log('Access Token:', token);

  // (Optional) Verify token using JWKS
  const claims = await oauth.verifyToken(token);
  console.log('Token Claims:', claims);

  // Use token in authenticated API call
  const res = await oauth.fetchWithAuth('https://api.yourdomain.com/data');
  console.log('API Response:', res.data);
})();
```