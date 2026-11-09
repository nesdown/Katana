import type { Http } from './http.js';
import { countGraphemes } from './text/count.js';
import { PublishError, type Limits, type Post, type PublishCtx, type Receipt, type Target } from './types.js';

export type FakeResponse = string | object | Response | ((request: Request) => Response | Promise<Response>);

export interface FakeFetch {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; method: string; headers: Headers; body: unknown }>;
  /** Every call to a URL containing this text. */
  to(fragment: string): FakeFetch['calls'];
}

const toResponse = (value: Exclude<FakeResponse, Function>): Response => {
  if (value instanceof Response) return value.clone();
  if (typeof value === 'string') return new Response(value);
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
};

/** A stand-in for the network. Routes match on the start of the URL, longest first. robots.txt is absent by default. */
export function fakeFetch(routes: Record<string, FakeResponse>): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const sorted = Object.entries(routes).sort(([a], [b]) => b.length - a.length);
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === 'string' && headers.get('content-type')?.includes('json')) body = JSON.parse(body);
    calls.push({ url, method, headers, body });
    const hit = sorted.find(([prefix]) => {
      const [m, u] = prefix.includes(' ') ? (prefix.split(' ') as [string, string]) : [undefined, prefix];
      return (!m || m === method) && url.startsWith(u);
    });
    if (!hit) {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response(`No fake route for ${method} ${url}`, { status: 599 });
    }
    const value = hit[1];
    if (typeof value === 'function') return value(new Request(url, { method }));
    return toResponse(value);
  }) as typeof globalThis.fetch;
  return { fetch: fetchFake, calls, to: (fragment) => calls.filter((c) => c.url.includes(fragment)) };
}

export interface RecordingTarget extends Target {
  posts: Post[];
  /** Makes the next publish calls fail, in order. */
  failNext(...errors: Array<Error | 'rejected' | 'transient' | 'ambiguous'>): void;
}

/** A target that remembers what it was asked to post. */
export function recordingTarget(options: { name?: string; limits?: Partial<Limits>; idempotent?: boolean; onPublish?: (post: Post, ctx: PublishCtx) => void | Promise<void> } = {}): RecordingTarget {
  const posts: Post[] = [];
  const failures: Array<Error | 'rejected' | 'transient' | 'ambiguous'> = [];
  return {
    name: options.name ?? 'recording',
    idempotent: options.idempotent,
    limits: { maxChars: 500, count: countGraphemes, maxMedia: 4, links: true, maxThread: 1, ...options.limits },
    posts,
    failNext: (...errors) => void failures.push(...errors),
    async publish(post, ctx): Promise<Receipt> {
      await options.onPublish?.(post, ctx);
      const failure = failures.shift();
      if (failure) throw failure instanceof Error ? failure : new PublishError(`simulated ${failure} failure`, failure);
      posts.push(post);
      return { id: `post-${posts.length}` };
    },
  };
}

export type { Http };
