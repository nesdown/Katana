/** Lowercases, removes punctuation and folds whitespace, in any script. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(text: string): Set<string> {
  const padded = ` ${text} `;
  const chars = Array.from(padded);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(''));
  return out;
}

const words = (text: string) => new Set(text.split(' ').filter(Boolean));

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * 0 to 1 likeness of two headlines. Works without language data, so Ukrainian, Japanese and
 * English behave alike. Takes the stronger of two signals so reordered headlines still match.
 */
export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return Math.max(dice(trigrams(x), trigrams(y)), dice(words(x), words(y)));
}
