import { ALLOW_ALL, UNAVAILABLE, parseRobots, type Robots } from './robots.js';
import { silentLogger, type Logger } from './log.js';
import { sleep } from './duration.js';
import { PublishError } from './types.js';

export const DEFAULT_USER_AGENT =
  'KatanaBot/2.0 (+https://github.com/nesdown/Katana)';

export interface HttpOptions {
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  timeoutMs?: number;
  /** Minimum gap between requests to the same host. */
  hostDelayMs?: number;
  /** Respect robots.txt when reading sources. On by default. */
  robots?: boolean;
  /** Allow fetching URLs found in content from private networks. Off by default. */
  allowPrivateNetworks?: boolean;
  log?: Logger;
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  /** Extra attempts for failures that are safe to repeat. */
  retries?: number;
}

export interface BytesResult {
  data: Uint8Array;
  mime?: string;
}

const REDIRECT_LIMIT = 5;
const ROBOTS_TTL_MS = 3_600_000;
// A site's outage must not silence a long-running bot, so failures are remembered only briefly.
const ROBOTS_FAILURE_TTL_MS = 300_000;

/** Strips anything secret from a URL before it can reach logs or error messages. */
export function safeUrl(input: string): string {
  try {
    const u = new URL(input);
    const path = u.pathname
      .replace(/\/bot[^/]+/, '/bot<redacted>')
      .replace(/(\/webhooks\/\d+\/)[^/]+/, '$1<redacted>')
      .replace(/(\/services\/)[^?]+/, '$1<redacted>');
    return `${u.origin}${path}`;
  } catch {
    return '<invalid url>';
  }
}

export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = (mapped?.[1] ?? h).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (h.includes(':')) {
    return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h) || h.startsWith('::ffff:');
  }
  return false;
}

