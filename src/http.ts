import {
  IsuwaHttpError,
  IsuwaNetworkError,
  IsuwaRateLimitError,
  IsuwaTimeoutError,
} from './errors.js';
import type { FetchLike } from './types.js';

export interface HttpResult<T> {
  status: number;
  headers: Headers;
  /** The parsed body, or `undefined` when the response carried no JSON. */
  body: T | undefined;
  /** The raw body, kept so an unexpected content type still reaches the caller. */
  raw: string;
  requestId: string | undefined;
  url: string;
}

export interface SendOptions {
  fetchImpl: FetchLike;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/**
 * One HTTP round trip with a hard timeout. It never throws on an HTTP status; the
 * callers decide which statuses are errors.
 */
export async function send<T>(options: SendOptions): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  // The timer is cleared only once the body has been read: a server that sends headers
  // and then stalls mid-body would otherwise hang the call with no abort armed.
  let response: Response;
  let raw: string;
  try {
    response = await options.fetchImpl(options.url, {
      method: options.method,
      headers: options.headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: controller.signal,
    });
    raw = await response.text();
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new IsuwaTimeoutError(
        `${options.method} ${options.url} timed out after ${options.timeoutMs} ms`,
        options.timeoutMs,
        { cause },
      );
    }
    throw new IsuwaNetworkError(`${options.method} ${options.url} failed: ${describe(cause)}`, {
      cause,
    });
  } finally {
    clearTimeout(timer);
  }

  return {
    status: response.status,
    headers: response.headers,
    body: parseJson<T>(raw),
    raw,
    requestId: response.headers.get('x-request-id') ?? undefined,
    url: options.url,
  };
}

/**
 * Turns a non-success response into the closest error class, using the server's own
 * message when it sent one.
 */
export function raiseForStatus(result: HttpResult<unknown>): never {
  const message = serverMessage(result) ?? `HTTP ${result.status} from ${result.url}`;

  if (result.status === 429) {
    throw new IsuwaRateLimitError(message, {
      status: result.status,
      body: result.body ?? result.raw,
      requestId: result.requestId,
      url: result.url,
      retryAfterSeconds: retryAfter(result.headers),
    });
  }

  throw new IsuwaHttpError(message, {
    status: result.status,
    body: result.body ?? result.raw,
    requestId: result.requestId,
    url: result.url,
  });
}

/** The `message` or `error` field of a JSON error body. */
export function serverMessage(result: HttpResult<unknown>): string | undefined {
  const body = result.body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message !== '') return record.message;
    if (typeof record.error === 'string' && record.error !== '') return record.error;
  }
  const trimmed = result.raw.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, 500);
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function parseJson<T>(raw: string): T | undefined {
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
