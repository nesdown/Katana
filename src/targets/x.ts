import { optionalEnv, env } from '../env.js';
import { sleep } from '../duration.js';
import { countX } from '../text/count.js';
import type { Ctx, PublishCtx, Target } from '../types.js';
import { blob, jsonHeaders, loadImages, publishParts } from './shared.js';

export interface XOptions {
  name?: string;
  /** OAuth 1.0a user keys. Default to X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET. */
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  accessSecret?: string;
  /** OAuth 2.0 user token, used instead of the four keys. Defaults to X_BEARER_TOKEN. */
  bearer?: string;
  /** Link posts can cost much more on X's pay-per-use plan. `false` leaves links out. */
  links?: boolean;
  threads?: number;
  baseUrl?: string;
}

const API = 'https://api.x.com/2';
const IMAGE_MAX_BYTES = 5_000_000;

const percent = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Signs a request with OAuth 1.0a. Only URL query parameters are signed; JSON and multipart bodies are not. */
export async function oauth1Header(
  method: string,
  url: string,
  keys: { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string },
  nonce = crypto.randomUUID().replace(/-/g, ''),
  timestamp = Math.floor(Date.now() / 1000).toString(),
): Promise<string> {
  const parsed = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: keys.accessToken,
    oauth_version: '1.0',
  };
  const pairs = [...Object.entries(oauth), ...parsed.searchParams.entries()]
    .map(([k, v]) => [percent(k), percent(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1));
  const base = [
    method.toUpperCase(),
    percent(`${parsed.origin}${parsed.pathname}`),
    percent(pairs.map(([k, v]) => `${k}=${v}`).join('&')),
  ].join('&');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${percent(keys.apiSecret)}&${percent(keys.accessSecret)}`),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  oauth.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `OAuth ${Object.entries(oauth).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${percent(k)}="${percent(v)}"`).join(', ')}`;
}

export function x(options: XOptions = {}): Target {
  const base = options.baseUrl ?? API;

  const authHeader = async (method: string, url: string): Promise<string> => {
    const bearer = options.bearer ?? optionalEnv('X_BEARER_TOKEN');
    if (bearer) return `Bearer ${bearer}`;
    return oauth1Header(method, url, {
      apiKey: options.apiKey ?? env('X_API_KEY'),
      apiSecret: options.apiSecret ?? env('X_API_SECRET'),
      accessToken: options.accessToken ?? env('X_ACCESS_TOKEN'),
      accessSecret: options.accessSecret ?? env('X_ACCESS_SECRET'),
    });
  };

  const call = async <T>(ctx: Ctx, method: string, url: string, init: RequestInit = {}) => {
    const res = await ctx.http.request(url, {
      ...init,
      method,
      headers: { ...(init.headers as Record<string, string>), authorization: await authHeader(method, url) },
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  };

  async function uploadImage(data: Uint8Array, mime: string, ctx: PublishCtx): Promise<string> {
    const started = await call<{ data: { id: string } }>(ctx, 'POST', `${base}/media/upload/initialize`, {
      headers: jsonHeaders(),
      body: JSON.stringify({ media_type: mime, total_bytes: data.byteLength, media_category: 'tweet_image' }),
    });
    const id = started.data.id;
    const form = new FormData();
    form.append('segment_index', '0');
    form.append('media', blob(data, mime));
    await call(ctx, 'POST', `${base}/media/upload/${id}/append`, { body: form });
    const done = await call<{ data: { processing_info?: { state: string; check_after_secs?: number } } }>(ctx, 'POST', `${base}/media/upload/${id}/finalize`);
    let info = done.data?.processing_info;
    for (let i = 0; info && info.state !== 'succeeded' && i < 20; i++) {
      if (info.state === 'failed') throw new Error('X could not process the image');
      await sleep((info.check_after_secs ?? 1) * 1000);
      const status = await call<{ data: { processing_info?: { state: string; check_after_secs?: number } } }>(ctx, 'GET', `${base}/media/upload?command=STATUS&media_id=${id}`);
      info = status.data?.processing_info;
    }
    return id;
  }

  return {
    name: options.name ?? 'x',
    limits: { maxChars: 280, count: countX, maxMedia: 4, links: options.links ?? true, maxThread: options.threads ?? 1 },

    async check(ctx) {
      const me = await call<{ data: { username: string } }>(ctx, 'GET', `${base}/users/me`);
      return `signed in as @${me.data.username}`;
    },

    async publish(post, ctx) {
      const mediaIds: string[] = [];
      if (!ctx.resume.length) {
        for (const image of await loadImages(post.media, ctx, 4, IMAGE_MAX_BYTES)) {
          try {
            mediaIds.push(await uploadImage(image.data, image.mime, ctx));
          } catch (err) {
            ctx.log.warn(`Posting to X without image: ${(err as Error).message}`);
          }
        }
      }
      const ids = await publishParts(post, ctx, async (text, index, previousId) => {
        const res = await call<{ data: { id: string } }>(ctx, 'POST', `${base}/tweets`, {
          headers: jsonHeaders(),
          body: JSON.stringify({
            text,
            ...(index === 0 && mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
            ...(previousId ? { reply: { in_reply_to_tweet_id: previousId } } : {}),
          }),
        });
        return res.data.id;
      });
      return { id: ids[0]!, url: `https://x.com/i/status/${ids[0]}`, ids };
    },
  };
}
