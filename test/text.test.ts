import { describe, expect, it } from 'vitest';
import { bskyRichText, canonicalUrl, countBluesky, countGraphemes, countMastodon, countThreads, countX, displayUrl, findUrls, fit, similarity, truncate } from '../src/text/index.js';

describe('counting', () => {
  it('counts graphemes, not code units', () => {
    expect(countGraphemes('👨‍👩‍👧‍👦')).toBe(1);
    expect(countGraphemes('🇺🇦')).toBe(1);
    expect(countGraphemes('Київ')).toBe(4);
    expect('👨‍👩‍👧‍👦'.length).toBeGreaterThan(5);
  });
  it('weighs text the way X does', () => {
    expect(countX('hello')).toBe(5);
    expect(countX('Київ')).toBe(4);
    expect(countX('日本語')).toBe(6);
    expect(countX('👍')).toBe(2);
    expect(countX('👨‍👩‍👧‍👦')).toBe(2);
    expect(countX('see https://example.com/a/very/long/path/that/goes/on')).toBe(4 + 23);
  });
  it('counts Mastodon URLs as 23', () => {
    expect(countMastodon('https://example.com/really/long/path/here/and/more')).toBe(23);
  });
  it('keeps trailing punctuation out of URLs', () => {
    expect(findUrls('see https://a.com/x. And (https://b.com/y), ok')[0]!.url).toBe('https://a.com/x');
    expect(findUrls('see (https://b.com/y), ok')[0]!.url).toBe('https://b.com/y');
    expect(findUrls('wiki https://en.wikipedia.org/wiki/Foo_(bar) ok')[0]!.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(countMastodon('https://example.com/really/long/path/here/and/more.')).toBe(24);
  });
  it('counts Threads emoji as bytes', () => {
    expect(countThreads('hi')).toBe(2);
    expect(countThreads('👍')).toBe(4);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => expect(truncate('short', 10, countGraphemes)).toBe('short'));
  it('prefers a sentence end', () => {
    const text = 'The first sentence is here. The second sentence runs on for much longer than allowed.';
    expect(truncate(text, 40, countGraphemes)).toBe('The first sentence is here.');
  });
  it('falls back to a word boundary with an ellipsis', () => {
    const out = truncate('one two three four five six seven', 15, countGraphemes);
    expect(out.endsWith('…')).toBe(true);
    expect(countGraphemes(out)).toBeLessThanOrEqual(15);
    expect(out).toBe('one two three…');
  });
  it('never splits an emoji', () => {
    const out = truncate('👨‍👩‍👧‍👦'.repeat(10), 5, countGraphemes);
    expect(countGraphemes(out)).toBeLessThanOrEqual(5);
    expect(out.replace('…', '').length % '👨‍👩‍👧‍👦'.length).toBe(0);
  });
  it('handles text with no spaces, like Japanese', () => {
    const out = truncate('あ'.repeat(100), 10, countX);
    expect(countX(out)).toBeLessThanOrEqual(10);
  });
});

describe('fit', () => {
  const count = countGraphemes;
  it('returns one post when it fits', () => {
    expect(fit('Hello', { maxChars: 50, count, suffix: 'https://a.com' })).toEqual(['Hello\n\nhttps://a.com']);
  });
  it('keeps the suffix whole when truncating', () => {
    const [post] = fit('word '.repeat(100), { maxChars: 60, count, suffix: 'https://a.com/x' });
    expect(post!.endsWith('https://a.com/x')).toBe(true);
    expect(count(post!)).toBeLessThanOrEqual(60);
  });
  it('splits into a numbered thread on sentence boundaries', () => {
    const body = 'First sentence is here. Second sentence is here. Third sentence is here. Fourth one too.';
    const parts = fit(body, { maxChars: 40, count, maxThread: 5, suffix: 'https://a.com' });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(count(p)).toBeLessThanOrEqual(40);
    expect(parts[0]).toContain('1/');
    expect(parts.at(-1)).toContain('https://a.com');
  });
  it('respects the thread limit without exceeding the size limit', () => {
    const body = 'Sentence number here. '.repeat(40);
    const parts = fit(body, { maxChars: 60, count, maxThread: 3, suffix: 'https://a.com' });
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(count(p)).toBeLessThanOrEqual(60);
    expect(parts[2]).toContain('https://a.com');
  });
  it('fits even with X weighting and Ukrainian text', () => {
    const body = 'Президент провів зустріч у Києві. '.repeat(20);
    const [p] = fit(body, { maxChars: 280, count: countX, suffix: 'via Новини: https://example.com/article/12345' });
    expect(countX(p!)).toBeLessThanOrEqual(280);
    expect(p).toContain('https://example.com/article/12345');
  });
});

describe('Bluesky rich text', () => {
  it('uses UTF-8 byte offsets, not character offsets', () => {
    const { text, facets } = bskyRichText('Київ 🇺🇦 https://example.com/a');
    const bytes = new TextEncoder().encode(text);
    const f = facets[0]!;
    expect(new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd))).toBe('example.com/a');
    expect(f.features[0]).toEqual({ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/a' });
  });
  it('shortens long links for display but links to the full URL', () => {
    const url = 'https://www.example.com/a/very/long/path/that/keeps/going/on/and/on';
    const { text, facets } = bskyRichText(`Read ${url}`);
    expect(text).toBe(`Read ${displayUrl(url)}`);
    expect(text.length).toBeLessThan(url.length);
    expect((facets[0]!.features[0] as { uri: string }).uri).toBe(url);
    expect(countBluesky(`Read ${url}`)).toBe(countGraphemes(text));
  });
  it('detects hashtags with their own offsets and leaves out numbers', () => {
    const { text, facets } = bskyRichText('Новини #Україна and #123 https://a.com #tech');
    const tags = facets.filter((f) => f.features[0]!.$type.endsWith('#tag'));
    expect(tags.map((t) => (t.features[0] as { tag: string }).tag)).toEqual(['Україна', 'tech']);
    const bytes = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(bytes.slice(tags[0]!.index.byteStart, tags[0]!.index.byteEnd))).toBe('#Україна');
    expect(facets.map((f) => f.index.byteStart)).toEqual([...facets.map((f) => f.index.byteStart)].sort((a, b) => a - b));
  });
});

describe('similarity', () => {
  it('matches near-identical headlines in any language', () => {
    expect(similarity('Президент України відвідав Київ сьогодні', 'Президент України сьогодні відвідав Київ')).toBeGreaterThan(0.72);
    expect(similarity('Apple launches new iPhone 20 today', 'Apple launches new iPhone 20 today!')).toBe(1);
    expect(similarity('東京で大雨警報が発表されました', '東京で大雨警報が発表された')).toBeGreaterThan(0.72);
  });
  it('tells different stories apart', () => {
    expect(similarity('Apple launches new iPhone', 'Earthquake hits Japan coast')).toBeLessThan(0.3);
    expect(similarity('Президент відвідав Київ', 'Новий футбольний чемпіонат почався')).toBeLessThan(0.3);
  });
});

describe('canonicalUrl', () => {
  it('treats tracking variants as the same article', () => {
    const a = canonicalUrl('https://www.example.com/story/?utm_source=x&utm_medium=y#top');
    const b = canonicalUrl('http://example.com/story?fbclid=abc');
    expect(a).toBe(b);
  });
  it('keeps meaningful parameters', () => {
    expect(canonicalUrl('https://example.com/item?id=5&utm_source=x')).toBe('https://example.com/item?id=5');
    expect(canonicalUrl('https://example.com/item?id=5')).not.toBe(canonicalUrl('https://example.com/item?id=6'));
  });
});
