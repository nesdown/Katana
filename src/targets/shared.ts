import type { BytesResult } from '../http.js';
import type { Media, Post, PublishCtx } from '../types.js';

/** Identifies a real image from its first bytes. Blocks HTML or SVG served as an image. */
export function sniffImage(data: Uint8Array): string | undefined {
  const b = data;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return undefined;
}

export interface LoadedImage extends BytesResult {
  mime: string;
  alt?: string;
}

/** Downloads images for upload. A bad image never blocks a post: it is logged and skipped. */
export async function loadImages(media: Media[], ctx: PublishCtx, limit: number, maxBytes: number): Promise<LoadedImage[]> {
  const out: LoadedImage[] = [];
  for (const m of media.slice(0, limit)) {
    try {
      const data = m.data ?? (m.url ? (await ctx.http.bytes(m.url, { maxBytes })).data : undefined);
      if (!data) continue;
      if (data.byteLength > maxBytes) throw new Error(`image is ${data.byteLength} bytes, over the ${maxBytes} byte limit`);
      const mime = sniffImage(data);
      if (!mime) throw new Error('file is not a JPEG, PNG, GIF or WebP image');
      out.push({ data, mime, alt: m.alt });
    } catch (err) {
      ctx.log.warn(`Posting without image: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Publishes thread parts in order and resumes after a failure instead of repeating parts. */
export async function publishParts(
  post: Post,
  ctx: PublishCtx,
  sendOne: (text: string, index: number, previousId: string | undefined) => Promise<string>,
): Promise<string[]> {
  const ids = [...ctx.resume];
  for (let i = ids.length; i < post.parts.length; i++) {
    const id = await sendOne(post.parts[i]!, i, ids.at(-1));
    ids.push(id);
    await ctx.checkpoint(id);
  }
  return ids;
}

export const blob = (data: Uint8Array, mime: string) => new Blob([data.slice()], { type: mime });

export const jsonHeaders = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', ...extra });
