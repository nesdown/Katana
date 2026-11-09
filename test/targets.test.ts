import { describe, expect, it } from 'vitest';
import { Http } from '../src/http.js';
import { silentLogger } from '../src/log.js';
import { bluesky, consoleTarget, discord, linkedin, mastodon, oauth1Header, slack, sniffImage, telegram, threads, webhook, x } from '../src/targets/index.js';
import { fakeFetch, type FakeFetch } from '../src/testing.js';
import { ConfigError, type Post, type PublishCtx } from '../src/types.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
const post = (over: Partial<Post> = {}): Post => ({ key: 'k', parts: ['Hello'], media: [], idempotencyKey: 'idem', ...over });
const setup = (routes: Parameters<typeof fakeFetch>[0], over: Partial<PublishCtx> = {}) => {
  const net: FakeFetch = fakeFetch(routes);
  const checkpoints: string[] = [];
  const ctx: PublishCtx = {
    bot: 't', dryRun: false, log: silentLogger, now: () => new Date('2026-11-09T12:00:00Z'),
    http: new Http({ fetch: net.fetch, hostDelayMs: 0 }),
    resume: [], checkpoint: async (id) => void checkpoints.push(id), ...over,
  };
  return { net, ctx, checkpoints };
};
const image = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });

describe('Bluesky', () => {
  const S = 'https://bsky.test';
  const target = (o = {}) => bluesky({ handle: 'a.test', appPassword: 'pw', service: S, ...o });
  const base = {
    [`${S}/xrpc/com.atproto.server.createSession`]: { accessJwt: 'jwt', did: 'did:plc:abc' },
    [`${S}/xrpc/com.atproto.repo.createRecord`]: { uri: 'at://did:plc:abc/app.bsky.feed.post/rk1', cid: 'c1' },
    [`${S}/xrpc/com.atproto.repo.uploadBlob`]: { blob: { $type: 'blob', ref: 'r' } },
  };
  it('signs in, then writes a record with facets', async () => {
    const { net, ctx } = setup(base);
    const r = await target().publish(post({ parts: ['See https://example.com/a #news'], lang: 'en' }), ctx);
    expect(net.to('createSession')[0]!.body).toEqual({ identifier: 'a.test', password: 'pw' });
    const call = net.to('createRecord')[0]!;
    expect(call.headers.get('authorization')).toBe('Bearer jwt');
    const body = call.body as any;
    expect(body.repo).toBe('did:plc:abc');
    expect(body.collection).toBe('app.bsky.feed.post');
    expect(body.record.$type).toBe('app.bsky.feed.post');
    expect(body.record.text).toBe('See example.com/a #news');
    expect(body.record.createdAt).toBe('2026-11-09T12:00:00.000Z');
    expect(body.record.langs).toEqual(['en']);
    expect(body.record.facets).toHaveLength(2);
    expect(r.url).toBe('https://bsky.app/profile/did:plc:abc/post/rk1');
  });
  it('uploads images as blobs with alt text', async () => {
    const { net, ctx } = setup({ ...base, 'https://img.test/a.png': image });
    await target().publish(post({ media: [{ url: 'https://img.test/a.png', alt: 'alt!' }] }), ctx);
    expect(net.to('uploadBlob')[0]!.headers.get('content-type')).toBe('image/png');
    expect((net.to('createRecord')[0]!.body as any).record.embed).toEqual({
      $type: 'app.bsky.embed.images',
      images: [{ alt: 'alt!', image: { $type: 'blob', ref: 'r' } }],
    });
  });
  it('uses a link card when there is no image', async () => {
    const { net, ctx } = setup(base);
    await target().publish(post({ url: 'https://n.test/a', title: 'T', description: 'D' }), ctx);
    expect((net.to('createRecord')[0]!.body as any).record.embed.external).toEqual({ uri: 'https://n.test/a', title: 'T', description: 'D' });
  });
  it('still posts when the image is bad', async () => {
    const { net, ctx } = setup({ ...base, 'https://img.test/a.png': () => new Response('<html>not an image</html>') });
    await target().publish(post({ media: [{ url: 'https://img.test/a.png' }] }), ctx);
    expect(net.to('uploadBlob')).toHaveLength(0);
    expect(net.to('createRecord')).toHaveLength(1);
  });
  it('threads replies with root and parent', async () => {
    let n = 0;
    const { net, ctx, checkpoints } = setup({ ...base, [`${S}/xrpc/com.atproto.repo.createRecord`]: () => { n++; return Response.json({ uri: `at://d/p/${n}`, cid: `c${n}` }); } });
    const r = await target({ threads: 3 }).publish(post({ parts: ['a', 'b', 'c'] }), ctx);
    const records = net.to('createRecord').map((c) => (c.body as any).record);
    expect(records[0].reply).toBeUndefined();
    expect(records[1].reply).toEqual({ root: { uri: 'at://d/p/1', cid: 'c1' }, parent: { uri: 'at://d/p/1', cid: 'c1' } });
    expect(records[2].reply).toEqual({ root: { uri: 'at://d/p/1', cid: 'c1' }, parent: { uri: 'at://d/p/2', cid: 'c2' } });
    expect(checkpoints).toHaveLength(3);
    expect(r.ids).toHaveLength(3);
  });
  it('resumes a broken thread without repeating parts', async () => {
    const { net, ctx } = setup(base, { resume: ['at://d/p/1#c1'] });
    await target({ threads: 2 }).publish(post({ parts: ['a', 'b'] }), ctx);
    const calls = net.to('createRecord');
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as any).record.text).toBe('b');
    expect((calls[0]!.body as any).record.reply.root).toEqual({ uri: 'at://d/p/1', cid: 'c1' });
  });
  it('asks for missing credentials by name', async () => {
    const { ctx } = setup(base);
    await expect(bluesky({ service: S }).publish(post(), ctx)).rejects.toBeInstanceOf(ConfigError);
    await expect(bluesky({ service: S }).publish(post(), ctx)).rejects.toThrow(/BLUESKY_HANDLE/);
  });
  it('allows a retry of sign-in after a failure', async () => {
    let n = 0;
    const { ctx } = setup({ ...base, [`${S}/xrpc/com.atproto.server.createSession`]: () => (++n === 1 ? new Response('', { status: 500 }) : Response.json({ accessJwt: 'j', did: 'd' })) });
    const t = target();
    await expect(t.publish(post(), ctx)).rejects.toThrow();
    await expect(t.publish(post(), ctx)).resolves.toBeTruthy();
  });
});

