const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gu;

/** Trailing punctuation is almost never part of a URL. */
export function trimUrl(url: string): string {
  let out = url.replace(/[.,;:!?…»”’]+$/u, '');
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1).replace(/[.,;:!?]+$/u, '');
  }
  return out;
}

export function findUrls(text: string): Array<{ url: string; index: number }> {
  return [...text.matchAll(URL_PATTERN)].map((m) => ({ url: trimUrl(m[0]), index: m.index }));
}

export function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

/** User-visible characters. How Bluesky counts. */
export function countGraphemes(text: string): number {
  let n = 0;
  for (const _ of graphemeSegmenter.segment(text)) n++;
  return n;
}

function replaceUrls(text: string, weigh: (url: string) => string): string {
  return text.replace(URL_PATTERN, (raw) => {
    const url = trimUrl(raw);
    return weigh(url) + raw.slice(url.length);
  });
}

/** Mastodon counts every URL as 23 characters. */
export function countMastodon(text: string): number {
  return countGraphemes(replaceUrls(text, () => 'x'.repeat(23)));
}

const X_LIGHT_RANGES: Array<[number, number]> = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];

const isEmojiCluster = (cluster: string) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(cluster);

/** X weighted count: Latin and Cyrillic weigh 1, CJK and emoji weigh 2, URLs weigh 23. */
export function countX(text: string): number {
  let weight = 0;
  for (const cluster of graphemes(replaceUrls(text, () => '\u0000'.repeat(23)))) {
    if (isEmojiCluster(cluster)) {
      weight += 2;
      continue;
    }
    for (const char of cluster) {
      const code = char.codePointAt(0)!;
      weight += X_LIGHT_RANGES.some(([lo, hi]) => code >= lo && code <= hi) ? 1 : 2;
    }
  }
  return weight;
}

/** Threads counts emoji by UTF-8 byte length, per its docs. */
export function countThreads(text: string): number {
  const encoder = new TextEncoder();
  let n = 0;
  for (const cluster of graphemes(text)) n += isEmojiCluster(cluster) ? encoder.encode(cluster).length : 1;
  return n;
}

export const countCodeUnits = (text: string): number => text.length;
