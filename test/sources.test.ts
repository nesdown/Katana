import { describe, expect, it } from 'vitest';
import { Http } from '../src/http.js';
import { silentLogger } from '../src/log.js';
import { from, html, json, list, parseFeed, parseListing, rss, stripHtml, web } from '../src/sources/index.js';
import { fakeFetch } from '../src/testing.js';
import type { Ctx } from '../src/types.js';

const ctxFor = (routes: Parameters<typeof fakeFetch>[0]): Ctx => ({
  bot: 't', dryRun: false, log: silentLogger, now: () => new Date(),
  http: new Http({ fetch: fakeFetch(routes).fetch, hostDelayMs: 0 }),
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Kyiv News &amp; Views</title><link>https://k.test</link>
<item><title><![CDATA[Метро <b>відкрили</b> знову]]></title><link>https://k.test/a?utm_source=rss</link>
<description><![CDATA[<p>Short <em>summary</em>.</p><img src="/inline.jpg" alt="inline"/>]]></description>
<dc:creator>Олена</dc:creator><pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate><category>transport</category></item>
<item><title>With media</title><link>https://k.test/b</link><media:content url="https://k.test/m.jpg" medium="image"/><media:content url="https://k.test/v.mp4" medium="video"/></item>
<item><title>With enclosure</title><guid>https://k.test/c</guid><enclosure url="https://k.test/e.png" type="image/png"/></item>
<item><title></title><link>https://k.test/empty</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Blog</title>
<entry><title type="html">A &lt;i&gt;styled&lt;/i&gt; title</title><link rel="self" href="https://a.test/self"/><link rel="alternate" href="/post/1"/>
<updated>2026-11-09T10:00:00Z</updated><summary>Sum</summary><author><name>Ann</name></author><category term="tech"/></entry></feed>`;

describe('feeds', () => {
  it('reads RSS with CDATA, namespaces and images', () => {
    const { title, items } = parseFeed(RSS, 'https://k.test/feed');
    expect(title).toBe('Kyiv News & Views');
    expect(items).toHaveLength(3);
    expect(items[0]!).toMatchObject({ title: 'Метро відкрили знову', body: 'Short summary.', author: 'Олена', tags: ['transport'] });
    expect(items[0]!.media![0]).toEqual({ url: 'https://k.test/inline.jpg', alt: 'inline' });
    expect(items[0]!.publishedAt?.toISOString()).toBe('2026-11-09T10:00:00.000Z');
    expect(items[1]!.media).toEqual([{ url: 'https://k.test/m.jpg', alt: undefined }]);
    expect(items[2]!.url).toBe('https://k.test/c');
    expect(items[2]!.media![0]!.url).toBe('https://k.test/e.png');
  });
  it('reads Atom', () => {
    const { title, items } = parseFeed(ATOM, 'https://a.test/feed');
    expect(title).toBe('Atom Blog');
    expect(items[0]!).toMatchObject({ title: 'A styled title', url: 'https://a.test/post/1', body: 'Sum', tags: ['tech'] });
  });
  it('survives junk', () => {
    expect(parseFeed('not xml at all', 'https://a.test').items).toEqual([]);
    expect(parseFeed('', 'https://a.test').items).toEqual([]);
  });
  it('ignores javascript links', () => {
    const { items } = parseFeed('<rss><channel><item><title>x y z</title><link>javascript:alert(1)</link></item></channel></rss>', 'https://a.test');
    expect(items[0]!.url).toBeUndefined();
  });
  it('credits the feed by name', async () => {
    const items = await rss('https://k.test/feed').read(ctxFor({ 'https://k.test/feed': RSS }));
    expect(items[0]!.credit).toBe('Kyiv News & Views');
  });
});

const PAGE = `<html><body><nav><h3><a href="/about">About our great company here</a></h3></nav>
<article><h2><a href="/s/1">First big headline of the day</a></h2><p>Lead one.</p><img src="/1.jpg" alt="pic"/><time datetime="2026-11-09T08:00:00Z">today</time></article>
<article><h2><a href="https://other.test/s/2">Second big headline right here</a></h2></article>
<footer><h3><a href="/x">Footer link with enough words</a></h3></footer></body></html>`;

describe('web pages', () => {
  it('reads with selectors, including attributes', () => {
    const items = parseListing(PAGE, 'https://n.test/', { item: 'article', title: 'h2', link: 'h2 a@href', text: 'p', image: 'img@src' });
    expect(items).toHaveLength(2);
    expect(items[0]!).toMatchObject({ title: 'First big headline of the day', url: 'https://n.test/s/1', body: 'Lead one.' });
    expect(items[0]!.media![0]!.url).toBe('https://n.test/1.jpg');
    expect(items[0]!.publishedAt?.getUTCHours()).toBe(8);
  });
  it('finds headlines without selectors and skips navigation', () => {
    const items = parseListing(PAGE, 'https://n.test/');
    expect(items.map((i) => i.title)).toEqual(['First big headline of the day', 'Second big headline right here']);
  });
  it('falls back to heading links when there are no articles', () => {
    const items = parseListing('<main><div><h2><a href="/a">A real headline here</a></h2></div><li><a href="/b"><h3>Another real headline here</h3></a></li><h2><a href="/c">Hi</a></h2></main>', 'https://n.test/');
    expect(items.map((i) => i.url)).toEqual(['https://n.test/a', 'https://n.test/b']);
  });
  it('html() credits the site', async () => {
    const items = await html('https://www.n.test/news', {}).read(ctxFor({ 'https://www.n.test/news': PAGE }));
    expect(items[0]!.credit).toBe('n.test');
  });
  it('strips tags and scripts', () => {
    expect(stripHtml('<p>a <script>evil()</script><b>b</b></p>')).toBe('a b');
  });
});

describe('web() auto detection', () => {
  it('discovers a feed from the page', async () => {
    const items = await web('https://k.test/').read(ctxFor({
      'https://k.test/feed.xml': RSS,
      'https://k.test/': '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
    }));
    expect(items[0]!.credit).toBe('Kyiv News & Views');
  });
  it('recognises a feed URL directly', async () => {
    const items = await web('https://a.test/feed').read(ctxFor({ 'https://a.test/feed': ATOM }));
    expect(items).toHaveLength(1);
  });
  it('falls back to reading the page', async () => {
    const items = await web('https://n.test/').read(ctxFor({ 'https://n.test/': PAGE }));
    expect(items).toHaveLength(2);
  });
});

describe('JSON and custom', () => {
  it('reads a nested list', async () => {
    const items = await json('https://j.test/api', {
      items: 'data.children',
      map: (c: any) => ({ title: c.t, url: c.u }),
    }).read(ctxFor({ 'https://j.test/api': { data: { children: [{ t: 'Hi', u: 'https://j.test/1' }] } } }));
    expect(items).toEqual([{ title: 'Hi', url: 'https://j.test/1' }]);
  });
  it('explains a wrong path', async () => {
    await expect(json('https://j.test/api', { items: 'nope', map: (x: any) => x }).read(ctxFor({ 'https://j.test/api': {} }))).rejects.toThrow(/expected a list/);
  });
  it('wraps functions and lists', async () => {
    const ctx = ctxFor({});
    expect(await from('f', () => [{ title: 'x' }]).read(ctx)).toEqual([{ title: 'x' }]);
    expect(await list('l', ['a', { title: 'b' }]).read(ctx)).toEqual([{ title: 'a' }, { title: 'b' }]);
  });
});
