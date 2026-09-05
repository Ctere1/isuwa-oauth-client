/**
 * Errors this SDK throws.
 *
 * A refused sign-in is NOT an error: `passwordAuth` and `otpChallenge` return the
 * decision. These classes cover the transport and the protocol only.
 */

export class IsuwaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** A client option is missing or cannot work against this server. Thrown before any I/O. */
export class IsuwaConfigError extends IsuwaError {}

/** The request never produced an HTTP response (DNS, TLS, connection reset). */
export class IsuwaNetworkError extends IsuwaError {}

/** The request exceeded `timeoutMs` and was aborted. */
export class IsuwaTimeoutError extends IsuwaError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(message, options);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The server answered with a status this SDK cannot turn into a decision.
 *
 * `message` carries the server's own text unchanged. Log it rather than replacing it
 * with a generic one, and keep it out of what you show the end user.
 */
export class IsuwaHttpError extends IsuwaError {
  readonly status: number;
  readonly body: unknown;
  readonly requestId: string | undefined;
  readonly url: string;

  constructor(
    message: string,
    init: { status: number; body: unknown; requestId?: string | undefined; url: string },
  ) {
    super(message);
    this.status = init.status;
    this.body = init.body;
    this.requestId = init.requestId;
    this.url = init.url;
  }
}

/** The token request was refused. `error` is the OAuth2 error code that came back. */
export class IsuwaOAuthError extends IsuwaHttpError {
  readonly error: string;

  constructor(
    message: string,
    init: {
      status: number;
      body: unknown;
      requestId?: string | undefined;
      url: string;
      error: string;
    },
  ) {
    super(message, init);
    this.error = init.error;
  }
}

/** The request was rate-limited (HTTP 429). */
export class IsuwaRateLimitError extends IsuwaHttpError {
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    init: {
      status: number;
      body: unknown;
      requestId?: string | undefined;
      url: string;
      retryAfterSeconds?: number | undefined;
    },
  ) {
    super(message, init);
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** An access token failed signature or claim verification. */
export class IsuwaTokenVerificationError extends IsuwaError {}
