import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import type { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { TOKEN_AUDIENCE } from '../src/codes.js';
import { IsuwaTokenVerificationError } from '../src/errors.js';
import { JwksVerifier, jwkToPem } from '../src/jwks.js';
import type { Jwk } from '../src/jwks.js';
import { stubFetch } from './helpers.js';

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } as Jwk;
  return { privateKey, jwk };
}

function issue(
  privateKey: ReturnType<typeof createPrivateKey>,
  kid: string,
  claims: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: 'RS256', typ: 'JWT', kid });
  const payload = base64url({
    iss: 'https://iam.example.com',
    aud: TOKEN_AUDIENCE,
    sub: 'client-1',
    client_id: 'client-1',
    iat: now,
    nbf: now,
    exp: now + 1800,
    scope: 'app:read',
    ...claims,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`, 'ascii'), privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function verifier(
  fetchImpl: ReturnType<typeof stubFetch>['fetch'],
  options: { cacheTtlMs?: number; refreshIntervalMs?: number } = {},
) {
  return new JwksVerifier({
    baseUrl: 'https://iam.example.com',
    timeoutMs: 20_000,
    fetchImpl,
    ...options,
  });
}

describe('JwksVerifier', () => {
  it('verifies a token signed by a published key', async () => {
    const { privateKey, jwk } = keyPair('kid-1');
    const stub = stubFetch([{ body: { keys: [jwk] } }]);

    const claims = await verifier(stub.fetch).verify(issue(privateKey, 'kid-1'));

    expect(claims.client_id).toBe('client-1');
    expect(claims.scope).toBe('app:read');
    expect(stub.calls[0]!.url).toBe('https://iam.example.com/api/v1/oauth/jwks.json');
  });

  it('caches the key set between verifications', async () => {
    const { privateKey, jwk } = keyPair('kid-1');
    const stub = stubFetch([{ body: { keys: [jwk] } }]);
    const jwks = verifier(stub.fetch);

    await jwks.verify(issue(privateKey, 'kid-1'));
    await jwks.verify(issue(privateKey, 'kid-1'));

    expect(stub.calls).toHaveLength(1);
  });

  it('refetches the key set once when the kid is unknown, so a rotation still verifies', async () => {
    const first = keyPair('kid-1');
    const second = keyPair('kid-2');
    const stub = stubFetch([{ body: { keys: [first.jwk] } }, { body: { keys: [second.jwk] } }]);
    // refreshIntervalMs: 0 so the rotation is picked up inside one test tick; in
    // production the default bounds these refreshes to one per second.
    const jwks = verifier(stub.fetch, { refreshIntervalMs: 0 });

    await jwks.verify(issue(first.privateKey, 'kid-1'));
    const claims = await jwks.verify(issue(second.privateKey, 'kid-2'));

    expect(claims.sub).toBe('client-1');
    expect(stub.calls).toHaveLength(2);
  });

  it('refetches the key set once it has expired, so a rotated-out key stops verifying', async () => {
    const { privateKey, jwk } = keyPair('kid-1');
    const stub = stubFetch([{ body: { keys: [jwk] } }, { body: { keys: [] } }]);
    const jwks = verifier(stub.fetch, { cacheTtlMs: 0 });

    await jwks.verify(issue(privateKey, 'kid-1'));
    await expect(jwks.verify(issue(privateKey, 'kid-1'))).rejects.toThrow(/no signing key/);
    expect(stub.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not fetch the key set again for every unknown kid', async () => {
    const { privateKey, jwk } = keyPair('kid-1');
    const stub = stubFetch([{ body: { keys: [jwk] } }]);
    const jwks = verifier(stub.fetch, { refreshIntervalMs: 60_000 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(jwks.verify(issue(privateKey, `bogus-${attempt}`))).rejects.toThrow(
        /no signing key/,
      );
    }

    expect(stub.calls).toHaveLength(1);
  });

  it('ignores a key that is not an RSA signing key, even when the kid matches', async () => {
    const { privateKey, jwk } = keyPair('kid-1');
    const encryptionKey = { ...jwk, use: 'enc' };
    const stub = stubFetch([{ body: { keys: [encryptionKey] } }]);

    await expect(verifier(stub.fetch).verify(issue(privateKey, 'kid-1'))).rejects.toThrow(
      /no signing key/,
    );
  });

  it('refuses a token that carries no exp claim', async () => {
    const { privateKey, jwk } = keyPair('kid-1');
    const stub = stubFetch([{ body: { keys: [jwk] } }]);
    const everlasting = issue(privateKey, 'kid-1', { exp: undefined });

    await expect(verifier(stub.fetch).verify(everlasting)).rejects.toThrow(/no exp/);
  });

  it('refuses a token whose signature does not match', async () => {
    const signer = keyPair('kid-1');
    const impostor = keyPair('kid-1');
    const stub = stubFetch([{ body: { keys: [impostor.jwk] } }]);

    await expect(verifier(stub.fetch).verify(issue(signer.privateKey, 'kid-1'))).rejects.toThrow(
      /signature/,
    );
  });

  it('refuses an expired token', async () => {
    const { privateKey, jwk } = keyPair('kid-1');
    const stub = stubFetch([{ body: { keys: [jwk] } }]);
    const expired = issue(privateKey, 'kid-1', { exp: Math.floor(Date.now() / 1000) - 3600 });

    await expect(verifier(stub.fetch).verify(expired)).rejects.toThrow(/expired/);
  });

  it('refuses a token minted for another audience', async () => {
    const { privateKey, jwk } = keyPair('kid-1');
    const stub = stubFetch([{ body: { keys: [jwk] } }]);
    const foreign = issue(privateKey, 'kid-1', { aud: 'someone-else' });

    await expect(verifier(stub.fetch).verify(foreign)).rejects.toThrow(/audience/);
  });

  it('refuses a token that is missing a required scope', async () => {
    const { privateKey, jwk } = keyPair('kid-1');
    const stub = stubFetch([{ body: { keys: [jwk] } }]);
    const token = issue(privateKey, 'kid-1', { scope: '' });

    await expect(
      verifier(stub.fetch).verify(token, { requiredScopes: ['app:read'] }),
    ).rejects.toThrow(/scope/);
  });

  it('refuses anything that is not a three-part JWS', async () => {
    const stub = stubFetch([{ body: { keys: [] } }]);

    await expect(verifier(stub.fetch).verify('not-a-token')).rejects.toBeInstanceOf(
      IsuwaTokenVerificationError,
    );
  });

  it('converts a JWK to a PEM public key', () => {
    const { jwk } = keyPair('kid-1');
    const pem = jwkToPem(jwk);

    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(createPublicKey(pem).asymmetricKeyType).toBe('rsa');
  });
});