async function resolvesPrivately(host: string): Promise<boolean> {
  try {
    const dns = await import('node:dns/promises');
    const records = await dns.lookup(host, { all: true });
    return records.some((r) => isPrivateAddress(r.address));
  } catch {
    return false; // No DNS module on this runtime, or the name does not resolve and fetch will fail.
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function retryAfter(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

/** A polite HTTP client: timeouts, retries, per-host spacing, robots.txt and safe downloads. */
export class Http {
  readonly userAgent: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly hostDelayMs: number;
  private readonly useRobots: boolean;
  private readonly allowPrivate: boolean;
  private readonly log: Logger;
  private readonly hostQueue = new Map<string, Promise<void>>();
  private readonly robotsCache = new Map<string, { robots: Promise<Robots>; expires: number }>();
  private readonly hostDelays = new Map<string, number>();

  constructor(options: HttpOptions = {}) {
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.hostDelayMs = options.hostDelayMs ?? 1000;
    this.useRobots = options.robots ?? true;
    this.allowPrivate = options.allowPrivateNetworks ?? false;
    this.log = options.log ?? silentLogger;
  }

  /** Low-level request. Returns the response whatever its status; throws only on network failure. */
  async raw(url: string, options: RequestOptions = {}): Promise<Response> {
    const { timeoutMs, retries: _retries, ...init } = options;
    const signal = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const headers = new Headers(init.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', this.userAgent);
    return this.doFetch(url, { ...init, headers, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
  }

  /** Request with retries. Throws HttpError on any non-2xx response. */
  async request(url: string, options: RequestOptions = {}): Promise<Response> {
    const retries = options.retries ?? 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.raw(url, options);
        if (res.ok || res.status === 304) return res;
        const wait = retryAfter(res);
        const repeatable = res.status === 429 || res.status === 408 || res.status >= 500;
        if (repeatable && attempt < retries) {
          await sleep(Math.min(wait ?? 500 * 2 ** attempt, 60_000));
          continue;
        }
        const body = (await res.text().catch(() => '')).slice(0, 500);
        throw new HttpError(`${options.method ?? 'GET'} ${safeUrl(url)} returned ${res.status}`, res.status, body, wait);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (attempt >= retries) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  async json<T = any>(url: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.request(url, options);
    return (await res.json()) as T;
  }

  /** Reads a web page or feed: checks robots.txt, spaces requests per host, retries twice. */
  async page(url: string, options: RequestOptions = {}): Promise<string> {
    await this.assertRobots(url);
    await this.waitForHost(url);
    const res = await this.request(url, { retries: 2, ...options });
    return res.text();
  }

  /** Reads a URL that came from untrusted content. Blocks private networks on every redirect hop. */
  async untrustedPage(url: string, options: { maxBytes?: number } = {}): Promise<{ text: string; finalUrl: string }> {
    await this.assertRobots(url);
    const { res, finalUrl } = await this.follow(url);
    const data = await readLimited(res, options.maxBytes ?? 5_000_000);
    return { text: new TextDecoder().decode(data), finalUrl };
  }

  /** Downloads a file from an untrusted URL, with a size cap and private network protection. */
  async bytes(url: string, options: { maxBytes?: number } = {}): Promise<BytesResult> {
    const { res } = await this.follow(url);
    const data = await readLimited(res, options.maxBytes ?? 10_000_000);
    return { data, mime: res.headers.get('content-type')?.split(';')[0]?.trim() };
  }

  private async follow(start: string): Promise<{ res: Response; finalUrl: string }> {
    let url = start;
    for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
      await this.assertPublic(url);
      await this.waitForHost(url);
      const res = await this.raw(url, { redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => {});
        url = new URL(res.headers.get('location')!, url).href;
        continue;
      }
      if (!res.ok) throw new HttpError(`GET ${safeUrl(url)} returned ${res.status}`, res.status, '');
      return { res, finalUrl: url };
    }
    throw new Error(`Too many redirects from ${safeUrl(start)}`);
  }

  private async assertPublic(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Refusing ${parsed.protocol} URL`);
    }
    if (this.allowPrivate) return;
    if (isPrivateAddress(parsed.hostname) || (await resolvesPrivately(parsed.hostname))) {
      throw new Error(`Refusing to fetch private address ${parsed.hostname}`);
    }
  }

  async allowedByRobots(url: string): Promise<boolean> {
    return (await this.robotsFor(url)).allowed;
  }

  /** Throws when a page must not be read, saying whether the site refused or was unreachable. */
  private async assertRobots(url: string): Promise<void> {
    const { allowed, unavailable } = await this.robotsFor(url);
    if (allowed) return;
    throw new Error(
      unavailable
        ? `Could not read robots.txt for ${new URL(url).host}, so skipping it for now. The site may be down.`
        : `robots.txt asks bots not to read ${safeUrl(url)}`,
    );
  }

  private async robotsFor(url: string): Promise<{ allowed: boolean; unavailable?: boolean }> {
    if (!this.useRobots) return { allowed: true };
    const { origin, pathname, search, host } = new URL(url);
    let entry = this.robotsCache.get(origin);
    if (!entry || entry.expires <= Date.now()) {
      const robots = this.loadRobots(origin);
      entry = { robots, expires: Date.now() + ROBOTS_TTL_MS };
      this.robotsCache.set(origin, entry);
      const stored = entry;
      void robots.then((r) => {
        if (r.unavailable) stored.expires = Date.now() + ROBOTS_FAILURE_TTL_MS;
      });
    }
    const robots = await entry.robots;
    if (robots.crawlDelayMs !== undefined) this.hostDelays.set(host, robots.crawlDelayMs);
    return { allowed: robots.allowed(pathname + search), unavailable: robots.unavailable };
  }

  private async loadRobots(origin: string): Promise<Robots> {
    try {
      const res = await this.raw(`${origin}/robots.txt`, { timeoutMs: 10_000 });
      if (res.status >= 500) return UNAVAILABLE; // RFC 9309: an unreachable robots.txt means no access.
      if (!res.ok) return ALLOW_ALL;
      return parseRobots(await res.text(), this.userAgent);
    } catch {
      this.log.warn(`Could not read ${origin}/robots.txt, skipping the site for now`);
      return UNAVAILABLE;
    }
  }

  private waitForHost(url: string): Promise<void> {
    const { host } = new URL(url);
    const gap = Math.min(this.hostDelays.get(host) ?? this.hostDelayMs, 60_000);
    const previous = this.hostQueue.get(host);
    if (!previous && gap === 0) return Promise.resolve();
    const turn = (previous ?? Promise.resolve()).then(() => undefined);
    this.hostQueue.set(host, turn.then(() => sleep(gap)));
    return turn;
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Response is ${declared} bytes, over the ${maxBytes} byte limit`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response is over the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Converts any failure from a publish call into a PublishError that says whether a retry is safe. */
export function classifyFailure(err: unknown, targetName: string): PublishError {
  if (err instanceof PublishError) return err;
  if (err instanceof HttpError) {
    const detail = err.body ? `: ${err.body.slice(0, 200)}` : '';
    const message = `${targetName}: ${err.message}${detail}`;
    if (err.status === 429) return new PublishError(message, 'transient', err.status, err.retryAfterMs);
    if (err.status === 408 || err.status >= 500) return new PublishError(message, 'ambiguous', err.status, err.retryAfterMs);
    return new PublishError(message, 'rejected', err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new PublishError(`${targetName}: ${message}`, 'ambiguous');
}
