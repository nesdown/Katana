#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Katana, RunReport } from './bot.js';
import { consoleLogger } from './log.js';

const CONFIG_NAMES = ['katana.config.mjs', 'katana.config.js', 'katana.config.ts'];

const HELP = `katana: cut the web into posts

  katana init              Create a starter bot in this folder
  katana preview           Show what would be posted. Posts nothing.
      --ai                 Include AI cuts (costs money)
      --limit <n>          How many drafts to show
      --json               Print raw JSON
  katana run               Run once and publish. Good for cron and GitHub Actions.
  katana start             Stay running and follow the bot's schedule
  katana status            What was posted, what is queued, what needs a human
  katana resolve <id> <sent|retry|failed>
                           Settle a post whose outcome was unclear
  katana doctor            Check config, sources and credentials. Posts nothing.
  katana mcp               Serve bots to AI agents over MCP

  --bot <name>             Pick one bot when the config exports several
  --config <path>          Use a specific config file
`;

const STARTER = `import { katana, every, consoleLogger } from 'katana-bot';
import { web } from 'katana-bot/sources';
import { newerThan } from 'katana-bot/cuts';
import { consoleTarget } from 'katana-bot/targets';
import { fileStore } from 'katana-bot/stores';

export default katana({
  name: 'my-bot',
  // Any site works. Katana uses its feed if it has one, or reads headlines from the page.
  sources: [web('https://feeds.bbci.co.uk/news/technology/rss.xml')],
  cuts: [newerThan('2d')],
  // Prints to the terminal. Swap in bluesky(), mastodon(), telegram() and friends when ready.
  targets: [consoleTarget()],
  store: fileStore(),
  schedule: every('1h', { jitter: '10m' }),
  pace: { perRun: 1, perDay: 12 },
  log: consoleLogger,
});
`;

const ENV_EXAMPLE = `# Fill in only the networks you use, then rename this file to .env
BLUESKY_HANDLE=
BLUESKY_APP_PASSWORD=
MASTODON_URL=
MASTODON_TOKEN=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
SLACK_WEBHOOK_URL=
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_SECRET=
THREADS_USER_ID=
THREADS_TOKEN=
LINKEDIN_TOKEN=
LINKEDIN_AUTHOR=
ANTHROPIC_API_KEY=
`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (['limit', 'bot', 'config'].includes(name) && next !== undefined) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function loadBots(flags: Record<string, string | true>): Promise<Katana[]> {
  if (existsSync('.env')) process.loadEnvFile?.('.env');
  const path = typeof flags.config === 'string' ? flags.config : CONFIG_NAMES.find(existsSync);
  if (!path) throw new Error('No katana.config.mjs here. Create one with: katana init');
  const module = await import(pathToFileURL(resolve(path)).href);
  const exported = module.default ?? module.bot ?? module.bots;
  const bots: Katana[] = Array.isArray(exported) ? exported : [exported];
  const isBot = (b: any) => typeof b?.run === 'function' && typeof b?.preview === 'function';
  if (!bots.length || !bots.every(isBot)) {
    throw new Error(`${path} must export a bot: export default katana({ ... })`);
  }
  if (typeof flags.bot === 'string') {
    const one = bots.filter((b) => b.name === flags.bot);
    if (!one.length) throw new Error(`No bot named "${flags.bot}". Available: ${bots.map((b) => b.name).join(', ')}`);
    return one;
  }
  return bots;
}

function printRun(report: RunReport) {
  console.log(`\n${report.bot}${report.dryRun ? ' (preview, nothing was posted)' : ''}`);
  if (report.skipped) {
    console.log(`  skipped: ${report.skipped}`);
    return;
  }
  for (const r of report.read) console.log(`  read ${r.source}: ${r.error ? `FAILED, ${r.error}` : `${r.items} items`}`);
  console.log(`  ${report.fresh} new, ${report.queued} waiting for a later run`);
  for (const t of report.trace) if (t.outcome !== 'draft' && t.outcome !== 'posted') console.log(`  ${t.outcome}: ${t.title}${t.reason ? ` (${t.reason})` : ''}`);
  for (const d of report.drafts) {
    console.log(`\n  "${d.item.title}"`);
    for (const p of d.posts) {
      console.log(`  ── ${p.target} ${p.chars.join('+')}/${p.maxChars}${p.media ? `, ${p.media} image` : ''}`);
      for (const part of p.parts) console.log(part.split('\n').map((l) => `     ${l}`).join('\n'));
    }
  }
  for (const d of report.deliveries) {
    const where = d.receipt?.url ? ` ${d.receipt.url}` : '';
    console.log(`  ${d.status}: ${d.target}, "${d.title}"${where}${d.error ? ` (${d.error})` : ''}`);
  }
  if (!report.dryRun && !report.deliveries.length) console.log('  nothing to post this run');
}

