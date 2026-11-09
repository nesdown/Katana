import { describe, expect, it, vi } from 'vitest';
import { Http, HttpError, classifyFailure, isPrivateAddress, safeUrl } from '../src/http.js';
import { parseRobots } from '../src/robots.js';
import { fakeFetch } from '../src/testing.js';

const client = (routes: Parameters<typeof fakeFetch>[0], extra = {}) => {
  const net = fakeFetch(routes);
  return { net, http: new Http({ fetch: net.fetch, hostDelayMs: 0, ...extra }) };
};

describe('robots.txt', () => {
  it('follows longest match with allow winning ties', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$', 'KatanaBot/2.0');
    expect(r.allowed('/')).toBe(true);
    expect(r.allowed('/private/x')).toBe(false);
    expect(r.allowed('/private/open/x')).toBe(true);
    expect(r.allowed('/a.pdf')).toBe(false);
    expect(r.allowed('/a.pdf?x=1')).toBe(true);
  });
  it('prefers a group naming the bot', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: KatanaBot\nAllow: /\nCrawl-delay: 3', 'KatanaBot/2.0');
    expect(r.allowed('/x')).toBe(true);
    expect(r.crawlDelayMs).toBe(3000);
  });
  it('shares rules between stacked user agents', () => {
    const r = parseRobots('User-agent: a\nUser-agent: *\nDisallow: /x', 'KatanaBot');
    expect(r.allowed('/x')).toBe(false);
  });
  it('stops page reads when disallowed', async () => {
    const { http } = client({ 'https://a.test/robots.txt': 'User-agent: *\nDisallow: /', 'https://a.test/': 'hi' });
    await expect(http.page('https://a.test/page')).rejects.toThrow(/robots.txt/);
  });
  it('treats a broken robots.txt as a no, per RFC 9309', async () => {
    const { http } = client({ 'https://a.test/robots.txt': () => new Response('', { status: 503 }), 'https://a.test/': 'hi' });
    await expect(http.page('https://a.test/page')).rejects.toThrow(/site may be down/);
  });
  it('recovers from a robots.txt outage instead of staying silent forever', async () => {
    let up = false;
    const { http } = client({ 'https://a.test/robots.txt': () => (up ? new Response('') : new Response('', { status: 502 })), 'https://a.test/page': 'hello' });
    await expect(http.page('https://a.test/page')).rejects.toThrow(/site may be down/);
    up = true;
    await expect(http.page('https://a.test/page')).rejects.toThrow(/site may be down/);
    const later = Date.now() + 301_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(await http.page('https://a.test/page')).toBe('hello');
    } finally {
      spy.mockRestore();
    }
  });
  it('rereads robots.txt after an hour, because rules change', async () => {
    let rules = '';
    const { http } = client({ 'https://a.test/robots.txt': () => new Response(rules), 'https://a.test/page': 'hello' });
    expect(await http.page('https://a.test/page')).toBe('hello');
    rules = 'User-agent: *\nDisallow: /';
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_601_000);
    try {
      await expect(http.page('https://a.test/page')).rejects.toThrow(/asks bots not to read/);
    } finally {
      spy.mockRestore();
    }
  });
  it('treats a missing robots.txt as a yes', async () => {
    const { http } = client({ 'https://a.test/page': 'hello' });
    expect(await http.page('https://a.test/page')).toBe('hello');
  });
});

describe('private network protection', () => {
  it.each(['127.0.0.1', 'localhost', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', '[::1]', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0', 'foo.internal'])('blocks %s', (h) => {
    expect(isPrivateAddress(h)).toBe(true);
  });
  it.each(['8.8.8.8', 'example.com', '172.32.0.1', '2606:4700::1111'])('allows %s', (h) => {
    expect(isPrivateAddress(h)).toBe(false);
  });
  it('blocks the cloud metadata address', async () => {
    const { http, net } = client({});
    await expect(http.bytes('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private/);
    expect(net.calls).toHaveLength(0);
  });
  it('blocks a redirect from public to private', async () => {
    const { http } = client({
      'https://public.test/img': () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
    });
    await expect(http.bytes('https://public.test/img')).rejects.toThrow(/private/);
  });
  it('blocks file URLs', async () => {
    const { http } = client({});
    await expect(http.bytes('file:///etc/passwd')).rejects.toThrow(/file:/);
  });
  it('stops a redirect loop', async () => {
    const { http } = client({ 'https://a.test/': () => new Response('', { status: 302, headers: { location: 'https://a.test/x' } }) });
    await expect(http.bytes('https://a.test/x')).rejects.toThrow(/redirects/);
  });
});

describe('downloads', () => {
  it('enforces the size cap from the header', async () => {
    const { http } = client({ 'https://a.test/big': () => new Response('x', { headers: { 'content-length': '999' } }) });
    await expect(http.bytes('https://a.test/big', { maxBytes: 10 })).rejects.toThrow(/limit/);
  });
  it('enforces the size cap when the header lies', async () => {
    const { http } = client({ 'https://a.test/big': () => new Response('x'.repeat(100)) });
    await expect(http.bytes('https://a.test/big', { maxBytes: 10 })).rejects.toThrow(/limit/);
  });
});

describe('secrets in errors', () => {
  it('redacts tokens from URLs', () => {
    expect(safeUrl('https://api.telegram.org/bot12345:SECRET/sendMessage')).not.toContain('SECRET');
    expect(safeUrl('https://discord.com/api/webhooks/123/SECRET?wait=true')).not.toContain('SECRET');
    expect(safeUrl('https://hooks.slack.com/services/T/B/SECRET')).not.toContain('SECRET');
    expect(safeUrl('https://graph.threads.com/x?access_token=SECRET')).not.toContain('SECRET');
  });
  it('never puts tokens in thrown errors', async () => {
    const { http } = client({ 'https://api.telegram.org/': () => new Response('nope', { status: 401 }) });
    const err = await http.request('https://api.telegram.org/botSECRET/send').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).not.toContain('SECRET');
  });
});

describe('retries', () => {
  it('retries a page read on a server error, then succeeds', async () => {
    let n = 0;
    const { http } = client({ 'https://a.test/p': () => (++n < 2 ? new Response('', { status: 500 }) : new Response('ok')) });
    expect(await http.page('https://a.test/p')).toBe('ok');
    expect(n).toBe(2);
  });
  it('does not retry publishing calls by default', async () => {
    let n = 0;
    const { http } = client({ 'https://a.test/p': () => { n++; return new Response('', { status: 500 }); } });
    await expect(http.request('https://a.test/p', { method: 'POST' })).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(1);
  });
  it('reads Retry-After', async () => {
    const { http } = client({ 'https://a.test/p': () => new Response('', { status: 429, headers: { 'retry-after': '120' } }) });
    const err = await http.request('https://a.test/p', { method: 'POST' }).catch((e) => e);
    expect(err.retryAfterMs).toBe(120_000);
  });
});

describe('failure classification', () => {
  const kind = (status: number) => classifyFailure(new HttpError('x', status, ''), 't').kind;
  it('decides whether a retry is safe', () => {
    expect(kind(400)).toBe('rejected');
    expect(kind(401)).toBe('rejected');
    expect(kind(429)).toBe('transient');
    expect(kind(500)).toBe('ambiguous');
    expect(kind(503)).toBe('ambiguous');
    expect(classifyFailure(new Error('socket hang up'), 't').kind).toBe('ambiguous');
  });
});
