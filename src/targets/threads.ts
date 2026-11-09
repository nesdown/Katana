import { credential } from '../env.js';
import { sleep } from '../duration.js';
import { countThreads } from '../text/count.js';
import type { Ctx, Target } from '../types.js';
import { publishParts } from './shared.js';

export interface ThreadsOptions {
  name?: string;
  /** Defaults to THREADS_USER_ID. */
  userId?: string;
  /** Defaults to THREADS_TOKEN. */
  token?: string;
  threads?: number;
  pollMs?: number;
  baseUrl?: string;
}

/**
 * Threads publishes in two steps: create a container, wait for it, publish it.
 * Images must be at a public URL, because Meta downloads them itself.
 */
export function threads(options: ThreadsOptions = {}): Target {
  const base = options.baseUrl ?? 'https://graph.threads.com/v1.0';
  const user = credential(options.userId, 'THREADS_USER_ID');
  const token = credential(options.token, 'THREADS_TOKEN');
  const pollMs = options.pollMs ?? 10_000;

  const form = (values: Record<string, string | undefined>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v !== undefined) body.set(k, v);
    body.set('access_token', token());
    return body;
  };

  async function waitForContainer(id: string, ctx: Ctx) {
    // Docs: check once per minute at most for five minutes; small posts usually finish in about 30 seconds.
    for (let i = 0; i < 30; i++) {
      const params = new URLSearchParams({ fields: 'status,error_message', access_token: token() });
      const res = await ctx.http.json<{ status: string; error_message?: string }>(`${base}/${id}?${params}`);
      if (res.status === 'FINISHED') return;
      if (res.status === 'ERROR' || res.status === 'EXPIRED') {
        throw new Error(`Threads container ${res.status}: ${res.error_message ?? 'no details'}`);
      }
      await sleep(pollMs);
    }
    throw new Error('Threads container did not finish in time');
  }

  return {
    name: options.name ?? 'threads',
    limits: { maxChars: 500, count: countThreads, maxMedia: 1, links: true, maxThread: options.threads ?? 1 },

    async check(ctx) {
      const params = new URLSearchParams({ fields: 'username', access_token: token() });
      const me = await ctx.http.json<{ username: string }>(`${base}/me?${params}`);
      return `signed in as @${me.username}`;
    },

    async publish(post, ctx) {
      const image = post.media.find((m) => m.url)?.url;
      const ids = await publishParts(post, ctx, async (text, index, previousId) => {
        const useImage = index === 0 && image;
        const container = await ctx.http.json<{ id: string }>(`${base}/${user()}/threads`, {
          method: 'POST',
          body: form({
            media_type: useImage ? 'IMAGE' : 'TEXT',
            text,
            image_url: useImage ? image : undefined,
            reply_to_id: previousId,
          }),
        });
        await waitForContainer(container.id, ctx);
        const published = await ctx.http.json<{ id: string }>(`${base}/${user()}/threads_publish`, {
          method: 'POST',
          body: form({ creation_id: container.id }),
        });
        return published.id;
      });
      return { id: ids[0]!, ids };
    },
  };
}
