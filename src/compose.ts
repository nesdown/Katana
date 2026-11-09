import { fit } from './text/fit.js';
import { sha256 } from './text/url.js';
import type { Item, Limits, Post, Target } from './types.js';

export interface ComposeOptions {
  /** Add `via Source`. On by default, because credit is how bots stay welcome. */
  credit?: boolean;
  /** Most hashtags per post. */
  maxHashtags?: number;
  /** Text that marks the account as automated, for example `🤖`. */
  label?: string;
  /** Full control over the body text, per target. */
  format?: (item: Item, target: Target) => string;
  /** Number thread parts like `1/3`. */
  numbered?: boolean;
}

const tagify = (tag: string) => `#${tag.replace(/[^\p{L}\p{N}_]/gu, '')}`;

function suffixFor(item: Item, limits: Limits, options: ComposeOptions, includeTags: boolean): string {
  const lines: string[] = [];
  const source = options.credit === false ? undefined : item.credit;
  const link = limits.links ? item.url : undefined;
  if (source && link) lines.push(`via ${source}: ${link}`);
  else if (source) lines.push(`via ${source}`);
  else if (link) lines.push(link);

  const required = limits.maxMedia > 0 ? item.media.slice(0, limits.maxMedia).filter((m) => m.creditRequired && m.credit) : [];
  for (const media of required) lines.push(`Photo: ${media.credit}`);

  const tags = includeTags ? [...new Set(item.tags)].slice(0, options.maxHashtags ?? 2).map(tagify).filter((t) => t.length > 1) : [];
  const tail = [...tags, options.label].filter(Boolean).join(' ');
  if (tail) lines.push(tail);
  return lines.join('\n');
}

/** Turns an item into a finished post that fits one target's rules. */
export async function compose(item: Item, target: Target, options: ComposeOptions = {}): Promise<Post> {
  const { limits } = target;
  const body = options.format?.(item, target) ?? item.post ?? item.title;
  let suffix = suffixFor(item, limits, options, true);
  if (limits.count(suffix) > limits.maxChars / 2) suffix = suffixFor(item, limits, options, false);
  const parts = fit(body, {
    maxChars: limits.maxChars,
    count: limits.count,
    suffix,
    maxThread: limits.maxThread,
    numbered: options.numbered ?? true,
  });
  return {
    key: item.key,
    parts,
    url: item.url,
    title: item.title,
    description: item.body?.slice(0, 280),
    media: item.media.slice(0, limits.maxMedia).map(({ data: _data, ...rest }) => rest),
    lang: item.lang,
    idempotencyKey: (await sha256(`${item.key}|${target.name}`)).slice(0, 32),
  };
}
