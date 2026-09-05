import { PATHS } from './codes.js';
import { IsuwaOAuthError } from './errors.js';
import { send, serverMessage } from './http.js';
import type { FetchLike, TokenResponse } from './types.js';

export interface TokenManagerOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  timeoutMs: number;
  refreshSkewMs: number;
  fetchImpl: FetchLike;
}

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token must not be handed out any more. */
  usableUntil: number;
  scope: string | undefined;
}

/**
 * Holds one application's access token: fetched once per lifetime rather than once per
 * sign-in, with concurrent callers sharing a single in-flight request.
 */
export class TokenManager {
  private readonly options: TokenManagerOptions;
  private cached: CachedToken | null = null;
  private inFlight: Promise<CachedToken> | null = null;
  private inFlightIsFresh = false;
  /** Bumped by `clear()`, so a fetch started before it cannot repopulate the cache. */
  private generation = 0;

  constructor(options: TokenManagerOptions) {
    this.options = options;
  }

  /**
   * Returns a usable access token, fetching one when the cache is empty or stale.
   *
   * `force` discards the cached token. It never adopts an in-flight request that
   * started before the caller learned the token was rejected, because that request can
   * only produce the same rejected token.
   */
  async get(force = false): Promise<string> {
    const generation = this.generation;

    if (!force) {
      const cached = this.cached;
      if (cached && Date.now() < cached.usableUntil) return cached.accessToken;
      const joined = this.inFlight;
      if (joined) {
        const token = await joined;
        // A clear() while we waited means this is the token we were told to discard, so
        // it is not handed out; the fetch below replaces it.
        if (this.generation === generation) return token.accessToken;
      }
    } else {
      this.cached = null;
      const joined = this.inFlightIsFresh ? this.inFlight : null;
      if (joined) {
        const token = await joined;
        if (this.generation === generation) return token.accessToken;
      }
    }

    return this.fetchAndCache(force);
  }

  private async fetchAndCache(force: boolean): Promise<string> {
    const request = this.fetchToken();
    const generation = this.generation;
    this.inFlight = request;
    this.inFlightIsFresh = force;
    try {
      const token = await request;
      // Only the request that is still the current one may write the cache. A slower
      // fetch that a forced refresh or a clear() has superseded would otherwise put the
      // older token back, and every later call would carry the token that was refused.
      if (this.inFlight === request && this.generation === generation) this.cached = token;
      return token.accessToken;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
        this.inFlightIsFresh = false;
      }
    }
  }

  /**
   * Drops the cached token, including one a fetch already in flight is about to produce.
   * The next `get()` fetches a new one.
   */
  clear(): void {
    this.cached = null;
    this.generation += 1;
    this.inFlight = null;
    this.inFlightIsFresh = false;
  }

  private async fetchToken(): Promise<CachedToken> {
    const url = `${this.options.baseUrl}${PATHS.token}`;
    const result = await send<TokenResponse & { error?: string }>({
      fetchImpl: this.options.fetchImpl,
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        scope: this.options.scope,
      }).toString(),
      timeoutMs: this.options.timeoutMs,
    });

    if (result.status < 200 || result.status >= 300) {
      const message = serverMessage(result) ?? `HTTP ${result.status} from ${url}`;
      throw new IsuwaOAuthError(`token request refused: ${message}`, {
        status: result.status,
        body: result.body ?? result.raw,
        requestId: result.requestId,
        url,
        error: typeof result.body?.error === 'string' ? result.body.error : 'invalid_response',
      });
    }

    const body = result.body;
    if (!body || typeof body.access_token !== 'string' || body.access_token === '') {
      throw new IsuwaOAuthError('token response carried no access_token', {
        status: result.status,
        body: result.body ?? result.raw,
        requestId: result.requestId,
        url,
        error: 'invalid_response',
      });
    }

    // A server that omits expires_in is treated as short-lived rather than as
    // never-expiring, so a missing field cannot pin a stale token in the cache.
    const lifetimeSeconds =
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
        ? body.expires_in
        : 60;
    const skew = Math.min(this.options.refreshSkewMs, (lifetimeSeconds * 1000) / 2);

    return {
      accessToken: body.access_token,
      usableUntil: Date.now() + lifetimeSeconds * 1000 - skew,
      scope: body.scope,
    };
  }
}
