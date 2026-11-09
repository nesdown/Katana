import { compose, type ComposeOptions } from './compose.js';
import { ms, sleep, type Duration } from './duration.js';
import { Http, classifyFailure, type HttpOptions } from './http.js';
import { silentLogger, type Logger } from './log.js';
import { isQuiet, type QuietHours, type Schedule } from './schedule.js';
import { memoryStore } from './stores/index.js';
import { normalize, similarity } from './text/similarity.js';
import { canonicalUrl, cleanUrl } from './text/url.js';
import {
  ConfigError, drop, isDropped,
  type Ctx, type Cut, type CutLike, type Delivery, type Dropped, type Item, type Post,
  type PublishCtx, type RawItem, type Receipt, type Source, type Store, type Target,
} from './types.js';

export type PickStrategy = 'fair' | 'newest' | 'oldest' | 'random' | ((items: Item[]) => Item[]);

export interface KatanaConfig {
  name: string;
  sources: Source[];
  cuts?: CutLike[];
  targets: Target[];
  /** Where memory lives. Defaults to memory only, so set this for any real bot. */
  store?: Store;
  schedule?: Schedule;
  pick?: PickStrategy;
  pace?: {
    /** New items per run. Default 1. */
    perRun?: number;
    /** New items per rolling 24 hours. */
    perDay?: number;
    /** Least time between new items. */
    gap?: Duration;
  };
  quiet?: QuietHours;
  /** Ignore items older than this. Default 3 days, so a first run does not post old news. */
  maxAge?: Duration | false;
  dedupe?: {
    /** How alike two headlines must be to count as the same story, 0 to 1. Default 0.72. */
    similarity?: number | false;
    /** How far back to compare. Default 14 days. */
    window?: Duration;
  };
  compose?: ComposeOptions;
  /** Last check before publishing. Return false to reject the item for good. */
  approve?: (draft: Draft) => boolean | Promise<boolean>;
  retry?: { maxAttempts?: number; baseDelay?: Duration };
  http?: HttpOptions;
  log?: Logger;
  now?: () => Date;
  onDelivery?: (delivery: Delivery) => void | Promise<void>;
}

export interface Draft {
  item: Item;
  posts: Array<{ target: string; parts: string[]; chars: number[]; maxChars: number; media: number }>;
}

export type Outcome = 'posted' | 'draft' | 'rejected' | 'duplicate' | 'dropped' | 'error';

export interface TraceEntry {
  key: string;
  title: string;
  source: string;
  outcome: Outcome;
  reason?: string;
}

export interface RunReport {
  bot: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  skipped?: string;
  read: Array<{ source: string; items: number; error?: string }>;
  fresh: number;
  queued: number;
  trace: TraceEntry[];
  drafts: Draft[];
  deliveries: Delivery[];
  errors: string[];
}

export interface PreviewOptions {
  /** How many items to draft. Default 5. */
  limit?: number;
  /** Run AI cuts, which cost money. Off by default. */
  ai?: boolean;
}

export interface Status {
  bot: string;
  seen: number;
  queued: number;
  sentLast24h: number;
  deliveries: Delivery[];
  needsAttention: Delivery[];
}

interface SeenRecord {
  title: string;
  status: 'posted' | 'dropped' | 'rejected' | 'failed';
  reason?: string;
  at: string;
}

interface QueueEntry {
  item: Omit<Item, 'publishedAt'> & { publishedAt?: string };
  failures: number;
  queuedAt: string;
}

const SEEN = 'seen';
const DELIVERIES = 'deliveries';
const QUEUE = 'queue';
const QUEUE_MAX = 200;
const LOCK_TTL = 30 * 60_000;
const SEEN_KEEP_MS = 180 * 86_400_000;
const DELIVERY_KEEP_MS = 30 * 86_400_000;
const CUT_FAILURE_LIMIT = 3;

const normalizeCut = (c: CutLike, index: number): Cut =>
  typeof c === 'function' ? { name: c.name || `cut${index + 1}`, apply: c, kind: 'pure' } : c;

