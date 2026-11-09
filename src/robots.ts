interface Rule {
  allow: boolean;
  pattern: string;
}

export interface Robots {
  allowed(path: string): boolean;
  crawlDelayMs?: number;
  /** True when robots.txt could not be read, as opposed to saying no. */
  unavailable?: boolean;
}

const toRegExp = (pattern: string) => {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
};

/** Parses robots.txt following RFC 9309: most specific group wins, longest match wins, allow wins ties. */
export function parseRobots(text: string, userAgent: string): Robots {
  const agent = userAgent.toLowerCase().split('/')[0]!;
  const groups: Array<{ agents: string[]; rules: Rule[]; delay?: number }> = [];
  let current: (typeof groups)[number] | undefined;
  let collectingAgents = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }
    if (!current) continue;
    collectingAgents = false;
    if (field === 'allow' || field === 'disallow') {
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay)) current.delay = delay;
    }
  }

  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delay = chosen.find((g) => g.delay !== undefined)?.delay;

  return {
    crawlDelayMs: delay === undefined ? undefined : delay * 1000,
    allowed(path) {
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!toRegExp(rule.pattern).test(path)) continue;
        const longer = !best || rule.pattern.length > best.pattern.length;
        const tie = best && rule.pattern.length === best.pattern.length && rule.allow;
        if (longer || tie) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

export const ALLOW_ALL: Robots = { allowed: () => true };
/** The site could not say. RFC 9309 treats this as no access, for now. */
export const UNAVAILABLE: Robots = { allowed: () => false, unavailable: true };
