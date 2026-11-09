import { DOMParser, parseHTML } from 'linkedom';
import type { Ctx, Media, RawItem, Source } from '../types.js';
import { resolveUrl } from '../text/url.js';

export const stripHtml = (html: string | null | undefined): string => {
  if (!html) return '';
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  document.querySelectorAll('script,style,noscript').forEach((n: Element) => n.remove());
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim();
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const parseDate = (value: string | null | undefined): Date | undefined => {
  if (!value) return undefined;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const isImage = (url: string, type?: string | null, medium?: string | null) =>
  medium === 'image' || !!type?.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url);

// ---------------------------------------------------------------- feeds

const child = (el: Element, ...names: string[]): Element | undefined => {
  for (const name of names) {
    for (const node of Array.from(el.getElementsByTagName(name))) {
      if (node.parentNode === el) return node;
    }
  }
  return undefined;
};
const childText = (el: Element, ...names: string[]) => child(el, ...names)?.textContent?.trim() || undefined;

function feedMedia(entry: Element, html: string | undefined, base: string): Media[] {
  const found: Media[] = [];
  const add = (url: string | null | undefined, alt?: string) => {
    const resolved = resolveUrl(url, base);
    if (resolved && !found.some((m) => m.url === resolved)) found.push({ url: resolved, alt });
  };
  for (const node of Array.from(entry.getElementsByTagName('media:content'))) {
    const url = node.getAttribute('url');
    if (url && isImage(url, node.getAttribute('type'), node.getAttribute('medium'))) add(url);
  }
  for (const node of Array.from(entry.getElementsByTagName('media:thumbnail'))) add(node.getAttribute('url'));
  for (const node of Array.from(entry.getElementsByTagName('enclosure'))) {
    const url = node.getAttribute('url');
    if (url && isImage(url, node.getAttribute('type'))) add(url);
  }
  if (!found.length && html) {
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    const img = document.querySelector('img');
    if (img) add(img.getAttribute('src'), img.getAttribute('alt') ?? undefined);
  }
  return found;
}

/** Parses RSS 2.0, RSS 1.0 and Atom. */
export function parseFeed(xml: string, base: string): { title?: string; items: RawItem[] } {
  const doc = new DOMParser().parseFromString(xml.replace(/^﻿/, '').trimStart(), 'text/xml');
  const entries = [...Array.from(doc.getElementsByTagName('item')), ...Array.from(doc.getElementsByTagName('entry'))] as Element[];
  const channel = (doc.getElementsByTagName('channel')[0] ?? doc.documentElement) as Element | null;
  const items: RawItem[] = [];

  for (const entry of entries) {
    const title = stripHtml(childText(entry, 'title'));
    if (!title) continue;
    const links = Array.from(entry.getElementsByTagName('link')).filter((l) => l.parentNode === entry);
    const atomLink = links.find((l) => l.getAttribute('href') && (l.getAttribute('rel') ?? 'alternate') === 'alternate');
    const rawLink = atomLink?.getAttribute('href') ?? links[0]?.textContent?.trim() ?? childText(entry, 'guid');
    const html = childText(entry, 'content:encoded', 'content') ?? childText(entry, 'description', 'summary');
    const summary = childText(entry, 'description', 'summary') ?? html;
    const author = childText(entry, 'dc:creator', 'author');
    items.push({
      title,
      url: resolveUrl(rawLink, base),
      body: stripHtml(summary) || undefined,
      media: feedMedia(entry, html, base),
      publishedAt: parseDate(childText(entry, 'pubDate', 'published', 'updated', 'dc:date')),
      author: author ? stripHtml(author) : undefined,
      tags: Array.from(entry.getElementsByTagName('category'))
        .map((c) => c.getAttribute('term') ?? c.textContent?.trim() ?? '')
        .filter(Boolean),
    });
  }
  return { title: channel ? childText(channel, 'title') : undefined, items };
}

export interface FeedOptions {
  name?: string;
  credit?: string | false;
  limit?: number;
}

/** Reads an RSS or Atom feed. */
export function rss(url: string, options: FeedOptions = {}): Source {
  return {
    name: options.name ?? hostOf(url),
    async read(ctx) {
      const feed = parseFeed(await ctx.http.page(url), url);
      const credit = options.credit === false ? undefined : options.credit ?? feed.title;
      return feed.items.slice(0, options.limit ?? 50).map((i) => ({ ...i, credit }));
    },
  };
}

// ---------------------------------------------------------------- web pages

/** `h2 a` reads text, `a@href` reads an attribute. */
export type Selector = string;

export interface HtmlOptions {
  name?: string;
  /** The repeating element. Omit to let Katana find headlines on its own. */
  item?: string;
  title?: Selector;
  link?: Selector;
  text?: Selector;
  image?: Selector;
  date?: Selector;
  credit?: string | false;
  limit?: number;
}

function read(root: Element | Document, selector: Selector | undefined): string | undefined {
  if (!selector) return undefined;
  const [css, attr] = selector.split('@') as [string, string | undefined];
  const el = css ? root.querySelector(css) : (root as Element);
  if (!el) return undefined;
  const value = attr ? el.getAttribute(attr) : el.textContent;
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

const NOISE = 'nav, footer, header nav, aside, [role="navigation"], [class*="cookie" i], [class*="menu" i]';

function guessHeadlines(document: Document, base: string, limit: number): RawItem[] {
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const push = (title: string | undefined, href: string | null | undefined, scope?: Element | null) => {
    const url = resolveUrl(href, base);
    const clean = title?.replace(/\s+/g, ' ').trim();
    if (!clean || !url || clean.split(' ').length < 3 || seen.has(url)) return;
    seen.add(url);
    const img = scope?.querySelector('img');
    const src = resolveUrl(img?.getAttribute('src'), base);
    items.push({
      title: clean,
      url,
      body: read(scope ?? document, 'p'),
      media: src ? [{ url: src, alt: img?.getAttribute('alt') ?? undefined }] : [],
      publishedAt: parseDate(scope?.querySelector('time')?.getAttribute('datetime')),
    });
  };
  document.querySelectorAll(NOISE).forEach((n: Element) => n.remove());
  document.querySelectorAll('article').forEach((article: Element) => {
    const link = article.querySelector('h1 a, h2 a, h3 a, h4 a') ?? article.querySelector('a[href]');
    const heading = article.querySelector('h1, h2, h3, h4');
    push(heading?.textContent ?? link?.textContent ?? undefined, link?.getAttribute('href'), article);
  });
  if (!items.length) {
    document.querySelectorAll('h1 a, h2 a, h3 a, a h1, a h2, a h3').forEach((el: Element) => {
      const link = el.tagName === 'A' ? el : el.closest('a');
      push(el.textContent ?? undefined, link?.getAttribute('href'), el.closest('li, div, section'));
    });
  }
  return items.slice(0, limit);
}

/** Parses listing HTML with selectors, or finds headlines itself when `item` is omitted. */
export function parseListing(htmlText: string, base: string, options: HtmlOptions = {}): RawItem[] {
  const { document } = parseHTML(htmlText);
  const limit = options.limit ?? 30;
  if (!options.item) return guessHeadlines(document as unknown as Document, base, limit);

  const items: RawItem[] = [];
  for (const node of Array.from(document.querySelectorAll(options.item)) as Element[]) {
    const link = read(node, options.link ?? 'a@href');
    const title = read(node, options.title ?? 'h1, h2, h3, h4, a');
    if (!title) continue;
    const image = resolveUrl(read(node, options.image ?? 'img@src'), base);
    items.push({
      title,
      url: resolveUrl(link, base),
      body: read(node, options.text),
      media: image ? [{ url: image }] : [],
      publishedAt: parseDate(read(node, options.date ?? 'time@datetime')),
    });
    if (items.length >= limit) break;
  }
  return items;
}

/** Reads a web page. Replaces the old "take links 15 to 20" approach with real selectors. */
export function html(url: string, options: HtmlOptions = {}): Source {
  return {
    name: options.name ?? hostOf(url),
    async read(ctx) {
      const items = parseListing(await ctx.http.page(url), url, options);
      const credit = options.credit === false ? undefined : options.credit ?? hostOf(url);
      return items.map((i) => ({ ...i, credit }));
    },
  };
}

const FEED_TYPES = 'link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]';

/** Point it at any site. Uses the site's feed when it has one, otherwise reads headlines from the page. */
export function web(url: string, options: FeedOptions = {}): Source {
  return {
    name: options.name ?? hostOf(url),
    async read(ctx) {
      const body = await ctx.http.page(url);
      if (/^\s*(<\?xml|<rss|<feed)/.test(body)) {
        const feed = parseFeed(body, url);
        const credit = options.credit === false ? undefined : options.credit ?? feed.title;
        return feed.items.slice(0, options.limit ?? 50).map((i) => ({ ...i, credit }));
      }
      const { document } = parseHTML(body);
      const href = resolveUrl(document.querySelector(FEED_TYPES)?.getAttribute('href'), url);
      if (href) {
        ctx.log.info(`${hostOf(url)}: found a feed, using it`);
        return rss(href, options).read(ctx);
      }
      const credit = options.credit === false ? undefined : options.credit ?? hostOf(url);
      return parseListing(body, url, { limit: options.limit }).map((i) => ({ ...i, credit }));
    },
  };
}

// ---------------------------------------------------------------- JSON and custom

export interface JsonOptions<T> {
  name?: string;
  /** Dot path to the list, such as `data.children`, or a function. */
  items?: string | ((body: any) => T[]);
  map(entry: T): RawItem | null | undefined;
  headers?: Record<string, string>;
}

/** Reads any JSON API. */
export function json<T = any>(url: string, options: JsonOptions<T>): Source {
  return {
    name: options.name ?? hostOf(url),
    async read(ctx) {
      if (!(await ctx.http.allowedByRobots(url))) throw new Error(`robots.txt asks bots not to read ${url}`);
      const body = await ctx.http.json(url, { retries: 2, headers: options.headers });
      const list =
        typeof options.items === 'function'
          ? options.items(body)
          : (options.items ?? '').split('.').filter(Boolean).reduce((o: any, k) => o?.[k], body);
      if (!Array.isArray(list)) throw new Error(`${url}: expected a list at "${options.items ?? '(root)'}"`);
      return list.map(options.map).filter((x): x is RawItem => !!x);
    },
  };
}

/** Wraps your own function as a source: a database, a spreadsheet, anything. */
export function from(name: string, read: (ctx: Ctx) => RawItem[] | Promise<RawItem[]>): Source {
  return { name, read: async (ctx) => read(ctx) };
}

/** A fixed list of posts. Useful for evergreen content and demos. */
export const list = (name: string, entries: Array<string | RawItem>): Source =>
  from(name, () => entries.map((e) => (typeof e === 'string' ? { title: e } : e)));
