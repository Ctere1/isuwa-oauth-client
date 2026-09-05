import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { PATHS, TOKEN_AUDIENCE } from './codes.js';
import { IsuwaTokenVerificationError } from './errors.js';
import { raiseForStatus, send } from './http.js';
import type { AccessTokenClaims, FetchLike, VerifyOptions } from './types.js';

export interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
  [field: string]: unknown;
}

export interface JwksVerifierOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
  /** How long a fetched key set is trusted. @default 600000 */
  cacheTtlMs?: number;
  /** Shortest gap between two fetches provoked by an unknown kid. @default 1000 */
  refreshIntervalMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_REFRESH_INTERVAL_MS = 1_000;

/**
 * Verifies access tokens against the published JWKS.
 *
 * An application that only calls the connector does not need this. It is here for a
 * resource server that receives a token and wants to check it without calling back.
 */
export class JwksVerifier {
  private readonly options: JwksVerifierOptions;
  private keys: Jwk[] | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<Jwk[]> | null = null;
  /** Bumped by `clear()`, so a load started before it cannot repopulate the cache. */
  private generation = 0;

  constructor(options: JwksVerifierOptions) {
    this.options = options;
  }

  /** Drops the cached JWKS. The next verification fetches it again. */
  clear(): void {
    this.keys = null;
    this.fetchedAt = 0;
    this.inFlight = null;
    this.generation += 1;
  }

  /**
   * Verifies a token's signature and claims.
   *
   * Throws {@link IsuwaTokenVerificationError} when the token itself does not hold up,
   * and the transport errors of a request (`IsuwaHttpError`, `IsuwaRateLimitError`,
   * `IsuwaTimeoutError`, `IsuwaNetworkError`) when the key set cannot be fetched.
   */
  async verify(token: string, options: VerifyOptions = {}): Promise<AccessTokenClaims> {
    if (typeof token !== 'string' || token === '') {
      throw new IsuwaTokenVerificationError('no token was given');
    }

    const segments = token.split('.');
    if (segments.length !== 3) {
      throw new IsuwaTokenVerificationError('token is not a three-part JWS');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];

    const header = decodeSegment<{ alg?: string; kid?: string }>(encodedHeader, 'header');
    if (header.alg !== 'RS256') {
      throw new IsuwaTokenVerificationError(
        `unexpected signing algorithm '${header.alg ?? 'none'}', expected RS256`,
      );
    }
    if (!header.kid) {
      throw new IsuwaTokenVerificationError('token header carries no kid');
    }

    // A key the cache does not know is the normal shape of a rotation, so the set is
    // fetched once more before the token is called unverifiable.
    let jwk = await this.findKey(header.kid, false);
    if (!jwk) jwk = await this.findKey(header.kid, true);
    if (!jwk) {
      throw new IsuwaTokenVerificationError(`no signing key matches kid '${header.kid}'`);
    }

    const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii');
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (!verifySignature('RSA-SHA256', signingInput, toKeyObject(jwk), signature)) {
      throw new IsuwaTokenVerificationError('token signature does not check out');
    }

    const claims = decodeSegment<AccessTokenClaims>(encodedPayload, 'payload');
    assertClaims(claims, options);
    return claims;
  }

  private async findKey(kid: string, refresh: boolean): Promise<Jwk | undefined> {
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const interval = this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    const age = Date.now() - this.fetchedAt;

    // A key that was rotated out must stop verifying tokens, so the set expires rather
    // than living for the lifetime of the process. A refresh provoked by an unknown kid
    // is rate-limited, so a stream of tokens carrying invented kids cannot turn into a
    // stream of outbound requests.
    // The comparisons are inclusive so that a zero TTL or interval means "always",
    // rather than "only once the clock has ticked past the same millisecond".
    const stale = this.keys === null || age >= ttl;
    if (stale || (refresh && age >= interval)) {
      const generation = this.generation;
      let keys = await this.loadKeys();
      // A clear() while the load was running means these keys are the ones the caller
      // asked to drop, so they are fetched again rather than trusted for a full TTL.
      if (this.generation !== generation) keys = await this.loadKeys();
      return keys.find((key) => key.kid === kid && isRsaSigningKey(key));
    }
    return this.keys?.find((key) => key.kid === kid && isRsaSigningKey(key));
  }

  /** Collapses concurrent loads into one request, the way the token fetch does. */
  private async loadKeys(): Promise<Jwk[]> {
    const joined = this.inFlight;
    if (joined) return joined;

    const request = this.fetchKeys();
    const generation = this.generation;
    this.inFlight = request;
    try {
      const keys = await request;
      if (this.generation === generation) {
        this.keys = keys;
        this.fetchedAt = Date.now();
      }
      return keys;
    } finally {
      if (this.inFlight === request) this.inFlight = null;
    }
  }

  private async fetchKeys(): Promise<Jwk[]> {
    const url = `${this.options.baseUrl}${PATHS.jwks}`;
    const result = await send<{ keys?: Jwk[] }>({
      fetchImpl: this.options.fetchImpl,
      url,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: this.options.timeoutMs,
    });

    if (result.status < 200 || result.status >= 300) raiseForStatus(result);
    const keys = result.body?.keys;
    if (!Array.isArray(keys)) {
      throw new IsuwaTokenVerificationError(`${url} did not answer with a JWK set`);
    }
    return keys;
  }
}

/** RS256 verification needs an RSA key meant for signatures, not just a matching kid. */
function isRsaSigningKey(key: Jwk): boolean {
  return key.kty === 'RSA' && key.use !== 'enc';
}

/** Converts an RSA JWK into a PEM-encoded SPKI public key. */
export function jwkToPem(jwk: Jwk): string {
  return toKeyObject(jwk).export({ type: 'spki', format: 'pem' }).toString();
}

function toKeyObject(jwk: Jwk): KeyObject {
  try {
    return createPublicKey({ key: jwk as never, format: 'jwk' });
  } catch (cause) {
    throw new IsuwaTokenVerificationError(
      `signing key '${jwk.kid ?? 'unknown'}' could not be read: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

function assertClaims(claims: AccessTokenClaims, options: VerifyOptions): void {
  const tolerance = options.clockToleranceSeconds ?? 60;
  const now = Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== 'number') {
    throw new IsuwaTokenVerificationError('token carries no exp claim');
  }
  if (now > claims.exp + tolerance) {
    throw new IsuwaTokenVerificationError('token has expired');
  }
  if (typeof claims.nbf === 'number' && now + tolerance < claims.nbf) {
    throw new IsuwaTokenVerificationError('token is not valid yet');
  }

  const audience = options.audience ?? TOKEN_AUDIENCE;
  if (audience && !audienceMatches(claims.aud, audience)) {
    throw new IsuwaTokenVerificationError(`token was issued for a different audience`);
  }
  if (options.issuer && claims.iss !== options.issuer) {
    throw new IsuwaTokenVerificationError('token was issued by a different server');
  }

  if (options.requiredScopes?.length) {
    const granted = typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
    const missing = options.requiredScopes.filter((scope) => !granted.includes(scope));
    if (missing.length > 0) {
      throw new IsuwaTokenVerificationError(`token is missing scope: ${missing.join(', ')}`);
    }
  }
}

function audienceMatches(actual: unknown, expected: string): boolean {
  if (typeof actual === 'string') return actual === expected;
  if (Array.isArray(actual)) return actual.includes(expected);
  return false;
}

function decodeSegment<T>(segment: string, name: string): T {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
  } catch (cause) {
    throw new IsuwaTokenVerificationError(`token ${name} is not valid base64url JSON`, { cause });
  }
}