async function init() {
  if (CONFIG_NAMES.some(existsSync)) throw new Error('This folder already has a Katana config.');
  await writeFile('katana.config.mjs', STARTER);
  if (!existsSync('.env.example')) await writeFile('.env.example', ENV_EXAMPLE);
  const ignore = existsSync('.gitignore') ? await readFile('.gitignore', 'utf8') : '';
  const missing = ['.env', '.katana'].filter((line) => !ignore.split('\n').includes(line));
  if (missing.length) await appendFile('.gitignore', `${ignore && !ignore.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  console.log('Created katana.config.mjs and .env.example, and kept secrets out of git.\nNext: katana preview');
}

async function doctor(bots: Katana[]): Promise<boolean> {
  let healthy = true;
  for (const bot of bots) {
    console.log(`\n${bot.name}`);
    const report = await bot.preview({ limit: 1 });
    for (const r of report.read) {
      if (r.error) healthy = false;
      console.log(`  ${r.error ? 'FAIL' : 'ok  '} source ${r.source}: ${r.error ?? `${r.items} items`}`);
    }
    const ctx = bot.ctx(true);
    for (const target of bot.targets) {
      if (!target.check) {
        console.log(`  --   target ${target.name}: no read-only check available`);
        continue;
      }
      try {
        console.log(`  ok   target ${target.name}: ${await target.check(ctx)}`);
      } catch (err) {
        healthy = false;
        console.log(`  FAIL target ${target.name}: ${(err as Error).message}`);
      }
    }
  }
  return healthy;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  switch (command) {
    case 'init':
      return init();
    case 'preview': {
      for (const bot of await loadBots(flags)) {
        const report = await bot.preview({ ai: flags.ai === true, limit: flags.limit ? Number(flags.limit) : undefined });
        if (flags.json) console.log(JSON.stringify(report, null, 2));
        else printRun(report);
      }
      return;
    }
    case 'run': {
      let failed = false;
      for (const bot of await loadBots(flags)) {
        const report = await bot.run();
        printRun(report);
        failed ||= report.deliveries.some((d) => d.status === 'failed' || d.status === 'unknown');
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }
    case 'start': {
      const stop = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort());
      await Promise.all((await loadBots(flags)).map((b) => b.start({ signal: stop.signal })));
      return;
    }
    case 'status': {
      for (const bot of await loadBots(flags)) {
        const s = await bot.status();
        console.log(`\n${s.bot}\n  ${s.sentLast24h} posted in the last 24 hours, ${s.queued} queued, ${s.seen} remembered`);
        for (const d of s.needsAttention) console.log(`  ${d.status.toUpperCase()}: ${d.id}\n     ${d.error ?? ''}`);
        if (!s.needsAttention.length) console.log('  nothing needs your attention');
      }
      return;
    }
    case 'resolve': {
      const [id, decision] = rest;
      if (!id || !['sent', 'retry', 'failed'].includes(decision ?? '')) throw new Error('Usage: katana resolve <id> <sent|retry|failed>');
      const bots = await loadBots(flags);
      for (const bot of bots) {
        if (await bot.store.get('deliveries', id)) {
          await bot.resolve(id, decision as 'sent');
          console.log(`Marked ${id} as ${decision}.`);
          return;
        }
      }
      throw new Error(`No delivery with id "${id}". Run: katana status`);
    }
    case 'doctor': {
      const healthy = await doctor(await loadBots(flags));
      console.log(healthy ? '\nAll good.' : '\nSome checks failed.');
      process.exitCode = healthy ? 0 : 1;
      return;
    }
    case 'mcp': {
      const { serveMcp } = await import('./mcp.js');
      console.log = console.error; // Stdout belongs to the protocol.
      consoleLogger.info = (m) => console.error(m);
      return serveMcp(await loadBots(flags));
    }
    default:
      console.log(HELP);
      process.exitCode = command && command !== 'help' ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
});
