import { credential, optionalEnv } from '../env.js';
import { bskyRichText, countBluesky } from '../text/richtext.js';
import type { Ctx, Post, PublishCtx, Target } from '../types.js';
import { jsonHeaders, loadImages, publishParts } from './shared.js';

export interface BlueskyOptions {
  name?: string;
  /** Defaults to BLUESKY_HANDLE. */
  handle?: string;
  /** Use an app password, never your main password. Defaults to BLUESKY_APP_PASSWORD. */
  appPassword?: string;
  /** Defaults to BLUESKY_SERVICE or https://bsky.social. */
  service?: string;
  threads?: number;
}

interface Session {
  accessJwt: string;
  did: string;
}

const IMAGE_MAX_BYTES = 2_000_000;

export function bluesky(options: BlueskyOptions = {}): Target {
  const handle = credential(options.handle, 'BLUESKY_HANDLE');
  const password = credential(options.appPassword, 'BLUESKY_APP_PASSWORD');
  const service = () => (options.service ?? optionalEnv('BLUESKY_SERVICE') ?? 'https://bsky.social').replace(/\/$/, '');
  let session: Promise<Session> | undefined;

  const login = (ctx: Ctx) =>
    (session ??= ctx.http
      .json<Session>(`${service()}/xrpc/com.atproto.server.createSession`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ identifier: handle(), password: password() }),
      })
      .catch((err) => {
        session = undefined;
        throw err;
      }));

  async function upload(ctx: Ctx, auth: Session, data: Uint8Array, mime: string) {
    const res = await ctx.http.json<{ blob: unknown }>(`${service()}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.accessJwt}`, 'content-type': mime },
      body: data.slice(),
    });
    return res.blob;
  }

  async function firstEmbed(post: Post, ctx: PublishCtx, auth: Session) {
    const images = await loadImages(post.media, ctx, 4, IMAGE_MAX_BYTES);
    if (images.length) {
      const uploaded = [];
      for (const image of images) {
        uploaded.push({ alt: image.alt ?? '', image: await upload(ctx, auth, image.data, image.mime) });
      }
      return { $type: 'app.bsky.embed.images', images: uploaded };
    }
    return undefined;
  }

  async function linkCard(post: Post, ctx: PublishCtx, auth: Session) {
    if (!post.url || !post.title) return undefined;
    return {
      $type: 'app.bsky.embed.external',
      external: { uri: post.url, title: post.title, description: post.description ?? '' },
    };
  }

  const atUriToWeb = (uri: string) => {
    const [, did, , rkey] = uri.replace('at://', '/').split('/');
    return `https://bsky.app/profile/${did}/post/${rkey}`;
  };

  return {
    name: options.name ?? 'bluesky',
    limits: { maxChars: 300, count: countBluesky, maxMedia: 4, links: true, maxThread: options.threads ?? 1 },

    async check(ctx) {
      const auth = await login(ctx);
      return `signed in as ${auth.did}`;
    },

    async publish(post, ctx) {
      const auth = await login(ctx);
      const embed = (await firstEmbed(post, ctx, auth)) ?? (await linkCard(post, ctx, auth));
      const refs = new Map<string, { uri: string; cid: string }>();
      let root: { uri: string; cid: string } | undefined;

      const ids = await publishParts(post, ctx, async (part, index, previousId) => {
        const { text, facets } = bskyRichText(part);
        const parent = previousId ? refs.get(previousId) ?? decodeRef(previousId) : undefined;
        root ??= ctx.resume[0] ? decodeRef(ctx.resume[0]) : undefined;
        const record = {
          $type: 'app.bsky.feed.post',
          text,
          createdAt: ctx.now().toISOString(),
          ...(facets.length ? { facets } : {}),
          ...(post.lang ? { langs: [post.lang] } : {}),
          ...(index === 0 && embed ? { embed } : {}),
          ...(parent ? { reply: { root: root ?? parent, parent } } : {}),
        };
        const res = await ctx.http.json<{ uri: string; cid: string }>(`${service()}/xrpc/com.atproto.repo.createRecord`, {
          method: 'POST',
          headers: jsonHeaders({ authorization: `Bearer ${auth.accessJwt}` }),
          body: JSON.stringify({ repo: auth.did, collection: 'app.bsky.feed.post', record }),
        });
        root ??= { uri: res.uri, cid: res.cid };
        const id = encodeRef(res);
        refs.set(id, res);
        return id;
      });
      const first = decodeRef(ids[0]!);
      return { id: first.uri, url: atUriToWeb(first.uri), ids };
    },
  };
}

// A reply needs both uri and cid, so both travel in the checkpoint.
const encodeRef = (ref: { uri: string; cid: string }) => `${ref.uri}#${ref.cid}`;
const decodeRef = (id: string) => {
  const [uri, cid] = id.split('#') as [string, string];
  return { uri, cid };
};

