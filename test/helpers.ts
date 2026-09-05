import { vi } from 'vitest';

import type { FetchLike } from '../src/types.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface StubbedFetch {
  fetch: FetchLike;
  calls: RecordedCall[];
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string };

/**
 * A fetch that answers with the given replies in order and records what it was asked.
 * The last reply repeats once the list runs out.
 */
export function stubFetch(replies: Reply[]): StubbedFetch {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetch = vi.fn(async (url: string, init: Parameters<FetchLike>[1]) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;
    const payload = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(payload === '' ? null : payload, {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) },
    });
  });

  return { fetch: fetch as unknown as FetchLike, calls };
}

export const TOKEN_REPLY = {
  body: { access_token: 'access-token-1', token_type: 'Bearer', expires_in: 1800, scope: 'app:read' },
};

export const SECOND_TOKEN_REPLY = {
  body: { access_token: 'access-token-2', token_type: 'Bearer', expires_in: 1800, scope: 'app:read' },
};

export const CLIENT_OPTIONS = {
  baseUrl: 'https://iam.example.com',
  clientId: 'client-1',
  clientSecret: 'secret-1',
};
