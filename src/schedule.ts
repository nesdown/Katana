import { ms, type Duration } from './duration.js';
import { ConfigError } from './types.js';

export interface Schedule {
  next(from: Date): Date;
  describe: string;
}

/** Runs on a fixed rhythm. Jitter keeps the timing from looking mechanical. */
export function every(interval: Duration, options: { jitter?: Duration } = {}): Schedule {
  const gap = ms(interval);
  if (gap < 60_000) throw new ConfigError('Runs less than a minute apart are unkind to the sites you read.');
  const jitter = options.jitter ? ms(options.jitter) : 0;
  return {
    describe: `every ${interval}${options.jitter ? ` (give or take ${options.jitter})` : ''}`,
    next: (from) => new Date(from.getTime() + gap + (jitter ? Math.round((Math.random() * 2 - 1) * jitter) : 0)),
  };
}

function parts(date: Date, timeZone?: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => f.find((p) => p.type === type)!.value;
  return {
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function field(spec: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const piece of spec.split(',')) {
    const m = piece.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new ConfigError(`Cannot read cron ${name} "${spec}".`);
    const [lo, hi] = m[1] === '*' ? [min, max] : m[1]!.includes('-') ? m[1]!.split('-').map(Number) as [number, number] : [Number(m[1]), m[2] ? max : Number(m[1])];
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new ConfigError(`Cron ${name} "${spec}" is out of range.`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const FIVE_YEARS_MINUTES = 5 * 366 * 1440;

/** Standard five-field cron, optionally in a time zone: `cron('0 9 * * 1-5', { tz: 'Europe/Kyiv' })`. */
export function cron(expression: string, options: { tz?: string } = {}): Schedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new ConfigError(`Cron needs five fields, got "${expression}".`);
  const minute = field(fields[0]!, 0, 59, 'minute');
  const hour = field(fields[1]!, 0, 23, 'hour');
  const dom = field(fields[2]!, 1, 31, 'day of month');
  const month = field(fields[3]!, 1, 12, 'month');
  const dow = new Set([...field(fields[4]!, 0, 7, 'day of week')].map((d) => d % 7));
  const domAny = fields[2] === '*';
  const dowAny = fields[4] === '*';

  return {
    describe: `cron ${expression}${options.tz ? ` in ${options.tz}` : ''}`,
    next(from) {
      let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
      for (let i = 0; i < FIVE_YEARS_MINUTES; i++) {
        const p = parts(new Date(t), options.tz);
        // Cron rule: when both day fields are set, either one may match.
        const dayOk = domAny && dowAny ? true : domAny ? dow.has(p.weekday) : dowAny ? dom.has(p.day) : dom.has(p.day) || dow.has(p.weekday);
        if (!month.has(p.month) || !dayOk) {
          t += 3_600_000 - (t % 3_600_000);
          continue;
        }
        if (hour.has(p.hour) && minute.has(p.minute)) return new Date(t);
        t += 60_000;
      }
      throw new ConfigError(`Cron "${expression}" never matches.`);
    },
  };
}

/** Once a day at a local time. `daily('09:30', { tz: 'Europe/Kyiv' })`. */
export function daily(time: string, options: { tz?: string } = {}): Schedule {
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new ConfigError(`Cannot read time "${time}". Try "09:30".`);
  return cron(`${Number(m[2])} ${Number(m[1])} * * *`, options);
}

export interface QuietHours {
  from: string;
  to: string;
  tz?: string;
}

/** True during quiet hours. Handles ranges that cross midnight. */
export function isQuiet(date: Date, quiet: QuietHours): boolean {
  const toMinutes = (s: string) => {
    const [h, m] = s.split(':').map(Number) as [number, number];
    return h * 60 + (m ?? 0);
  };
  const p = parts(date, quiet.tz);
  const now = p.hour * 60 + p.minute;
  const from = toMinutes(quiet.from);
  const to = toMinutes(quiet.to);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}
