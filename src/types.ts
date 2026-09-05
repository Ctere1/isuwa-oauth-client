/** The subset of `fetch` this SDK uses. Pass your own to add proxying or mTLS. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface IsuwaClientOptions {
  /**
   * The server's base URL, scheme and port included. A trailing slash is trimmed. Your
   * IAM administrator provides it.
   */
  baseUrl: string;

  /** The application's client id. Also sent as the `Client-ID` header. */
  clientId: string;

  /** The application's client secret. */
  clientSecret: string;

  /**
   * OAuth2 scope. The connector endpoints require it, so an empty value is rejected.
   *
   * @default 'app:read'
   */
  scope?: string;

  /**
   * Per-request timeout. Values under 15 000 ms are rejected, because they turn an
   * ordinary refusal into a timeout.
   *
   * @default 20000
   */
  timeoutMs?: number;

  /**
   * How long before expiry a cached token is replaced.
   *
   * @default 60000
   */
  tokenRefreshSkewMs?: number;

  /**
   * Fetch a fresh token and replay the call once on a 401, so an expired token does not
   * surface as a failed sign-in.
   *
   * @default true
   */
  retryOn401?: boolean;

  /**
   * The `Application-Type` this application is registered as. Connector routes require
   * it; the header is omitted when it is unset, and a per-call `headers` entry overrides
   * it.
   */
  applicationType?: string;

  /** Replacement for the global `fetch`, mainly for tests and custom agents. */
  fetch?: FetchLike;
}

/** Extra per-call inputs. */
export interface CallOptions {
  /**
   * Correlation id for this request, sent as `X-Request-Id` and echoed back. Pass the
   * same value through the calls that belong to one sign-in so they can be traced
   * together.
   */
  requestId?: string;

  /**
   * The end user's `User-Agent`, forwarded verbatim. Some deployments compare it across
   * the calls of one sign-in, so send the same value throughout or leave it unset.
   */
  userAgent?: string;

  /**
   * The end user's IP, sent as `X-Forwarded-For` and `X-Real-IP`. Whether it is honoured
   * depends on the deployment; ask your IAM administrator before relying on it.
   */
  forwardedFor?: string;

  /** Overrides the client's `timeoutMs` for this call. */
  timeoutMs?: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

/** The claims an access token carries. */
export interface AccessTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  iat: number;
  nbf: number;
  exp: number;
  scope?: string;
  [claim: string]: unknown;
}

export interface VerifyOptions {
  /** Expected audience. @default 'isuwa-iam-application' */
  audience?: string;
  /** Expected issuer. Unchecked when omitted, since it varies per deployment. */
  issuer?: string;
  /** Scopes that must all be present. */
  requiredScopes?: string[];
  /** Clock tolerance for `exp` and `nbf`, in seconds. @default 60 */
  clockToleranceSeconds?: number;
}
