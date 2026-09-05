import { DEFAULT_SCOPE } from './codes.js';
import { IsuwaConfigError, IsuwaHttpError } from './errors.js';
import { raiseForStatus, send } from './http.js';
import { JwksVerifier } from './jwks.js';
import { TokenManager } from './token.js';
import type {
  AccessTokenClaims,
  CallOptions,
  FetchLike,
  IsuwaClientOptions,
  VerifyOptions,
} from './types.js';

/**
 * The floor for `timeoutMs`. A shorter timeout turns an ordinary refusal into a timeout
 * and leaves the user with no message.
 */
export const MIN_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export interface RawRequestOptions extends CallOptions {
  /** Defaults to `POST` when a body is given and `GET` when it is not. */
  method?: string;
  /** Serialized as JSON when present. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Overrides the client's `retryOn401` for this call. */
  retryOn401?: boolean;
}

/**
 * OAuth2 client for an ISUWA IAM application.
 *
 * It holds the credentials, keeps one access token for the process, sends the headers
 * every application route expects, and verifies tokens against the published JWKS. It
 * knows nothing about any one connector: `request()` reaches whichever route your
 * application is registered for.
 *
 * @example
 * ```ts
 * const iam = new IsuwaClient({
 *   baseUrl: process.env.ISUWA_BASE_URL!,
 *   clientId: process.env.ISUWA_CLIENT_ID!,
 *   clientSecret: process.env.ISUWA_CLIENT_SECRET!,
 * });
 *
 * const token = await iam.getAccessToken();
 * ```
 */
export class IsuwaClient {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly scope: string;
  readonly applicationType: string | undefined;
  readonly timeoutMs: number;

  private readonly retryOn401: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly tokens: TokenManager;
  private readonly jwks: JwksVerifier;

  constructor(options: IsuwaClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.clientId = required(options.clientId, 'clientId');
    this.scope = options.scope ?? DEFAULT_SCOPE;
    this.applicationType = options.applicationType;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryOn401 = options.retryOn401 ?? true;

    const clientSecret = required(options.clientSecret, 'clientSecret');

    if (this.scope.trim() === '') {
      // A token minted without a scope is refused by the routes that need one, a call
      // later. Failing here points at the real cause.
      throw new IsuwaConfigError(
        `scope must not be empty; the connector endpoints require '${DEFAULT_SCOPE}'`,
      );
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < MIN_TIMEOUT_MS) {
      throw new IsuwaConfigError(`timeoutMs must be at least ${MIN_TIMEOUT_MS}`);
    }

    if (!options.fetch && typeof (globalThis as { fetch?: unknown }).fetch !== 'function') {
      throw new IsuwaConfigError(
        'no global fetch is available; upgrade to Node 20 or pass options.fetch',
      );
    }
    // Resolved per call rather than captured here, so a test harness that installs its
    // interceptor over globalThis.fetch after construction still sees the traffic.
    this.fetchImpl =
      options.fetch ??
      ((input, init) => {
        const globalFetch = (globalThis as { fetch?: unknown }).fetch;
        if (typeof globalFetch !== 'function') {
          throw new IsuwaConfigError('no global fetch is available');
        }
        return (globalFetch as FetchLike)(input, init);
      });

    this.tokens = new TokenManager({
      baseUrl: this.baseUrl,
      clientId: this.clientId,
      clientSecret,
      scope: this.scope,
      timeoutMs: this.timeoutMs,
      refreshSkewMs: options.tokenRefreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS,
      fetchImpl: this.fetchImpl,
    });
    this.jwks = new JwksVerifier({
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  /**
   * Returns a cached access token, fetching one when the cache is empty or stale. A
   * cached token is replaced shortly before it expires.
   */
  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    return this.tokens.get(options.forceRefresh ?? false);
  }

  /** Drops the cached access token, including one a fetch in flight is about to produce. */
  clearTokenCache(): void {
    this.tokens.clear();
  }

  /**
   * Drops the cached signing keys. The next verification fetches them again; use it when
   * a key is rotated out early and must stop verifying tokens at once.
   */
  clearJwksCache(): void {
    this.jwks.clear();
  }

  /**
   * Verifies an access token against the published JWKS. Only a resource server that
   * receives a token needs this.
   */
  async verifyAccessToken(token: string, options?: VerifyOptions): Promise<AccessTokenClaims> {
    return this.jwks.verify(token, options);
  }

  /**
   * Calls a path on the same server with the application's headers and the cached
   * token, and returns the parsed body. A non-2xx status raises a typed error.
   */
  async request<T = unknown>(path: string, options: RawRequestOptions = {}): Promise<T> {
    const url = this.resolve(path);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    const retryOn401 = options.retryOn401 ?? this.retryOn401;

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS) {
      throw new IsuwaConfigError(`timeoutMs must be at least ${MIN_TIMEOUT_MS}`);
    }

    let token = await this.tokens.get(false);
    let result = await send<T>({
      fetchImpl: this.fetchImpl,
      url,
      method,
      headers: this.headers(token, options),
      ...(body === undefined ? {} : { body }),
      timeoutMs,
    });

    // A 401 is about the token, not about what the call carries, so replaying it once
    // is safe.
    if (result.status === 401 && retryOn401) {
      token = await this.tokens.get(true);
      result = await send<T>({
        fetchImpl: this.fetchImpl,
        url,
        method,
        headers: this.headers(token, options),
        ...(body === undefined ? {} : { body }),
        timeoutMs,
      });
    }

    if (result.status < 200 || result.status >= 300) raiseForStatus(result);
    if (result.body === undefined && result.raw.trim() !== '') {
      // A 2xx whose body is not JSON is usually an intercepting proxy, not the server.
      throw new IsuwaHttpError(`${url} answered with a body that is not JSON`, {
        status: result.status,
        body: result.raw,
        requestId: result.requestId,
        url,
      });
    }
    return result.body as T;
  }

  /**
   * Resolves a path against `baseUrl`, keeping any path prefix the base URL carries so
   * that a deployment behind one is reached the same way the token endpoint is. An
   * absolute URL is accepted only on the same origin: the bearer token belongs to this
   * server and must not be sent anywhere else.
   */
  private resolve(path: string): string {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(path);
    let url: URL;
    try {
      url = new URL(absolute ? path : `${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    } catch {
      throw new IsuwaConfigError(`'${path}' is not a valid path or URL`);
    }
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new IsuwaConfigError(
        `'${path}' points at another origin; this client only calls ${this.baseUrl}`,
      );
    }
    return url.toString();
  }

  private headers(token: string, options: RawRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Client-ID': this.clientId,
      Accept: 'application/json',
    };

    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    if (this.applicationType) headers['Application-Type'] = this.applicationType;
    if (options.requestId) headers['X-Request-Id'] = options.requestId;
    if (options.userAgent) headers['User-Agent'] = options.userAgent;
    if (options.forwardedFor) {
      headers['X-Forwarded-For'] = options.forwardedFor;
      headers['X-Real-IP'] = options.forwardedFor;
    }

    return options.headers ? { ...headers, ...options.headers } : headers;
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = required(value, 'baseUrl').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new IsuwaConfigError(`baseUrl must be an absolute URL, got '${value}'`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IsuwaConfigError(`baseUrl must be http or https, got '${parsed.protocol}'`);
  }
  return trimmed;
}

function required(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IsuwaConfigError(`${name} is required`);
  }
  return value;
}
