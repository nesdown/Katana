import type { Http } from './http.js';
import type { Logger } from './log.js';

/** An image attached to an item. Bytes are only downloaded when a target needs them. */
export interface Media {
  url?: string;
  data?: Uint8Array;
  mime?: string;
  alt?: string;
  /** Human readable credit, for example `Jane Doe (CC BY 2.0)`. */
  credit?: string;
  /** Set when the license requires the credit to appear next to the image. */
  creditRequired?: boolean;
}

/** One unit of content moving through the pipeline. */
export interface Item {
  /** Stable identity used for dedupe. Canonical URL when there is one. */
  key: string;
  source: string;
  title: string;
  /** Source text: feed summary or full article. Never posted directly. */
  body?: string;
  /** The text to publish. Cuts such as `rewrite` set this. Falls back to `title`. */
  post?: string;
  url?: string;
  media: Media[];
  publishedAt?: Date;
  author?: string;
  lang?: string;
  tags: string[];
  /** Short attribution appended to posts, for example `BBC News`. */
  credit?: string;
  meta: Record<string, unknown>;
}

/** What a source returns. Only `title` is required; Katana fills in the rest. */
export type RawItem = Partial<Omit<Item, 'source' | 'title'>> & { title: string };

export interface Ctx {
  bot: string;
  http: Http;
  log: Logger;
  dryRun: boolean;
  now(): Date;
}

export interface Source {
  name: string;
  read(ctx: Ctx): Promise<RawItem[]>;
}

/** Returned by a cut to remove an item from the pipeline. */
export interface Dropped {
  dropped: string;
}
export const drop = (reason: string): Dropped => ({ dropped: reason });
export const isDropped = (x: unknown): x is Dropped =>
  typeof x === 'object' && x !== null && 'dropped' in x;

export type CutResult = Item | Dropped | null | undefined | void;

export interface Cut {
  name: string;
  /** Previews skip cuts marked `sideEffect`. AI and network cuts still run unless `skipPaid` is set. */
  kind?: 'pure' | 'network' | 'ai';
  apply(item: Item, ctx: Ctx): CutResult | Promise<CutResult>;
}

export type CutLike = Cut | ((item: Item, ctx: Ctx) => CutResult | Promise<CutResult>);

/** How a network counts and constrains a post. */
export interface Limits {
  maxChars: number;
  count(text: string): number;
  maxMedia: number;
  /** When false, Katana leaves the link out of the post. */
  links: boolean;
  /** Longest thread the target accepts. 1 means no threads. */
  maxThread: number;
}

/** A finished post, fitted to one target. */
export interface Post {
  key: string;
  /** One entry per post in the thread. Usually one. */
  parts: string[];
  url?: string;
  title?: string;
  description?: string;
  media: Media[];
  lang?: string;
  /** Stable across retries, for networks that support idempotency. */
  idempotencyKey: string;
}

export interface Receipt {
  id: string;
  url?: string;
  /** Every post id when a thread was published. */
  ids?: string[];
}

export interface PublishCtx extends Ctx {
  /** Thread parts already published by an earlier attempt. */
  resume: string[];
  /** Persist a published thread part so a retry continues instead of repeating it. */
  checkpoint(id: string): Promise<void>;
}

export interface Target {
  name: string;
  limits: Limits;
  /** True when retrying after an unclear failure cannot create a duplicate. */
  idempotent?: boolean;
  publish(post: Post, ctx: PublishCtx): Promise<Receipt>;
  /** Read-only credential check, used by `katana doctor`. */
  check?(ctx: Ctx): Promise<string>;
}

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'retry' | 'failed' | 'unknown';

export interface Delivery {
  id: string;
  key: string;
  title: string;
  target: string;
  status: DeliveryStatus;
  attempts: number;
  post: Post;
  progress: string[];
  receipt?: Receipt;
  error?: string;
  nextAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Minimal key/value contract. Implement these four methods to store state anywhere. */
export interface Store {
  get<T>(collection: string, key: string): Promise<T | undefined>;
  put<T>(collection: string, key: string, value: T): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
  all<T>(collection: string): Promise<Array<[string, T]>>;
  /** Optional cross-process lock, so overlapping cron runs cannot double post. */
  acquire?(name: string, ttlMs: number): Promise<boolean>;
  release?(name: string): Promise<void>;
  close?(): Promise<void>;
}

/** Thrown by targets. `kind` decides whether a retry could create a duplicate post. */
export type FailureKind = 'rejected' | 'transient' | 'ambiguous';

export class PublishError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
