import { graphemes } from './count.js';

const ELLIPSIS = '…';
const SENTENCE_END = /[.!?。！？…]["'”’»)]*(?=\s|$)/gu;

/** Largest grapheme prefix of `text` whose count stays within `budget`. */
function prefixWithin(text: string, budget: number, count: (s: string) => number): string {
  const clusters = graphemes(text);
  let lo = 0;
  let hi = clusters.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (count(clusters.slice(0, mid).join('')) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return clusters.slice(0, lo).join('');
}

/** Shortens text to fit, preferring a whole sentence, then a whole word. Never splits an emoji. */
export function truncate(text: string, budget: number, count: (s: string) => number): string {
  if (count(text) <= budget) return text;
  if (budget <= 0) return '';
  const room = budget - count(ELLIPSIS);
  if (room <= 0) return ELLIPSIS;
  const prefix = prefixWithin(text, room, count);

  const sentences = [...prefix.matchAll(SENTENCE_END)];
  const lastSentence = sentences.at(-1);
  if (lastSentence) {
    const end = lastSentence.index + lastSentence[0].length;
    if (end >= prefix.length * 0.6) return prefix.slice(0, end).trimEnd();
  }
  const lastSpace = prefix.search(/\s\S*$/u);
  const cut = lastSpace >= prefix.length * 0.5 ? prefix.slice(0, lastSpace) : prefix;
  return cut.trimEnd().replace(/[,;:\-–—]+$/u, '') + ELLIPSIS;
}

function splitSentences(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    out.push(text.slice(last, end).trim());
    last = end;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

export interface FitOptions {
  maxChars: number;
  count(text: string): number;
  /** Text that must stay intact at the end: links, credits, hashtags. */
  suffix?: string;
  /** Longest thread allowed. 1 means truncate rather than split. */
  maxThread?: number;
  /** Add `1/3` markers to threads. */
  numbered?: boolean;
}

const join = (body: string, suffix: string) => (body && suffix ? `${body}\n\n${suffix}` : body || suffix);

/** Fits a body and an unbreakable suffix into one post or a thread. */
export function fit(body: string, options: FitOptions): string[] {
  const { maxChars, count, suffix = '', maxThread = 1, numbered = true } = options;
  const clean = body.trim();
  const whole = join(clean, suffix);
  if (count(whole) <= maxChars) return [whole];

  const suffixCost = suffix ? count(`\n\n${suffix}`) : 0;
  if (suffixCost >= maxChars) return [truncate(whole, maxChars, count)];
  if (maxThread <= 1) return [join(truncate(clean, maxChars - suffixCost, count), suffix)];

  const markerRoom = numbered ? count(`\n\n${maxThread}/${maxThread}`) : 0;
  const room = maxChars - markerRoom;
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };
  for (const sentence of splitSentences(clean)) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (count(candidate) <= room) {
      current = candidate;
      continue;
    }
    flush();
    let rest = sentence;
    while (count(rest) > room) {
      const piece = prefixWithin(rest, room, count);
      const space = piece.search(/\s\S*$/u);
      const taken = space > piece.length * 0.5 ? piece.slice(0, space) : piece;
      chunks.push(taken.trim());
      rest = rest.slice(taken.length).trim();
    }
    current = rest;
  }
  flush();

  if (suffix) {
    const last = chunks.at(-1);
    if (last !== undefined && count(join(last, suffix)) <= room) chunks[chunks.length - 1] = join(last, suffix);
    else chunks.push(suffix);
  }

  if (chunks.length > maxThread) {
    const kept = chunks.slice(0, maxThread);
    const tailBudget = room - suffixCost;
    const tail = kept[maxThread - 1]!.replace(suffix ? `\n\n${suffix}` : '\u0000', '');
    kept[maxThread - 1] = join(truncate(`${tail} ${chunks[maxThread]}`, tailBudget, count), suffix);
    return numbered ? kept.map((c, i) => `${c}\n\n${i + 1}/${kept.length}`) : kept;
  }
  return numbered && chunks.length > 1 ? chunks.map((c, i) => `${c}\n\n${i + 1}/${chunks.length}`) : chunks;
}
