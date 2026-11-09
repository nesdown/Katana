import { ConfigError } from './types.js';

export type Duration = number | string;

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parses `90s`, `30m`, `1h30m`, `2d`. Numbers are milliseconds. */
export function ms(value: Duration): number {
  if (typeof value === 'number') return value;
  const parts = [...value.trim().matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g)];
  const consumed = parts.map((p) => p[0]).join('').replace(/\s/g, '');
  if (!parts.length || consumed !== value.replace(/\s/g, '')) {
    throw new ConfigError(`Cannot read duration "${value}". Try "30m", "1h30m" or "2d".`);
  }
  return parts.reduce((sum, p) => sum + Number(p[1]) * UNITS[p[2]!]!, 0);
}

export const sleep = (duration: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, duration);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
