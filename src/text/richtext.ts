import { URL_PATTERN, countGraphemes, trimUrl } from './count.js';

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >;
}

const DISPLAY_MAX = 30;

/** `https://www.example.com/a/very/long/path` becomes `example.com/a/very/long/pa…`. */
export function displayUrl(url: string): string {
  const short = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  return short.length > DISPLAY_MAX ? `${short.slice(0, DISPLAY_MAX - 1)}…` : short;
}

const shorten = (text: string) =>
  text.replace(URL_PATTERN, (raw) => {
    const url = trimUrl(raw);
    return displayUrl(url) + raw.slice(url.length);
  });

/** Bluesky counts what readers see, so links count at their shortened length. */
export const countBluesky = (text: string): number => countGraphemes(shorten(text));

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/**
 * Builds Bluesky text with shortened links and facets. Bluesky does not detect links on its
 * own, and facet positions are UTF-8 bytes rather than characters.
 */
export function bskyRichText(input: string): { text: string; facets: Facet[] } {
  const facets: Facet[] = [];
  let text = '';
  let last = 0;
  for (const match of input.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    text += input.slice(last, match.index);
    const label = displayUrl(url);
    const byteStart = byteLength(text);
    text += label;
    facets.push({
      index: { byteStart, byteEnd: byteStart + byteLength(label) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    });
    last = match.index + url.length;
  }
  text += input.slice(last);

  for (const match of text.matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const tag = match[2]!;
    if (/^\d+$/.test(tag)) continue;
    const start = match.index + match[1]!.length;
    const byteStart = byteLength(text.slice(0, start));
    facets.push({
      index: { byteStart, byteEnd: byteStart + byteLength(`#${tag}`) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    });
  }
  facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
  return { text, facets };
}
