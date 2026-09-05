import { describe, expect, it } from 'vitest';

import { IsuwaClient, MIN_TIMEOUT_MS } from '../src/client.js';
import { IsuwaConfigError, IsuwaHttpError, IsuwaRateLimitError } from '../src/errors.js';
import { CLIENT_OPTIONS, SECOND_TOKEN_REPLY, TOKEN_REPLY, stubFetch } from './helpers.js';

describe('IsuwaClient configuration', () => {
  it('rejects a missing client id', () => {
    expect(() => new IsuwaClient({ ...CLIENT_OPTIONS, clientId: '' })).toThrow(IsuwaConfigError);
  });

  it('rejects a base URL that is not absolute', () => {
    expect(() => new IsuwaClient({ ...CLIENT_OPTIONS, baseUrl: 'iam.example.com' })).toThrow(
      IsuwaConfigError,
    );
  });

  it('trims a trailing slash from the base URL', () => {
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, baseUrl: 'https://iam.example.com/' });
    expect(client.baseUrl).toBe('https://iam.example.com');
  });

  it('rejects a timeout below the supported floor', () => {
    expect(() => new IsuwaClient({ ...CLIENT_OPTIONS, timeoutMs: MIN_TIMEOUT_MS - 1 })).toThrow(
      /timeoutMs/,
    );
  });

  it('rejects an empty scope', () => {
    expect(() => new IsuwaClient({ ...CLIENT_OPTIONS, scope: '  ' })).toThrow(/scope/);
  });
});

describe('IsuwaClient.request', () => {
  it('sends the credentials headers and the cached token', async () => {
    const stub = stubFetch([TOKEN_REPLY, { body: { ok: true } }]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    const body = await client.request('/api/v1/example', {
      body: { hello: 'world' },
      requestId: 'req-42',
      userAgent: 'Mozilla/5.0 (test)',
      forwardedFor: '203.0.113.7',
    });

    const call = stub.calls[1]!;
    expect(body).toEqual({ ok: true });
    expect(call.url).toBe('https://iam.example.com/api/v1/example');
    expect(call.headers).toMatchObject({
      Authorization: 'Bearer access-token-1',
      'Client-ID': 'client-1',
      'Content-Type': 'application/json',
      'X-Request-Id': 'req-42',
      'User-Agent': 'Mozilla/5.0 (test)',
      'X-Forwarded-For': '203.0.113.7',
      'X-Real-IP': '203.0.113.7',
    });
    expect(JSON.parse(call.body!)).toEqual({ hello: 'world' });
  });

  it('leaves Application-Type out until the application declares one', async () => {
    // Two clients, so the token endpoint is called twice: token, request, token, request.
    const stub = stubFetch([TOKEN_REPLY, { body: {} }, TOKEN_REPLY, { body: {} }]);

    const plain = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });
    await plain.request('/api/v1/example');
    expect(stub.calls[1]!.headers['Application-Type']).toBeUndefined();

    const typed = new IsuwaClient({
      ...CLIENT_OPTIONS,
      fetch: stub.fetch,
      applicationType: 'some-connector',
    });
    await typed.request('/api/v1/example');
    expect(stub.calls[3]!.headers['Application-Type']).toBe('some-connector');
  });

  it('resolves a path against the base URL, however it is written', async () => {
    const stub = stubFetch([TOKEN_REPLY, { body: {} }]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    await client.request('api/v1/example');

    expect(stub.calls[1]!.url).toBe('https://iam.example.com/api/v1/example');
  });

  it('keeps a path prefix on the base URL, the way the token call does', async () => {
    const stub = stubFetch([TOKEN_REPLY, { body: {} }]);
    const client = new IsuwaClient({
      ...CLIENT_OPTIONS,
      baseUrl: 'https://iam.example.com/iam',
      fetch: stub.fetch,
    });

    await client.request('/api/v1/example');

    expect(stub.calls[0]!.url).toBe('https://iam.example.com/iam/api/v1/oauth/token');
    expect(stub.calls[1]!.url).toBe('https://iam.example.com/iam/api/v1/example');
  });

  it('sends GET without a content type when there is no body', async () => {
    const stub = stubFetch([TOKEN_REPLY, { body: { ok: true } }]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    await client.request('/api/v1/example');

    expect(stub.calls[1]!.method).toBe('GET');
    expect(stub.calls[1]!.headers['Content-Type']).toBeUndefined();
  });

  it('applies the timeout floor to a per-call override too', async () => {
    const stub = stubFetch([TOKEN_REPLY]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    await expect(client.request('/api/v1/example', { timeoutMs: 1 })).rejects.toBeInstanceOf(
      IsuwaConfigError,
    );
  });

  it('does not pass off a non-JSON 2xx body as a result', async () => {
    const stub = stubFetch([TOKEN_REPLY, { status: 200, raw: '<html>hello</html>' }]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    await expect(client.request('/api/v1/example')).rejects.toThrow(/not JSON/);
  });

  it('accepts an empty 2xx body', async () => {
    const stub = stubFetch([TOKEN_REPLY, { status: 204, raw: '' }]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    await expect(client.request('/api/v1/example')).resolves.toBeUndefined();
  });

  it('refuses to send the token to another origin', async () => {
    const stub = stubFetch([TOKEN_REPLY]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    await expect(client.request('https://attacker.example/collect')).rejects.toBeInstanceOf(
      IsuwaConfigError,
    );
  });

  it('refreshes the token once and replays a 401', async () => {
    const stub = stubFetch([
      TOKEN_REPLY,
      { status: 401, body: { message: 'token refused' } },
      SECOND_TOKEN_REPLY,
      { body: { ok: true } },
    ]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    await client.request('/api/v1/example');

    expect(stub.calls).toHaveLength(4);
    expect(stub.calls[3]!.headers.Authorization).toBe('Bearer access-token-2');
  });

  it('gives up after one replay and keeps the server message', async () => {
    const refusal = { status: 401, body: { message: 'token refused' } };
    const stub = stubFetch([TOKEN_REPLY, refusal, SECOND_TOKEN_REPLY, refusal]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    await expect(client.request('/api/v1/example')).rejects.toMatchObject({
      name: 'IsuwaHttpError',
      status: 401,
      message: 'token refused',
    });
  });

  it('does not replay a 401 when the retry is turned off', async () => {
    const stub = stubFetch([TOKEN_REPLY, { status: 401, body: { message: 'no' } }]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch, retryOn401: false });

    await expect(client.request('/api/v1/example')).rejects.toBeInstanceOf(IsuwaHttpError);
    expect(stub.calls).toHaveLength(2);
  });

  it('surfaces a rate limit with its Retry-After', async () => {
    const stub = stubFetch([
      TOKEN_REPLY,
      { status: 429, body: { message: 'too many requests' }, headers: { 'Retry-After': '4' } },
    ]);
    const client = new IsuwaClient({ ...CLIENT_OPTIONS, fetch: stub.fetch });

    const error = await client.request('/api/v1/example').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(IsuwaRateLimitError);
    expect((error as IsuwaRateLimitError).retryAfterSeconds).toBe(4);
  });
});