describe('Mastodon', () => {
  const I = 'https://m.test';
  const target = (o = {}) => mastodon({ instance: I, token: 'tok', pollMs: 0, ...o });
  it('posts as a form with an idempotency key', async () => {
    const { net, ctx } = setup({ [`${I}/api/v1/statuses`]: { id: '1', url: `${I}/@a/1` } });
    const r = await target({ visibility: 'unlisted' }).publish(post({ lang: 'uk' }), ctx);
    const call = net.calls[0]!;
    expect(call.headers.get('idempotency-key')).toBe('idem-0');
    expect(call.headers.get('authorization')).toBe('Bearer tok');
    const form = call.body as URLSearchParams;
    expect(form.get('status')).toBe('Hello');
    expect(form.get('visibility')).toBe('unlisted');
    expect(form.get('language')).toBe('uk');
    expect(r).toMatchObject({ id: '1', url: `${I}/@a/1` });
  });
  it('is marked safe to retry', () => expect(target().idempotent).toBe(true));
  it('uploads media and waits for processing', async () => {
    let polls = 0;
    const { net, ctx } = setup({
      'https://img.test/a.png': image,
      [`${I}/api/v2/media`]: () => new Response(JSON.stringify({ id: 'm1', url: null }), { status: 202 }),
      [`${I}/api/v1/media/m1`]: () => (++polls < 2 ? new Response('{}', { status: 206 }) : new Response('{"id":"m1"}')),
      [`${I}/api/v1/statuses`]: { id: '1' },
    });
    await target().publish(post({ media: [{ url: 'https://img.test/a.png', alt: 'A' }] }), ctx);
    expect(polls).toBe(2);
    const form = net.to('/api/v2/media')[0]!.body as FormData;
    expect(form.get('description')).toBe('A');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect((net.to('statuses')[0]!.body as URLSearchParams).getAll('media_ids[]')).toEqual(['m1']);
  });
  it('threads with in_reply_to_id', async () => {
    let n = 0;
    const { net, ctx } = setup({ [`${I}/api/v1/statuses`]: () => Response.json({ id: String(++n) }) });
    await target({ threads: 2 }).publish(post({ parts: ['a', 'b'] }), ctx);
    expect((net.calls[1]!.body as URLSearchParams).get('in_reply_to_id')).toBe('1');
    expect(net.calls[1]!.headers.get('idempotency-key')).toBe('idem-1');
  });
});

