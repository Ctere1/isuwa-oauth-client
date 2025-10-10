import jwt from 'jsonwebtoken';
import axios from 'axios';

/**
 * ISUWA OAuth2 Client SDK
 * Supports client_credentials grant, JWKS verification, and auto-refresh
 */
export default class OAuthClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.scope = config.scope || 'app:read';

    // internal caches
    this.tokenCache = null;
    this.jwksCache = null;
    this.refreshing = null;
  }

  /**
   * Get (or refresh) access token
   */
  async getToken(force = false) {
    // if we have a valid token in cache
    if (!force && this.tokenCache && Date.now() < this.tokenCache.expiry) {
      return this.tokenCache.access_token;
    }

    // prevent multiple refresh calls in parallel
    if (this.refreshing) {
      return this.refreshing;
    }

    this.refreshing = this._fetchToken()
      .then((token) => {
        this.refreshing = null;
        return token;
      })
      .catch((err) => {
        this.refreshing = null;
        throw err;
      });

    return this.refreshing;
  }

  /**
   * Private method: actually fetch a new token
   */
  async _fetchToken() {
    const tokenUrl = `${this.baseUrl}/api/v1/oauth/token`;
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const res = await axios.post(
      tokenUrl,
      new URLSearchParams({
        grant_type: 'client_credentials',
        scope: this.scope,
      }),
      {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const data = res.data;
    const expiry = Date.now() + data.expires_in * 1000 - 10_000; // refresh 10s early
    this.tokenCache = { ...data, expiry };

    return data.access_token;
  }

  /**
   * Auto refresh on 401
   */
  async fetchWithAuth(url, options = {}) {
    let token = await this.getToken();
    try {
      const res = await axios({
        url,
        method: options.method || 'GET',
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`,
        },
        data: options.body || undefined,
      });
      return res;
    } catch (err) {
      // auto-refresh logic
      if (err.response && err.response.status === 401) {
        console.warn('[OAuthClient] Token expired, refreshing...');
        token = await this.getToken(true); // force refresh
        const retry = await axios({
          url,
          method: options.method || 'GET',
          headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${token}`,
          },
          data: options.body || undefined,
        });
        return retry;
      }
      throw err;
    }
  }

  /**
   * Verify token via JWKS endpoint (optional)
   */
  async verifyToken(token) {
    if (!token) throw new Error('Missing token');

    const decodedHeader = JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString());
    const kid = decodedHeader.kid;
    if (!kid) throw new Error('Token missing kid');

    if (!this.jwksCache) {
      const res = await axios.get(`${this.baseUrl}/api/v1/oauth/jwks.json`);
      this.jwksCache = res.data.keys;
    }

    const jwk = this.jwksCache.find((k) => k.kid === kid);
    if (!jwk) throw new Error(`No matching JWK for kid: ${kid}`);

    const pubKey = this.jwkToPEM(jwk);
    const verified = jwt.verify(token, pubKey, { algorithms: ['RS256'] });
    return verified;
  }

  /**
   * Convert RSA JWK → PEM
   */
  jwkToPEM(jwk) {
    const { n, e } = jwk;
    const pub = {
      kty: 'RSA',
      n: Buffer.from(n, 'base64'),
      e: Buffer.from(e, 'base64'),
    };
    // simple PEM conversion for jwt.verify
    const pubKey = jwt.decodePublicKey({ kty: 'RSA', n, e });
    return pubKey;
  }
}
