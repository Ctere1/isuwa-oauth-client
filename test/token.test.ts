import { describe, expect, it } from 'vitest';

import { IsuwaOAuthError } from '../src/errors.js';
import { TokenManager } from '../src/token.js';
import { SECOND_TOKEN_REPLY, TOKEN_REPLY, stubFetch } from './helpers.js';

function manager(fetchImpl: ReturnType<typeof stubFetch>['fetch'], refreshSkewMs = 60_000) {
  return new TokenManager({
    baseUrl: 'https://iam.example.com',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    scope: 'app:read',
    timeoutMs: 20_000,
    refreshSkewMs,
    fetchImpl,
  });
}

describe('TokenManager', () => {
  it('posts the documented form body to the token endpoint', async () => {
    const stub = stubFetch([TOKEN_REPLY]);
    await manager(stub.fetch).get();

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.url).toBe('https://iam.example.com/api/v1/oauth/token');
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(call.body!))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      client_secret: 'secret-1',
      scope: 'app:read',
    });
  });

  it('serves the cached token until it nears expiry', async () => {
    const stub = stubFetch([TOKEN_REPLY]);
    const tokens = manager(stub.fetch);

    expect(await tokens.get()).toBe('access-token-1');
    expect(await tokens.get()).toBe('access-token-1');
    expect(stub.calls).toHaveLength(1);
  });

  it('collapses concurrent first calls into one request', async () => {
    const stub = stubFetch([TOKEN_REPLY]);
    const tokens = manager(stub.fetch);

    const results = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);

    expect(results).toEqual(['access-token-1', 'access-token-1', 'access-token-1']);
    expect(stub.calls).toHaveLength(1);
  });

  it('fetches a new token when forced, rather than returning the cached one', async () => {
    const stub = stubFetch([TOKEN_REPLY, SECOND_TOKEN_REPLY]);
    const tokens = manager(stub.fetch);

    expect(await tokens.get()).toBe('access-token-1');
    expect(await tokens.get(true)).toBe('access-token-2');
    expect(stub.calls).toHaveLength(2);
  });

  it('refetches once the refresh skew has eaten the lifetime', async () => {
    const stub = stubFetch([
      { body: { access_token: 'short', token_type: 'Bearer', expires_in: 1 } },
      SECOND_TOKEN_REPLY,
    ]);
    const tokens = manager(stub.fetch, 600); // half the lifetime is the cap

    expect(await tokens.get()).toBe('short');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await tokens.get()).toBe('access-token-2');
  });

  it('does not let a superseded fetch put the older token back', async () => {
    // The unforced fetch is slow; the forced one overtakes it. The token the forced call
    // produced must survive, or every later request carries the one that was refused.
    const stub = slowThenFastFetch();
    const tokens = manager(stub.fetch);

    const slow = tokens.get();
    await stub.firstCallStarted;
    const forced = await tokens.get(true);
    stub.releaseFirst();
    await slow;

    expect(forced).toBe('access-token-2');
    expect(await tokens.get()).toBe('access-token-2');
  });

  it('does not let a fetch in flight repopulate a cache that was cleared', async () => {
    const stub = slowThenFastFetch();
    const tokens = manager(stub.fetch);

    const pending = tokens.get();
    await stub.firstCallStarted;
    tokens.clear();
    stub.releaseFirst();
    await pending;

    expect(await tokens.get()).toBe('access-token-2');
  });

  it('does not hand out a token that clear() discarded while it was in flight', async () => {
    const stub = slowThenFastFetch();
    const tokens = manager(stub.fetch);

    const first = tokens.get();
    await stub.firstCallStarted;
    const joined = tokens.get(); // joins the in-flight fetch
    tokens.clear(); // the secret was rotated: that token must not be handed out
    stub.releaseFirst();

    await first;
    expect(await joined).toBe('access-token-2');
  });

  it('raises the OAuth error code the server sent', async () => {
    const stub = stubFetch([{ status: 401, body: { error: 'invalid_client' } }]);

    await expect(manager(stub.fetch).get()).rejects.toMatchObject({
      name: 'IsuwaOAuthError',
      status: 401,
      error: 'invalid_client',
    });
  });

  it('rejects a 200 that carries no access_token', async () => {
    const stub = stubFetch([{ body: { token_type: 'Bearer' } }]);

    await expect(manager(stub.fetch).get()).rejects.toBeInstanceOf(IsuwaOAuthError);
  });

  it('does not cache a token across a failed refresh', async () => {
    const stub = stubFetch([TOKEN_REPLY, { status: 503, body: { error: 'server_not_ready' } }]);
    const tokens = manager(stub.fetch);

    await tokens.get();
    await expect(tokens.get(true)).rejects.toMatchObject({ error: 'server_not_ready' });
    expect(stub.calls).toHaveLength(2);
  });
});

/**
 * A fetch whose first call is held open until `releaseFirst()` and whose later calls
 * answer at once, so an overtaking refresh can be reproduced deterministically.
 */
function slowThenFastFetch() {
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstCallStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let call = 0;

  const bodies = [TOKEN_REPLY.body, SECOND_TOKEN_REPLY.body];
  const fetch = (async () => {
    const index = call;
    call += 1;
    if (index === 0) {
      started();
      await held;
    }
    return new Response(JSON.stringify(bodies[Math.min(index, 1)]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as ReturnType<typeof stubFetch>['fetch'];

  return { fetch, firstCallStarted, releaseFirst: () => release() };
}
