import { credential, env, optionalEnv } from '../env.js';
import { sleep } from '../duration.js';
import { countMastodon } from '../text/count.js';
import type { Ctx, PublishCtx, Target } from '../types.js';
import { blob, loadImages, publishParts } from './shared.js';

export interface MastodonOptions {
  name?: string;
  /** Your server, for example https://mastodon.social. Defaults to MASTODON_URL. */
  instance?: string;
  /** Defaults to MASTODON_TOKEN. Needs write:statuses and write:media. */
  token?: string;
  visibility?: 'public' | 'unlisted' | 'private';
  /** Servers can set their own limit. */
  maxChars?: number;
  threads?: number;
  /** Delay between media status checks. */
  pollMs?: number;
}

const IMAGE_MAX_BYTES = 16_000_000;

export function mastodon(options: MastodonOptions = {}): Target {
  const instance = () => (options.instance ?? optionalEnv('MASTODON_URL') ?? env('MASTODON_URL')).replace(/\/$/, '');
  const token = credential(options.token, 'MASTODON_TOKEN');
  const auth = () => ({ authorization: `Bearer ${token()}` });
  const pollMs = options.pollMs ?? 2000;

  async function uploadMedia(post: { media: any[] }, ctx: PublishCtx): Promise<string[]> {
    const ids: string[] = [];
    for (const image of await loadImages(post.media, ctx, 4, IMAGE_MAX_BYTES)) {
      const form = new FormData();
      form.append('file', blob(image.data, image.mime), 'image');
      if (image.alt) form.append('description', image.alt.slice(0, 1500));
      const res = await ctx.http.request(`${instance()}/api/v2/media`, { method: 'POST', headers: auth(), body: form });
      const media = (await res.json()) as { id: string };
      if (res.status === 202) await waitForMedia(media.id, ctx);
      ids.push(media.id);
    }
    return ids;
  }

  async function waitForMedia(id: string, ctx: Ctx) {
    for (let i = 0; i < 30; i++) {
      await sleep(pollMs);
      const res = await ctx.http.request(`${instance()}/api/v1/media/${id}`, { headers: auth() });
      if (res.status === 200) return;
    }
    throw new Error(`Mastodon did not finish processing media ${id}`);
  }

  return {
    name: options.name ?? 'mastodon',
    idempotent: true,
    limits: { maxChars: options.maxChars ?? 500, count: countMastodon, maxMedia: 4, links: true, maxThread: options.threads ?? 1 },

    async check(ctx) {
      const me = await ctx.http.json<{ acct: string }>(`${instance()}/api/v1/accounts/verify_credentials`, { headers: auth() });
      return `signed in as @${me.acct}`;
    },

    async publish(post, ctx) {
      const mediaIds = ctx.resume.length ? [] : await uploadMedia(post, ctx);
      let url: string | undefined;
      const ids = await publishParts(post, ctx, async (text, index, previousId) => {
        const form = new URLSearchParams();
        form.set('status', text);
        form.set('visibility', options.visibility ?? 'public');
        if (post.lang) form.set('language', post.lang);
        if (previousId) form.set('in_reply_to_id', previousId);
        if (index === 0) for (const id of mediaIds) form.append('media_ids[]', id);
        const status = await ctx.http.json<{ id: string; url?: string }>(`${instance()}/api/v1/statuses`, {
          method: 'POST',
          headers: { ...auth(), 'Idempotency-Key': `${post.idempotencyKey}-${index}` },
          body: form,
        });
        if (index === 0) url = status.url;
        return status.id;
      });
      return { id: ids[0]!, url, ids };
    },
  };
}