export function itemKey(raw: Pick<RawItem, 'key' | 'url' | 'title'>): string {
  return raw.key ?? (raw.url ? canonicalUrl(raw.url) : `title:${normalize(raw.title)}`);
}

function pickOrder(items: Item[], strategy: PickStrategy): Item[] {
  if (typeof strategy === 'function') return strategy(items);
  const byNewest = [...items].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  if (strategy === 'newest') return byNewest;
  if (strategy === 'oldest') return byNewest.reverse();
  if (strategy === 'random') {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    return shuffled;
  }
  // Fair: one from each source in turn, newest first, so one busy feed cannot drown the rest.
  const groups = new Map<string, Item[]>();
  for (const item of byNewest) groups.set(item.source, [...(groups.get(item.source) ?? []), item]);
  const lanes = [...groups.values()];
  const out: Item[] = [];
  for (let i = 0; out.length < items.length; i++) {
    for (const lane of lanes) if (lane[i]) out.push(lane[i]!);
  }
  return out;
}

export class Katana {
  readonly name: string;
  readonly store: Store;
  private readonly config: KatanaConfig;
  private readonly cuts: Cut[];
  private readonly http: Http;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly lockName: string;

  constructor(config: KatanaConfig) {
    if (!config.name) throw new ConfigError('A bot needs a name.');
    if (!config.sources?.length) throw new ConfigError(`${config.name}: add at least one source.`);
    if (!config.targets?.length) throw new ConfigError(`${config.name}: add at least one target.`);
    const names = config.targets.map((t) => t.name);
    const repeated = names.find((n, i) => names.indexOf(n) !== i);
    if (repeated) throw new ConfigError(`${config.name}: two targets are named "${repeated}". Give each a unique name.`);
    this.config = config;
    this.name = config.name;
    this.store = config.store ?? memoryStore();
    this.cuts = (config.cuts ?? []).map(normalizeCut);
    this.log = config.log ?? silentLogger;
    this.http = new Http({ log: this.log, ...config.http });
    this.now = config.now ?? (() => new Date());
    this.lockName = `run-${config.name.replace(/[^\w-]/g, '_')}`;
  }

  get targets(): readonly Target[] {
    return this.config.targets;
  }

  get schedule(): Schedule | undefined {
    return this.config.schedule;
  }

  ctx(dryRun: boolean): Ctx {
    return { bot: this.name, http: this.http, log: this.log, dryRun, now: this.now };
  }

  /** One full pass: retry what is due, read sources, publish. Call this from cron or a serverless function. */
  async run(): Promise<RunReport> {
    return this.execute({ dryRun: false });
  }

  /** Shows exactly what would be posted. Writes nothing and posts nothing. */
  async preview(options: PreviewOptions = {}): Promise<RunReport> {
    return this.execute({ dryRun: true, limit: options.limit ?? 5, ai: options.ai ?? false });
  }

  /** Runs on the schedule until the signal aborts. */
  async start(options: { signal?: AbortSignal; runOnStart?: boolean } = {}): Promise<void> {
    const schedule = this.config.schedule;
    if (!schedule) throw new ConfigError(`${this.name}: add a schedule, or call run() from your own cron.`);
    const { signal } = options;
    this.log.info(`${this.name}: running ${schedule.describe}`);
    let first = options.runOnStart ?? true;
    while (!signal?.aborted) {
      if (!first) {
        const wait = schedule.next(this.now()).getTime() - this.now().getTime();
        try {
          await sleep(Math.max(0, wait), signal);
        } catch {
          return;
        }
      }
      first = false;
      try {
        await this.run();
      } catch (err) {
        this.log.error(`${this.name}: run failed: ${(err as Error).message}`);
      }
    }
  }