describe('X', () => {
  const B = 'https://x.test/2';
  const target = (o = {}) => x({ bearer: 'tok', baseUrl: B, ...o });
  it('matches the published OAuth 1.0a signature test vector', async () => {
    const header = await oauth1Header(
      'POST',
      'https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21',
      {
        apiKey: 'xvz1evFS4wEEPTGEFPHBog',
        apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      },
      'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      '1318622958',
    );
    expect(decodeURIComponent(header.match(/oauth_signature="([^"]+)"/)![1]!)).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });
  it('posts JSON and links the receipt', async () => {
    const { net, ctx } = setup({ [`${B}/tweets`]: { data: { id: '99' } } });
    const r = await target().publish(post(), ctx);
    expect(net.calls[0]!.body).toEqual({ text: 'Hello' });
    expect(net.calls[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(r.url).toBe('https://x.com/i/status/99');
  });
  it('runs the chunked media flow', async () => {
    const { net, ctx } = setup({
      'https://img.test/a.png': image,
      [`${B}/media/upload/initialize`]: { data: { id: 'M1' } },
      [`${B}/media/upload/M1/append`]: () => new Response(null, { status: 204 }),
      [`${B}/media/upload/M1/finalize`]: { data: { id: 'M1' } },
      [`${B}/tweets`]: { data: { id: '1' } },
    });
    await target().publish(post({ media: [{ url: 'https://img.test/a.png' }] }), ctx);
    expect(net.to('initialize')[0]!.body).toEqual({ media_type: 'image/png', total_bytes: PNG.byteLength, media_category: 'tweet_image' });
    const form = net.to('append')[0]!.body as FormData;
    expect(form.get('segment_index')).toBe('0');
    expect(form.get('media')).toBeInstanceOf(Blob);
    expect(net.to('tweets')[0]!.body).toEqual({ text: 'Hello', media: { media_ids: ['M1'] } });
  });
  it('threads with reply ids', async () => {
    let n = 0;
    const { net, ctx } = setup({ [`${B}/tweets`]: () => Response.json({ data: { id: String(++n) } }) });
    await target({ threads: 2 }).publish(post({ parts: ['a', 'b'] }), ctx);
    expect(net.calls[1]!.body).toEqual({ text: 'b', reply: { in_reply_to_tweet_id: '1' } });
  });
  it('declares no links when configured, to avoid the link surcharge', () => {
    expect(target({ links: false }).limits.links).toBe(false);
  });
});

describe('Threads', () => {
  const B = 'https://t.test/v1.0';
  const target = () => threads({ userId: 'u1', token: 'tok', baseUrl: B, pollMs: 0 });
  it('creates a container, waits, then publishes', async () => {
    let status = 0;
    const { net, ctx } = setup({
      [`POST ${B}/u1/threads_publish`]: { id: 'pub1' },
      [`POST ${B}/u1/threads`]: { id: 'c1' },
      [`GET ${B}/c1`]: () => Response.json({ status: ++status < 2 ? 'IN_PROGRESS' : 'FINISHED' }),
    });
    const r = await target().publish(post({ media: [{ url: 'https://i.test/a.jpg' }] }), ctx);
    const created = net.calls.find((c) => c.url === `${B}/u1/threads`)!.body as URLSearchParams;
    expect(created.get('media_type')).toBe('IMAGE');
    expect(created.get('image_url')).toBe('https://i.test/a.jpg');
    expect(created.get('text')).toBe('Hello');
    expect((net.to('threads_publish')[0]!.body as URLSearchParams).get('creation_id')).toBe('c1');
    expect(r.id).toBe('pub1');
  });
  it('stops when the container errors', async () => {
    const { ctx } = setup({
      [`POST ${B}/u1/threads`]: { id: 'c1' },
      [`GET ${B}/c1`]: { status: 'ERROR', error_message: 'FAILED_DOWNLOADING_VIDEO' },
    });
    await expect(target().publish(post(), ctx)).rejects.toThrow(/FAILED_DOWNLOADING/);
  });
  it('replies with reply_to_id', async () => {
    let n = 0;
    const t = threads({ userId: 'u1', token: 'tok', baseUrl: B, pollMs: 0, threads: 2 });
    const { net, ctx } = setup({
      [`POST ${B}/u1/threads_publish`]: () => Response.json({ id: `pub${++n}` }),
      [`POST ${B}/u1/threads`]: { id: 'c1' },
      [`GET ${B}/c1`]: { status: 'FINISHED' },
    });
    await t.publish(post({ parts: ['a', 'b'] }), ctx);
    const second = net.calls.filter((c) => c.url === `${B}/u1/threads`)[1]!.body as URLSearchParams;
    expect(second.get('reply_to_id')).toBe('pub1');
  });
});

describe('Telegram', () => {
  const target = telegram({ token: 'SEKRET', chatId: '@c', baseUrl: 'https://tg.test' });
  it('sends a message', async () => {
    const { net, ctx } = setup({ 'https://tg.test/botSEKRET/sendMessage': { result: { message_id: 7 } } });
    expect((await target.publish(post(), ctx)).id).toBe('7');
    expect(net.calls[0]!.body).toEqual({ chat_id: '@c', text: 'Hello' });
  });
  it('sends a photo with a caption', async () => {
    const { net, ctx } = setup({ 'https://tg.test/botSEKRET/sendPhoto': { result: { message_id: 8 } } });
    await target.publish(post({ media: [{ url: 'https://i.test/a.jpg' }] }), ctx);
    expect(net.calls[0]!.body).toEqual({ chat_id: '@c', photo: 'https://i.test/a.jpg', caption: 'Hello' });
  });
  it('falls back to a plain message when the text is too long for a caption', async () => {
    const { net, ctx } = setup({ 'https://tg.test/botSEKRET/sendMessage': { result: { message_id: 9 } } });
    await target.publish(post({ parts: ['x'.repeat(2000)], media: [{ url: 'https://i.test/a.jpg' }] }), ctx);
    expect(net.calls[0]!.url).toContain('sendMessage');
  });
  it('keeps the token out of errors', async () => {
    const { ctx } = setup({ 'https://tg.test/': () => new Response('bad', { status: 403 }) });
    const err = await target.publish(post(), ctx).catch((e) => e);
    expect(err.message).not.toContain('SEKRET');
  });
});

describe('Discord, Slack, LinkedIn, webhook', () => {
  it('Discord blocks mention pings from scraped text', async () => {
    const { net, ctx } = setup({ 'https://d.test/hook': { id: 'd1' } });
    await discord({ webhook: 'https://d.test/hook' }).publish(post({ parts: ['@everyone wow'] }), ctx);
    expect(net.calls[0]!.url).toContain('wait=true');
    expect((net.calls[0]!.body as any).allowed_mentions).toEqual({ parse: [] });
  });
  it('Slack escapes control sequences', async () => {
    const { net, ctx } = setup({ 'https://s.test/hook': 'ok' });
    await slack({ webhook: 'https://s.test/hook' }).publish(post({ parts: ['<!channel> a & b'] }), ctx);
    expect((net.calls[0]!.body as any).text).toBe('&lt;!channel&gt; a &amp; b');
  });
  it('LinkedIn sends the documented headers and reads the id header', async () => {
    const { net, ctx } = setup({ 'https://li.test/rest/posts': () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }) });
    const r = await linkedin({ token: 't', author: 'urn:li:person:a', version: '202610', baseUrl: 'https://li.test' }).publish(post({ parts: ['Hi (there)'], url: 'https://n.test', title: 'T' }), ctx);
    const call = net.calls[0]!;
    expect(call.headers.get('linkedin-version')).toBe('202610');
    expect(call.headers.get('x-restli-protocol-version')).toBe('2.0.0');
    const body = call.body as any;
    expect(body.author).toBe('urn:li:person:a');
    expect(body.commentary).toBe('Hi \\(there\\)');
    expect(body.lifecycleState).toBe('PUBLISHED');
    expect(body.distribution.feedDistribution).toBe('MAIN_FEED');
    expect(body.content.article).toEqual({ source: 'https://n.test', title: 'T' });
    expect(r.id).toBe('urn:li:share:1');
  });
  it('webhook signs its body', async () => {
    const { createHmac } = await import('node:crypto');
    let raw = '';
    const { net, ctx } = setup({ 'https://w.test/': 'ok' });
    await webhook({ url: 'https://w.test/in', secret: 's3' }).publish(post(), ctx);
    const call = net.calls[0]!;
    raw = JSON.stringify(call.body);
    expect(call.headers.get('x-katana-signature')).toBe(createHmac('sha256', 's3').update(raw).digest('hex'));
    expect(call.headers.get('x-katana-idempotency-key')).toBe('idem');
  });
  it('console prints', async () => {
    const lines: string[] = [];
    const { ctx } = setup({}, { log: { ...silentLogger, info: (m) => void lines.push(m) } });
    await consoleTarget().publish(post(), ctx);
    expect(lines.join('')).toContain('Hello');
  });
});

describe('sniffImage', () => {
  it('recognises real images and rejects the rest', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(sniffImage(new TextEncoder().encode('RIFF1234WEBP'))).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg onload="evil()">'))).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode('<html>'))).toBeUndefined();
  });
});
