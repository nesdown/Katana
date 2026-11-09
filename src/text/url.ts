const TRACKING = /^(utm_\w+|at_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|ref_url|source|cmpid|ncid|_ga|yclid|twclid|spm)$/i;

/** One article, one identity: drops tracking parameters, fragments and cosmetic differences. */
export function canonicalUrl(input: string): string {
  try {
    const u = new URL(input);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^(www|m|amp)\./, '');
    u.protocol = 'https:';
    u.port = u.port === '80' || u.port === '443' ? '' : u.port;
    const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    u.search = new URLSearchParams(kept).toString();
    u.pathname = u.pathname.replace(/\/(amp|index\.html?)?\/?$/i, '') || '/';
    return u.href.replace(/\/$/, '');
  } catch {
    return input.trim();
  }
}

/** Removes tracking from a link people will see, leaving everything else as published. */
export function cleanUrl(input: string): string {
  try {
    const u = new URL(input);
    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    return u.href;
  } catch {
    return input;
  }
}

export function resolveUrl(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