  async status(): Promise<Status> {
    const deliveries = (await this.store.all<Delivery>(DELIVERIES)).map(([, d]) => d);
    const since = this.now().getTime() - 86_400_000;
    return {
      bot: this.name,
      seen: (await this.store.all(SEEN)).length,
      queued: (await this.store.all(QUEUE)).length,
      sentLast24h: new Set(deliveries.filter((d) => d.status === 'sent' && Date.parse(d.updatedAt) >= since).map((d) => d.key)).size,
      deliveries,
      needsAttention: deliveries.filter((d) => d.status === 'unknown' || d.status === 'failed'),
    };
  }

  /** Settles a delivery a human has checked: mark it sent, retry it, or give up on it. */
  async resolve(id: string, decision: 'sent' | 'retry' | 'failed'): Promise<Delivery> {
    const delivery = await this.store.get<Delivery>(DELIVERIES, id);
    if (!delivery) throw new Error(`No delivery with id "${id}". Run: katana status`);
    delivery.status = decision;
    delivery.nextAt = undefined;
    delivery.updatedAt = this.now().toISOString();
    await this.store.put(DELIVERIES, id, delivery);
    return delivery;
  }

  // -------------------------------------------------------------- the pipeline

  private async execute(mode: { dryRun: boolean; limit?: number; ai?: boolean }): Promise<RunReport> {
    const { dryRun } = mode;
    const report: RunReport = {
      bot: this.name, dryRun, startedAt: this.now().toISOString(), finishedAt: '',
      read: [], fresh: 0, queued: 0, trace: [], drafts: [], deliveries: [], errors: [],
    };
    const finish = () => {
      report.finishedAt = this.now().toISOString();
      return report;
    };

    if (!dryRun && this.config.quiet && isQuiet(this.now(), this.config.quiet)) {
      report.skipped = 'quiet hours';
      return finish();
    }
    if (!dryRun && this.store.acquire && !(await this.store.acquire(this.lockName, LOCK_TTL))) {
      report.skipped = 'another run is still going';
      this.log.warn(`${this.name}: another run is still going, skipping this one`);
      return finish();
    }

    try {
      if (!dryRun) {
        await this.recoverInterrupted();
        await this.sendDueRetries(report);
      }
      const candidates = await this.gather(report);
      const budget = dryRun ? mode.limit! : await this.remainingBudget();
      const leftover = await this.process(candidates, budget, mode, report);
      if (!dryRun) {
        await this.saveQueue(leftover);
        await this.prune();
      }
      report.queued = leftover.length;
      return finish();
    } finally {
      if (!dryRun) await this.store.release?.(this.lockName);
    }
  }

  /** A crash mid-send leaves a delivery in `sending`. Only the network knows if it went out. */
  private async recoverInterrupted(): Promise<void> {
    for (const [id, d] of await this.store.all<Delivery>(DELIVERIES)) {
      if (d.status === 'pending') {
        await this.save({ ...d, status: 'retry', nextAt: undefined });
      } else if (d.status === 'sending') {
        const target = this.targetByName(d.target);
        const safe = target?.idempotent;
        await this.save({
          ...d,
          status: safe ? 'retry' : 'unknown',
          nextAt: undefined,
          error: safe ? d.error : 'The bot stopped while sending. Check the account, then run: katana resolve',
        });
        if (!safe) this.log.warn(`${id}: may or may not have posted. Check the account, then run: katana resolve`);
      }
    }
  }

  private async sendDueRetries(report: RunReport): Promise<void> {
    const nowMs = this.now().getTime();
    for (const [, d] of await this.store.all<Delivery>(DELIVERIES)) {
      if (d.status !== 'retry') continue;
      if (d.nextAt && Date.parse(d.nextAt) > nowMs) continue;
      const target = this.targetByName(d.target);
      if (!target) continue;
      report.deliveries.push(await this.send(d, target));
    }
  }

  private targetByName(name: string) {
    return this.config.targets.find((t) => t.name === name);
  }

