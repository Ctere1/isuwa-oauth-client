import { describe, expect, it } from 'vitest';

import { IsuwaNetworkError, IsuwaTimeoutError } from '../src/errors.js';
import { send } from '../src/http.js';
import type { FetchLike } from '../src/types.js';

describe('send', () => {
  it('aborts and reports a timeout', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    await expect(
      send({
        fetchImpl: hanging,
        url: 'https://iam.example.com/api/v1/example',
        method: 'POST',
        headers: {},
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(IsuwaTimeoutError);
  });

  it('aborts when the body stalls after the headers arrive', async () => {
    const headersThenStall: FetchLike = (_url, init) =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        text: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      } as unknown as Response);

    await expect(
      send({
        fetchImpl: headersThenStall,
        url: 'https://iam.example.com/api/v1/example',
        method: 'POST',
        headers: {},
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(IsuwaTimeoutError);
  });

  it('wraps a transport failure', async () => {
    const failing: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));

    await expect(
      send({
        fetchImpl: failing,
        url: 'https://iam.example.com/api/v1/oauth/token',
        method: 'POST',
        headers: {},
        timeoutMs: 20_000,
      }),
    ).rejects.toBeInstanceOf(IsuwaNetworkError);
  });

  it('keeps a non-JSON body reachable instead of throwing', async () => {
    const html: FetchLike = () =>
      Promise.resolve(new Response('<html>502</html>', { status: 502 }));

    const result = await send({
      fetchImpl: html,
      url: 'https://iam.example.com/api/v1/example',
      method: 'POST',
      headers: {},
      timeoutMs: 20_000,
    });

    expect(result.status).toBe(502);
    expect(result.body).toBeUndefined();
    expect(result.raw).toBe('<html>502</html>');
  });
});
