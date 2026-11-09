import { credential, optionalEnv, env } from '../env.js';
import { countCodeUnits, countGraphemes } from '../text/count.js';
import type { Target } from '../types.js';
import { jsonHeaders, publishParts } from './shared.js';

export interface TelegramOptions {
  name?: string;
  /** Defaults to TELEGRAM_BOT_TOKEN. */
  token?: string;
  /** A channel such as @mychannel, or a chat id. Defaults to TELEGRAM_CHAT_ID. */
  chatId?: string;
  baseUrl?: string;
}

const CAPTION_MAX = 1024;

export function telegram(options: TelegramOptions = {}): Target {
  const token = credential(options.token, 'TELEGRAM_BOT_TOKEN');
  const chat = credential(options.chatId, 'TELEGRAM_CHAT_ID');
  const base = options.baseUrl ?? 'https://api.telegram.org';
  const url = (method: string) => `${base}/bot${token()}/${method}`;

  return {
    name: options.name ?? 'telegram',
    limits: { maxChars: 4096, count: countCodeUnits, maxMedia: 1, links: true, maxThread: 3 },

    async check(ctx) {
      const me = await ctx.http.json<{ result: { username: string } }>(url('getMe'));
      return `signed in as @${me.result.username}`;
    },

    async publish(post, ctx) {
      const photo = post.media.find((m) => m.url)?.url;
      const ids = await publishParts(post, ctx, async (text, index) => {
        const withPhoto = index === 0 && photo && text.length <= CAPTION_MAX;
        const res = await ctx.http.json<{ result: { message_id: number } }>(url(withPhoto ? 'sendPhoto' : 'sendMessage'), {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(
            withPhoto ? { chat_id: chat(), photo, caption: text } : { chat_id: chat(), text },
          ),
        });
        return String(res.result.message_id);
      });
      return { id: ids[0]!, ids };
    },
  };
}

export interface DiscordOptions {
  name?: string;
  /** Webhook URL. Defaults to DISCORD_WEBHOOK_URL. */
  webhook?: string;
  username?: string;
}

export function discord(options: DiscordOptions = {}): Target {
  const hook = credential(options.webhook, 'DISCORD_WEBHOOK_URL');
  return {
    name: options.name ?? 'discord',
    limits: { maxChars: 2000, count: countCodeUnits, maxMedia: 1, links: true, maxThread: 3 },
    async publish(post, ctx) {
      const image = post.media.find((m) => m.url)?.url;
      const ids = await publishParts(post, ctx, async (content, index) => {
        const res = await ctx.http.json<{ id: string }>(`${hook()}?wait=true`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            content,
            username: options.username,
            allowed_mentions: { parse: [] }, // Scraped text must never ping @everyone.
            ...(index === 0 && image ? { embeds: [{ image: { url: image } }] } : {}),
          }),
        });
        return res.id;
      });
      return { id: ids[0]!, ids };
    },
  };
}

export interface SlackOptions {
  name?: string;
  /** Incoming webhook URL. Defaults to SLACK_WEBHOOK_URL. */
  webhook?: string;
}

export function slack(options: SlackOptions = {}): Target {
  const hook = credential(options.webhook, 'SLACK_WEBHOOK_URL');
  return {
    name: options.name ?? 'slack',
    limits: { maxChars: 3000, count: countCodeUnits, maxMedia: 0, links: true, maxThread: 1 },
    async publish(post, ctx) {
      // Escaping stops scraped text from triggering <!channel> style mentions.
      const text = post.parts.join('\n\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await ctx.http.request(hook(), { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ text }) });
      return { id: `${post.key}@${ctx.now().toISOString()}` };
    },
  };
}

export interface LinkedInOptions {
  name?: string;
  /** Defaults to LINKEDIN_TOKEN. Needs w_member_social or w_organization_social. */
  token?: string;
  /** Such as urn:li:person:abc or urn:li:organization:123. Defaults to LINKEDIN_AUTHOR. */
  author?: string;
  /** LinkedIn retires versions regularly. Format YYYYMM. Defaults to LINKEDIN_VERSION or 202610. */
  version?: string;
  baseUrl?: string;
}

/** Escapes characters reserved by LinkedIn's "little text" format. */
const escapeLittleText = (text: string) => text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);

export function linkedin(options: LinkedInOptions = {}): Target {
  const token = credential(options.token, 'LINKEDIN_TOKEN');
  const author = credential(options.author, 'LINKEDIN_AUTHOR');
  const base = options.baseUrl ?? 'https://api.linkedin.com';
  return {
    name: options.name ?? 'linkedin',
    limits: { maxChars: 3000, count: countGraphemes, maxMedia: 0, links: false, maxThread: 1 },
    async publish(post, ctx) {
      const version = options.version ?? optionalEnv('LINKEDIN_VERSION') ?? '202610';
      const res = await ctx.http.request(`${base}/rest/posts`, {
        method: 'POST',
        headers: jsonHeaders({
          authorization: `Bearer ${token()}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'Linkedin-Version': version,
        }),
        body: JSON.stringify({
          author: author(),
          commentary: escapeLittleText(post.parts.join('\n\n')),
          visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
          ...(post.url ? { content: { article: { source: post.url, title: post.title ?? post.url } } } : {}),
        }),
      });
      const id = res.headers.get('x-restli-id');
      if (!id) throw new Error('LinkedIn did not return a post id');
      return { id, url: `https://www.linkedin.com/feed/update/${id}` };
    },
  };
}

export interface WebhookOptions {
  name?: string;
  url?: string;
  /** Signs the body with HMAC-SHA256 in the x-katana-signature header. */
  secret?: string;
  maxChars?: number;
}

/** Sends each post as JSON to any URL: Zapier, n8n, your own backend. */
export function webhook(options: WebhookOptions = {}): Target {
  const endpoint = () => options.url ?? env('KATANA_WEBHOOK_URL');
  return {
    name: options.name ?? 'webhook',
    idempotent: true,
    limits: { maxChars: options.maxChars ?? 10_000, count: countGraphemes, maxMedia: 10, links: true, maxThread: 1 },
    async publish(post, ctx) {
      const body = JSON.stringify({
        idempotencyKey: post.idempotencyKey,
        key: post.key,
        text: post.parts.join('\n\n'),
        parts: post.parts,
        url: post.url,
        title: post.title,
        media: post.media.map(({ url, alt, credit }) => ({ url, alt, credit })),
      });
      const headers: Record<string, string> = jsonHeaders({ 'x-katana-idempotency-key': post.idempotencyKey });
      if (options.secret) {
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(options.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
        headers['x-katana-signature'] = Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('');
      }
      await ctx.http.request(endpoint(), { method: 'POST', headers, body });
      return { id: post.idempotencyKey };
    },
  };
}

/** Prints posts to the terminal. The safe way to watch a bot before it goes live. */
export function consoleTarget(options: { name?: string; maxChars?: number; count?: (s: string) => number } = {}): Target {
  return {
    name: options.name ?? 'console',
    idempotent: true,
    limits: { maxChars: options.maxChars ?? 500, count: options.count ?? countGraphemes, maxMedia: 4, links: true, maxThread: 1 },
    async publish(post, ctx) {
      ctx.log.info(`\n${post.parts.join('\n---\n')}\n`);
      return { id: post.idempotencyKey };
    },
  };
}