  private async gather(report: RunReport): Promise<Item[]> {
    const ctx = this.ctx(report.dryRun);
    const results = await Promise.all(
      this.config.sources.map(async (source) => {
        try {
          const raw = await source.read(ctx);
          report.read.push({ source: source.name, items: raw.length });
          return raw.map((r) => this.hydrate(r, source.name));
        } catch (err) {
          const message = (err as Error).message;
          report.read.push({ source: source.name, items: 0, error: message });
          report.errors.push(`${source.name}: ${message}`);
          this.log.warn(`${source.name}: ${message}`);
          return [];
        }
      }),
    );

    const queued = (await this.store.all<QueueEntry>(QUEUE)).map(([, q]) => ({
      ...q.item,
      publishedAt: q.item.publishedAt ? new Date(q.item.publishedAt) : undefined,
    }));

    const maxAge = this.config.maxAge === false ? Infinity : ms(this.config.maxAge ?? '3d');
    const nowMs = this.now().getTime();
    const unique = new Map<string, Item>();
    for (const item of [...results.flat(), ...queued]) {
      if (unique.has(item.key)) continue;
      if (item.publishedAt && nowMs - item.publishedAt.getTime() > maxAge) continue;
      if (await this.store.get(SEEN, item.key)) continue;
      unique.set(item.key, item);
    }
    report.fresh = unique.size;
    return pickOrder([...unique.values()], this.config.pick ?? 'fair');
  }

  private hydrate(raw: RawItem, source: string): Item {
    return {
      ...raw,
      key: itemKey(raw),
      source,
      title: raw.title.trim(),
      url: raw.url ? cleanUrl(raw.url) : undefined,
      media: raw.media ?? [],
      tags: raw.tags ?? [],
      meta: raw.meta ?? {},
    };
  }

  private async remainingBudget(): Promise<number> {
    const pace = this.config.pace ?? {};
    let budget = pace.perRun ?? 1;
    if (pace.perDay === undefined && pace.gap === undefined) return budget;
    const nowMs = this.now().getTime();
    const sent = (await this.store.all<Delivery>(DELIVERIES)).map(([, d]) => d).filter((d) => d.status === 'sent');
    if (pace.perDay !== undefined) {
      const today = new Set(sent.filter((d) => Date.parse(d.updatedAt) >= nowMs - 86_400_000).map((d) => d.key));
      budget = Math.min(budget, Math.max(0, pace.perDay - today.size));
    }
    if (pace.gap !== undefined) {
      const last = Math.max(0, ...sent.map((d) => Date.parse(d.updatedAt)));
      if (nowMs - last < ms(pace.gap)) budget = 0;
    }
    return budget;
  }

