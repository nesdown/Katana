import { describe, expect, it, vi } from 'vitest';
import { katana, type KatanaConfig } from '../src/bot.js';
import { cut } from '../src/cuts/index.js';
import { list } from '../src/sources/index.js';
import { memoryStore } from '../src/stores/index.js';
import { recordingTarget } from '../src/testing.js';
import { ConfigError, drop, type Delivery, type Store } from '../src/types.js';

const NOW = new Date('2026-11-09T12:00:00Z');
const STORIES = [
  { title: 'Kyiv metro reopens the red line', url: 'https://n.test/1' },
  { title: 'New bridge opens over the Dnipro river', url: 'https://n.test/2' },
  { title: 'Scientists find water on a distant moon', url: 'https://n.test/3' },
];
const build = (over: Partial<KatanaConfig> = {}) => {
  const target = recordingTarget();
  const store = memoryStore();
  let clock = NOW;
  const bot = katana({
    name: 'test',
    sources: [list('news', STORIES)],
    targets: [target],
    store,
    now: () => clock,
    http: { hostDelayMs: 0 },
    ...over,
  });
  return { bot, target, store, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
};
const deliveries = async (store: Store) => (await store.all<Delivery>('deliveries')).map(([, d]) => d);

describe('the pipeline', () => {
  it('posts one new item per run by default, and remembers', async () => {
    const { bot, target } = build();
    await bot.run();
    expect(target.posts).toHaveLength(1);
    await bot.run();
    await bot.run();
    await bot.run();
    expect(target.posts).toHaveLength(3);
    expect(new Set(target.posts.map((p) => p.key)).size).toBe(3);
  });
  it('never posts the same URL twice, even with tracking parameters', async () => {
    const { bot, target } = build({ sources: [list('a', [{ title: 'Story one here', url: 'https://n.test/x?utm_source=a' }, { title: 'A different title entirely', url: 'https://www.n.test/x/' }])], pace: { perRun: 5 } });
    await bot.run();
    expect(target.posts).toHaveLength(1);
  });
  it('catches the same story from two outlets', async () => {
    const { bot, target } = build({
      sources: [list('a', [{ title: 'Президент України відвідав Київ сьогодні', url: 'https://a.test/1' }]), list('b', [{ title: 'Президент України сьогодні відвідав Київ', url: 'https://b.test/9' }])],
      pace: { perRun: 5 },
    });
    const report = await bot.run();
    expect(target.posts).toHaveLength(1);
    expect(report.trace.find((t) => t.outcome === 'duplicate')?.reason).toContain('same story');
  });
  it('catches a repeat story across runs but forgets outside the window', async () => {
    const target = recordingTarget();
    const store = memoryStore();
    let clock = NOW;
    const make = (url: string, title: string) => katana({ name: 'test', sources: [list('s', [{ title, url }])], targets: [target], store, now: () => clock });
    await make('https://a.test/1', 'Big storm hits the coast tonight').run();
    await make('https://b.test/2', 'Big storm hits the coast tonight!').run();
    expect(target.posts).toHaveLength(1);
    clock = new Date(NOW.getTime() + 15 * 86_400_000);
    await make('https://c.test/3', 'Big storm hits the coast tonight').run();
    expect(target.posts).toHaveLength(2);
  });
  it('does not post old news on the first run', async () => {
    const { bot, target } = build({ sources: [list('a', [{ title: 'Old story from months ago', url: 'https://a.test/o', publishedAt: new Date('2026-01-01') }])] });
    const r = await bot.run();
    expect(r.fresh).toBe(0);
    expect(target.posts).toHaveLength(0);
  });
  it('keeps going when one source breaks', async () => {
    const broken = { name: 'broken', read: async () => { throw new Error('site down'); } };
    const { bot, target } = build({ sources: [broken, list('ok', STORIES)] });
    const r = await bot.run();
    expect(target.posts).toHaveLength(1);
    expect(r.errors[0]).toContain('site down');
    expect(r.read.find((s) => s.source === 'broken')?.error).toContain('site down');
  });
  it('takes turns between sources so a busy feed cannot drown a quiet one', async () => {
    const busy = list('busy', Array.from({ length: 5 }, (_, i) => ({ title: `Busy feed story number ${'xyzab'[i]} and unique ${i * 991}`, url: `https://b.test/${i}` })));
    const quiet = list('quiet', [{ title: 'Quiet feed has one good story', url: 'https://q.test/1' }]);
    const { bot, target } = build({ sources: [busy, quiet], pace: { perRun: 2 } });
    await bot.run();
    expect(target.posts.map((p) => p.url)).toContain('https://q.test/1');
  });
});

describe('cuts', () => {
  it('applies cuts in order and remembers drops so AI is not paid for twice', async () => {
    const seen = vi.fn((item) => drop('not interesting'));
    const { bot, target } = build({ cuts: [cut('filter', seen)], pace: { perRun: 3 } });
    await bot.run();
    expect(seen).toHaveBeenCalledTimes(3);
    expect(target.posts).toHaveLength(0);
    await bot.run();
    expect(seen).toHaveBeenCalledTimes(3);
  });
  it('only runs cuts on items it may post', async () => {
    const spend = vi.fn((item) => item);
    const { bot } = build({ cuts: [cut('paid', spend, 'ai')], pace: { perRun: 1 } });
    await bot.run();
    expect(spend).toHaveBeenCalledTimes(1);
  });
  it('accepts plain functions', async () => {
    const { bot, target } = build({ cuts: [(item) => ({ ...item, post: item.title.toUpperCase() })] });
    await bot.run();
    expect(target.posts[0]!.parts[0]).toContain('KYIV METRO');
  });
  it('a returned null drops the item', async () => {
    const { bot, target } = build({ cuts: [() => null] });
    const r = await bot.run();
    expect(target.posts).toHaveLength(0);
    expect(r.trace[0]!.reason).toContain('removed by');
  });
  it('retries items when a cut fails, then gives up after three tries', async () => {
    const fails = vi.fn(() => { throw new Error('AI is down'); });
    const { bot, target } = build({ sources: [list('a', [STORIES[0]!])], cuts: [cut('ai', fails, 'ai')] });
    await bot.run();
    await bot.run();
    await bot.run();
    await bot.run();
    expect(fails).toHaveBeenCalledTimes(3);
    expect(target.posts).toHaveLength(0);
    expect((await bot.status()).queued).toBe(0);
  });
  it('approval can reject', async () => {
    const { bot, target } = build({ approve: (d) => !d.item.title.includes('metro'), pace: { perRun: 3 } });
    await bot.run();
    expect(target.posts.map((p) => p.url)).not.toContain('https://n.test/1');
    expect(target.posts).toHaveLength(2);
  });
});

describe('pace and timing', () => {
  it('waiting items are not lost', async () => {
    let served = false;
    const once = { name: 'once', read: async () => { if (served) return []; served = true; return STORIES; } };
    const { bot, target } = build({ sources: [once] });
    const r = await bot.run();
    expect(r.queued).toBe(2);
    await bot.run();
    await bot.run();
    expect(target.posts).toHaveLength(3);
    expect((await bot.status()).queued).toBe(0);
  });
  it('keeps a daily limit', async () => {
    const { bot, target, advance } = build({ pace: { perRun: 1, perDay: 2 } });
    await bot.run();
    await bot.run();
    await bot.run();
    expect(target.posts).toHaveLength(2);
    advance(25 * 3_600_000);
    await bot.run();
    expect(target.posts).toHaveLength(3);
  });
  it('keeps a gap between posts', async () => {
    const { bot, target, advance } = build({ pace: { gap: '1h' } });
    await bot.run();
    await bot.run();
    expect(target.posts).toHaveLength(1);
    advance(3_600_001);
    await bot.run();
    expect(target.posts).toHaveLength(2);
  });
  it('respects quiet hours', async () => {
    const { bot, target } = build({ quiet: { from: '11:00', to: '13:00', tz: 'UTC' } });
    const r = await bot.run();
    expect(r.skipped).toBe('quiet hours');
    expect(target.posts).toHaveLength(0);
  });
  it('two runs at once cannot both post', async () => {
    const { bot, target } = build();
    const [a, b] = await Promise.all([bot.run(), bot.run()]);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
    expect(target.posts).toHaveLength(1);
  });
  it('a lock from a crashed run expires', async () => {
    const { bot, store, target } = build();
    expect(await store.acquire!('run-test', -1)).toBe(true);
    await bot.run();
    expect(target.posts).toHaveLength(1);
  });
});

describe('preview', () => {
  it('shows drafts and changes nothing', async () => {
    const { bot, target, store } = build();
    const r = await bot.preview();
    expect(r.drafts).toHaveLength(3);
    expect(r.drafts[0]!.posts[0]!.parts[0]).toContain('n.test');
    expect(target.posts).toHaveLength(0);
    expect(await store.all('seen')).toEqual([]);
    expect(await store.all('deliveries')).toEqual([]);
    expect(await store.all('queue')).toEqual([]);
  });
  it('skips paid AI unless asked', async () => {
    const ai = vi.fn((item) => ({ ...item, post: 'rewritten' }));
    const { bot } = build({ cuts: [cut('ai', ai, 'ai')] });
    await bot.preview();
    expect(ai).not.toHaveBeenCalled();
    const r = await bot.preview({ ai: true, limit: 1 });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(r.drafts[0]!.posts[0]!.parts[0]).toContain('rewritten');
  });
  it('reports character counts per network', async () => {
    const short = recordingTarget({ name: 'short', limits: { maxChars: 20 } });
    const { bot } = build({ targets: [short, recordingTarget({ name: 'long' })] });
    const r = await bot.preview({ limit: 1 });
    const s = r.drafts[0]!.posts.find((p) => p.target === 'short')!;
    expect(s.chars[0]).toBeLessThanOrEqual(20);
    expect(s.maxChars).toBe(20);
    expect(r.drafts[0]!.posts).toHaveLength(2);
  });
});

describe('crash safety', () => {
  it('a crash mid-send never double posts on a network without idempotency', async () => {
    const store = memoryStore();
    let die = true;
    const crashing = recordingTarget({ onPublish: () => { if (die) throw new Crash(); } });
    class Crash extends Error {}
    const bot = katana({ name: 'test', sources: [list('n', STORIES)], targets: [crashing], store, now: () => NOW });
    await bot.run();
    die = false;
    const [d] = await deliveries(store);
    expect(d!.status).toBe('unknown');
    await bot.run();
    const after = await deliveries(store);
    expect(after.find((x) => x.id === d!.id)!.status).toBe('unknown');
    expect(crashing.posts.map((p) => p.key)).not.toContain(d!.key);
  });
  it('recovers a delivery left in sending by a hard kill: unknown, or retried when safe', async () => {
    for (const idempotent of [false, true]) {
      const store = memoryStore();
      const target = recordingTarget({ idempotent });
      const bot = katana({ name: 'test', sources: [list('n', [])], targets: [target], store, now: () => NOW, retry: { baseDelay: 0 } });
      const post = { key: 'k', parts: ['x'], media: [], idempotencyKey: 'i' };
      const stuck: Delivery = { id: 'k::recording', key: 'k', title: 'x', target: 'recording', status: 'sending', attempts: 1, post, progress: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
      await store.put('deliveries', stuck.id, stuck);
      await bot.run();
      const after = (await deliveries(store))[0]!;
      expect(after.status).toBe(idempotent ? 'sent' : 'unknown');
      expect(target.posts).toHaveLength(idempotent ? 1 : 0);
    }
  });
  it('marks items seen before sending, so a crash cannot re-pick them', async () => {
    const store = memoryStore();
    let seenAtPublish: unknown;
    const target = recordingTarget({ onPublish: async (post) => { seenAtPublish = await store.get('seen', post.key); } });
    const bot = katana({ name: 'test', sources: [list('n', STORIES)], targets: [target], store, now: () => NOW });
    await bot.run();
    expect(seenAtPublish).toMatchObject({ status: 'posted' });
  });
  it('retries a rate limit later and only for the network that failed', async () => {
    const a = recordingTarget({ name: 'a' });
    const b = recordingTarget({ name: 'b' });
    b.failNext('transient');
    const { bot, store, advance } = build({ targets: [a, b], sources: [list('n', [STORIES[0]!])], retry: { baseDelay: '1m' } });
    await bot.run();
    expect(a.posts).toHaveLength(1);
    expect(b.posts).toHaveLength(0);
    const waiting = (await deliveries(store)).find((d) => d.target === 'b')!;
    expect(waiting.status).toBe('retry');
    await bot.run();
    expect(b.posts).toHaveLength(0);
    advance(61_000);
    await bot.run();
    expect(a.posts).toHaveLength(1);
    expect(b.posts).toHaveLength(1);
  });
  it('honours Retry-After when longer than the backoff', async () => {
    const t = recordingTarget();
    const { PublishError } = await import('../src/types.js');
    t.failNext(new PublishError('slow down', 'transient', 429, 3_600_000));
    const { bot, store } = build({ targets: [t], retry: { baseDelay: '1m' } });
    await bot.run();
    const [d] = await deliveries(store);
    expect(Date.parse(d!.nextAt!)).toBe(NOW.getTime() + 3_600_000);
  });
  it('an unclear failure on a network without idempotency waits for a human', async () => {
    const t = recordingTarget();
    t.failNext('ambiguous');
    const { bot, store } = build({ targets: [t], sources: [list('n', [STORIES[0]!])] });
    await bot.run();
    await bot.run();
    expect(t.posts).toHaveLength(0);
    const status = await bot.status();
    expect(status.needsAttention).toHaveLength(1);
    const id = status.needsAttention[0]!.id;
    await bot.resolve(id, 'retry');
    await bot.run();
    expect(t.posts).toHaveLength(1);
    expect((await store.get<Delivery>('deliveries', id))!.status).toBe('sent');
  });
  it('an unclear failure retries itself where the network dedupes', async () => {
    const t = recordingTarget({ idempotent: true });
    t.failNext('ambiguous');
    const { bot, advance } = build({ targets: [t], sources: [list('n', [STORIES[0]!])], retry: { baseDelay: '1m' } });
    await bot.run();
    advance(61_000);
    await bot.run();
    expect(t.posts).toHaveLength(1);
  });
  it('a rejected post is not retried', async () => {
    const t = recordingTarget();
    t.failNext('rejected');
    const { bot, store } = build({ targets: [t], sources: [list('n', [STORIES[0]!])], retry: { baseDelay: 0 } });
    await bot.run();
    await bot.run();
    expect(t.posts).toHaveLength(0);
    expect((await deliveries(store))[0]!.status).toBe('failed');
  });
  it('gives up after the maximum attempts', async () => {
    const t = recordingTarget();
    t.failNext('transient', 'transient', 'transient');
    const { bot, store } = build({ targets: [t], sources: [list('n', [STORIES[0]!])], retry: { baseDelay: 0, maxAttempts: 2 } });
    await bot.run();
    await bot.run();
    await bot.run();
    expect((await deliveries(store))[0]!.status).toBe('failed');
    expect(t.posts).toHaveLength(0);
  });
  it('missing credentials wait for a fix without burning attempts', async () => {
    const t = recordingTarget();
    t.failNext(new ConfigError('Missing TOKEN'), new ConfigError('Missing TOKEN'));
    const { bot, store } = build({ targets: [t], sources: [list('n', [STORIES[0]!])], retry: { maxAttempts: 1 } });
    await bot.run();
    await bot.run();
    const [d] = await deliveries(store);
    expect(d!.status).toBe('retry');
    expect(d!.attempts).toBe(0);
    await bot.run();
    expect(t.posts).toHaveLength(1);
  });
  it('resumes a half-published thread from where it stopped', async () => {
    const published: string[] = [];
    let failAt = 1;
    const threadTarget = {
      ...recordingTarget({ name: 'thread', limits: { maxChars: 40, maxThread: 5 } }),
      async publish(post: any, ctx: any) {
        const ids = [...ctx.resume];
        for (let i = ids.length; i < post.parts.length; i++) {
          if (i === failAt) { failAt = -1; const { PublishError } = await import('../src/types.js'); throw new PublishError('rate limited', 'transient', 429); }
          published.push(post.parts[i]);
          ids.push(`id${i}`);
          await ctx.checkpoint(`id${i}`);
        }
        return { id: ids[0], ids };
      },
    };
    const long = 'First sentence is right here. Second sentence is right here. Third sentence is right here.';
    const bot = katana({ name: 't', sources: [list('n', [{ title: long, url: 'https://n.test/thread-x' }])], targets: [threadTarget], store: memoryStore(), now: () => NOW, retry: { baseDelay: 0 } });
    await bot.run();
    expect(published).toHaveLength(1);
    await bot.run();
    expect(new Set(published).size).toBe(published.length);
    expect(published.length).toBeGreaterThan(1);
  });
});

describe('composition', () => {
  it('adds credit, link and tags and stays in the limit', async () => {
    const t = recordingTarget({ limits: { maxChars: 80 } });
    const { bot } = build({ targets: [t], sources: [list('n', [{ title: 'word '.repeat(50).trim(), url: 'https://n.test/a', credit: 'News', tags: ['kyiv', 'k y i v!'] }])] });
    await bot.run();
    const text = t.posts[0]!.parts[0]!;
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text).toContain('via News: https://n.test/a');
  });
  it('shows required photo credit and drops it when no image can be attached', async () => {
    const media = [{ url: 'https://i.test/a.jpg', credit: 'Ann (CC BY 2.0)', creditRequired: true }];
    const withImages = recordingTarget({ name: 'img' });
    const noImages = recordingTarget({ name: 'noimg', limits: { maxMedia: 0 } });
    const { bot } = build({ targets: [withImages, noImages], sources: [list('n', [{ title: 'A headline with a photo', media }])] });
    await bot.run();
    expect(withImages.posts[0]!.parts[0]).toContain('Photo: Ann (CC BY 2.0)');
    expect(noImages.posts[0]!.parts[0]).not.toContain('Photo:');
    expect(noImages.posts[0]!.media).toEqual([]);
  });
  it('leaves links out where a network is set not to carry them', async () => {
    const t = recordingTarget({ limits: { links: false } });
    const { bot } = build({ targets: [t], sources: [list('n', [{ title: 'A plain headline here', url: 'https://n.test/a' }])] });
    await bot.run();
    expect(t.posts[0]!.parts[0]).not.toContain('https://');
  });
  it('strips tracking from links that get posted', async () => {
    const t = recordingTarget();
    const { bot } = build({ targets: [t], sources: [list('n', [{ title: 'A plain headline here', url: 'https://www.bbc.co.uk/news/a?id=7&at_medium=RSS&utm_source=x' }])] });
    await bot.run();
    expect(t.posts[0]!.parts[0]).toContain('https://www.bbc.co.uk/news/a?id=7');
    expect(t.posts[0]!.parts[0]).not.toContain('at_medium');
  });
  it('the automation label is added', async () => {
    const { bot, target } = build({ compose: { label: '🤖' } });
    await bot.run();
    expect(target.posts[0]!.parts[0]).toContain('🤖');
  });
  it('each target gets a stable idempotency key of its own', async () => {
    const a = recordingTarget({ name: 'a' });
    const b = recordingTarget({ name: 'b' });
    const { bot } = build({ targets: [a, b] });
    await bot.run();
    expect(a.posts[0]!.idempotencyKey).not.toBe(b.posts[0]!.idempotencyKey);
    expect(a.posts[0]!.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('configuration', () => {
  it('explains mistakes', () => {
    expect(() => katana({ name: '', sources: [], targets: [] })).toThrow(ConfigError);
    expect(() => katana({ name: 'x', sources: [], targets: [recordingTarget()] })).toThrow(/source/);
    expect(() => katana({ name: 'x', sources: [list('a', [])], targets: [] })).toThrow(/target/);
    expect(() => katana({ name: 'x', sources: [list('a', [])], targets: [recordingTarget(), recordingTarget()] })).toThrow(/unique/);
  });
  it('start needs a schedule', async () => {
    await expect(build().bot.start()).rejects.toThrow(/schedule/);
  });
  it('start runs until told to stop', async () => {
    const stop = new AbortController();
    const { every } = await import('../src/schedule.js');
    const { bot, target } = build({ schedule: every('1m') });
    const running = bot.start({ signal: stop.signal });
    await vi.waitFor(() => expect(target.posts).toHaveLength(1));
    stop.abort();
    await running;
  });
});