  /** Walks candidates until the budget is spent. AI only runs on items that might really be posted. */
  private async process(candidates: Item[], budget: number, mode: { dryRun: boolean; ai?: boolean }, report: RunReport): Promise<Item[]> {
    const { dryRun } = mode;
    const threshold = this.config.dedupe?.similarity ?? 0.72;
    const windowMs = ms(this.config.dedupe?.window ?? '14d');
    const nowMs = this.now().getTime();
    const recent: string[] = threshold === false ? [] : (await this.store.all<SeenRecord>(SEEN))
      .map(([, s]) => s)
      .filter((s) => s.status === 'posted' && nowMs - Date.parse(s.at) <= windowMs)
      .map((s) => s.title);

    const leftover: Item[] = [];
    let used = 0;
    const ctx = this.ctx(dryRun);

    for (const candidate of candidates) {
      if (used >= budget) {
        leftover.push(candidate);
        continue;
      }
      const entry: TraceEntry = { key: candidate.key, title: candidate.title, source: candidate.source, outcome: 'dropped' };
      report.trace.push(entry);

      if (threshold !== false) {
        const twin = recent.find((title) => similarity(title, candidate.title) >= threshold);
        if (twin) {
          entry.outcome = 'duplicate';
          entry.reason = `same story as "${twin}"`;
          if (!dryRun) await this.markSeen(candidate, 'dropped', entry.reason);
          continue;
        }
      }

      let item: Item | Dropped;
      try {
        item = await this.applyCuts(candidate, ctx, mode.ai ?? true, dryRun);
      } catch (err) {
        const message = (err as Error).message;
        entry.outcome = 'error';
        entry.reason = message;
        report.errors.push(`${candidate.title}: ${message}`);
        this.log.warn(`Could not process "${candidate.title}": ${message}`);
        if (!dryRun) {
          const failures = ((await this.store.get<QueueEntry>(QUEUE, candidate.key))?.failures ?? 0) + 1;
          if (failures >= CUT_FAILURE_LIMIT) await this.markSeen(candidate, 'failed', message);
          else await this.enqueue(candidate, failures);
        }
        continue;
      }

      if (isDropped(item)) {
        entry.outcome = 'dropped';
        entry.reason = item.dropped;
        if (!dryRun) await this.markSeen(candidate, 'dropped', item.dropped);
        continue;
      }

      const posts = new Map<Target, Post>();
      for (const target of this.config.targets) posts.set(target, await compose(item, target, this.config.compose));
      const draft: Draft = {
        item,
        posts: [...posts].map(([target, post]) => ({
          target: target.name,
          parts: post.parts,
          chars: post.parts.map((p) => target.limits.count(p)),
          maxChars: target.limits.maxChars,
          media: post.media.length,
        })),
      };

      if (this.config.approve && !dryRun && !(await this.config.approve(draft))) {
        entry.outcome = 'rejected';
        entry.reason = 'not approved';
        await this.markSeen(candidate, 'rejected', entry.reason);
        continue;
      }

      used++;
      recent.push(candidate.title);
      if (dryRun) {
        entry.outcome = 'draft';
        report.drafts.push(draft);
        continue;
      }

      entry.outcome = 'posted';
      // Recorded before any network call. A crash from here on can never post this item twice.
      await this.markSeen(candidate, 'posted');
      await this.store.delete(QUEUE, candidate.key);
      const created: Array<[Delivery, Target]> = [];
      for (const [target, post] of posts) {
        const delivery = this.newDelivery(item, target, post);
        await this.store.put(DELIVERIES, delivery.id, delivery);
        created.push([delivery, target]);
      }
      const sent = await Promise.all(created.map(([d, t]) => this.send(d, t)));
      report.deliveries.push(...sent);
      if (sent.every((d) => d.status !== 'sent' && d.status !== 'retry')) {
        entry.outcome = 'error';
        entry.reason = sent.map((d) => d.error).filter(Boolean).join('; ');
      }
    }
    return leftover;
  }

  private async applyCuts(start: Item, ctx: Ctx, runAi: boolean, dryRun: boolean): Promise<Item | Dropped> {
    let item = start;
    for (const c of this.cuts) {
      if (c.kind === 'ai' && !runAi) continue;
      const result = await c.apply(item, ctx);
      if (isDropped(result)) return result;
      if (result === null) return drop(`removed by ${c.name}`);
      if (result) item = result;
    }
    if (dryRun) ctx.log.info(`drafted: ${item.title}`);
    return item;
  }

  private newDelivery(item: Item, target: Target, post: Post): Delivery {
    const at = this.now().toISOString();
    return {
      id: `${item.key}::${target.name}`,
      key: item.key,
      title: item.title,
      target: target.name,
      status: 'pending',
      attempts: 0,
      post,
      progress: [],
      createdAt: at,
      updatedAt: at,
    };
  }

  private async send(start: Delivery, target: Target): Promise<Delivery> {
    let delivery: Delivery = { ...start, status: 'sending', attempts: start.attempts + 1, nextAt: undefined, updatedAt: this.now().toISOString() };
    await this.store.put(DELIVERIES, delivery.id, delivery);

    const ctx: PublishCtx = {
      ...this.ctx(false),
      resume: [...delivery.progress],
      checkpoint: async (id) => {
        delivery = { ...delivery, progress: [...delivery.progress, id], updatedAt: this.now().toISOString() };
        await this.store.put(DELIVERIES, delivery.id, delivery);
      },
    };

    try {
      const receipt: Receipt = await target.publish(delivery.post, ctx);
      delivery = { ...delivery, status: 'sent', receipt, error: undefined };
      this.log.info(`${target.name}: posted "${delivery.title}"${receipt.url ? ` ${receipt.url}` : ''}`);
    } catch (err) {
      delivery = this.afterFailure(delivery, target, err);
    }
    delivery.updatedAt = this.now().toISOString();
    await this.store.put(DELIVERIES, delivery.id, delivery);
    await this.config.onDelivery?.(delivery);
    return delivery;
  }

  /** The heart of crash safety: only retry when a retry cannot create a duplicate. */
  private afterFailure(delivery: Delivery, target: Target, err: unknown): Delivery {
    if (err instanceof ConfigError) {
      // Nothing reached the network, so fix the setting and the next run picks it up.
      this.log.error(`${target.name}: ${err.message}`);
      return { ...delivery, status: 'retry', error: err.message, attempts: delivery.attempts - 1, nextAt: undefined };
    }
    const failure = classifyFailure(err, target.name);
    const maxAttempts = this.config.retry?.maxAttempts ?? 5;
    const safeToRetry = failure.kind === 'transient' || (failure.kind === 'ambiguous' && target.idempotent);

    if (failure.kind === 'ambiguous' && !target.idempotent) {
      this.log.warn(`${delivery.id}: unclear whether it posted. Check the account, then run: katana resolve`);
      return { ...delivery, status: 'unknown', error: failure.message };
    }
    if (!safeToRetry || delivery.attempts >= maxAttempts) {
      this.log.error(failure.message);
      return { ...delivery, status: 'failed', error: failure.message };
    }
    const base = ms(this.config.retry?.baseDelay ?? '5m');
    const delay = Math.max(failure.retryAfterMs ?? 0, base * 2 ** (delivery.attempts - 1));
    this.log.warn(`${failure.message}. Will retry.`);
    return { ...delivery, status: 'retry', error: failure.message, nextAt: new Date(this.now().getTime() + delay).toISOString() };
  }

  private save(delivery: Delivery) {
    return this.store.put(DELIVERIES, delivery.id, { ...delivery, updatedAt: this.now().toISOString() });
  }

  private markSeen(item: Item, status: SeenRecord['status'], reason?: string) {
    return Promise.all([
      this.store.put<SeenRecord>(SEEN, item.key, { title: item.title, status, reason, at: this.now().toISOString() }),
      this.store.delete(QUEUE, item.key),
    ]);
  }

  private enqueue(item: Item, failures = 0) {
    const entry: QueueEntry = {
      item: { ...item, publishedAt: item.publishedAt?.toISOString(), media: item.media.map(({ data: _d, ...m }) => m) },
      failures,
      queuedAt: this.now().toISOString(),
    };
    return this.store.put(QUEUE, item.key, entry);
  }

  /** Items not reached this run wait in a queue, so a slow pace never loses stories. */
  private async saveQueue(leftover: Item[]): Promise<void> {
    const keep = leftover.slice(0, QUEUE_MAX);
    const existing = new Map(await this.store.all<QueueEntry>(QUEUE));
    const keys = new Set(keep.map((i) => i.key));
    for (const item of keep) await this.enqueue(item, existing.get(item.key)?.failures ?? 0);
    for (const [key, entry] of existing) {
      // Entries with failures were queued on purpose by this run and stay.
      if (!keys.has(key) && !entry.failures) await this.store.delete(QUEUE, key);
    }
  }

  private async prune(): Promise<void> {
    const nowMs = this.now().getTime();
    for (const [key, record] of await this.store.all<SeenRecord>(SEEN)) {
      if (nowMs - Date.parse(record.at) > SEEN_KEEP_MS) await this.store.delete(SEEN, key);
    }
    for (const [key, d] of await this.store.all<Delivery>(DELIVERIES)) {
      if (d.status === 'sent' && nowMs - Date.parse(d.updatedAt) > DELIVERY_KEEP_MS) await this.store.delete(DELIVERIES, key);
    }
  }
}

/** Creates a bot. */
export const katana = (config: KatanaConfig): Katana => new Katana(config);
