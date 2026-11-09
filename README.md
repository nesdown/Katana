<h1 align="center">⚔️ Katana</h1>
<p align="center"><strong>Cut the web into posts.</strong><br>A TypeScript library for bots that read the web and publish everywhere, without ever posting twice.</p>

```ts
import { katana, every } from 'katana-bot';
import { web } from 'katana-bot/sources';
import { bluesky, mastodon, telegram } from 'katana-bot/targets';
import { fileStore } from 'katana-bot/stores';

export default katana({
  name: 'kyiv-news',
  sources: [web('https://example.com')],   // finds the feed, or reads the page
  targets: [bluesky(), mastodon(), telegram()],
  store: fileStore(),
  schedule: every('30m', { jitter: '5m' }),
});
```

```bash
npx katana preview   # see exactly what would be posted, nothing goes out
npx katana run       # post for real, once
```

## Why Katana

**It never double posts.** Every post is written to disk before it is sent. If the process dies mid-send, Katana does not guess: it retries only where the network can reject a duplicate, and otherwise asks you to check. This is tested with a real `kill -9`.

**Text fits every network, correctly.** X weighs emoji and Japanese as 2 and every link as 23. Mastodon counts links as 23. Threads counts emoji in bytes. Bluesky counts what readers see and positions links in UTF-8 bytes. Katana knows all of this, and never cuts a link or splits an emoji.

**One story, one post.** Tracking parameters are stripped, and near-identical headlines from different outlets count as one story. It works in any language, with no language data.

**A good citizen by default.** Respects `robots.txt`, spaces out requests per site, credits sources and finds openly licensed images with proper attribution.

**AI where it helps, safe where it counts.** Rewrite, translate, summarize, judge relevance and write alt text. Scraped text is fenced off from instructions, invented links are removed, and AI only runs on items that might really be posted.

**See it work.** `pnpm playground` builds a page in `playground/dist` where you type a post and watch the real library fit it to five networks.

## Pipeline

```
 sources ──▶ memory ──▶ pick ──▶ cuts ──▶ compose ──▶ targets
 RSS, Atom   seen?      fair     filter   fit each    10 networks
 any page    same       newest   AI       network     retries that
 JSON APIs   story?     random   images   threads     cannot duplicate
```

## Targets

| Target | Text limit | Images | Threads | Safe auto-retry |
|---|---|---|---|---|
| `bluesky()` | 300 | upload, 4 | yes | asks a human |
| `mastodon()` | 500 | upload, 4 | yes | **yes** |
| `x()` | 280 weighted | upload, 4 | yes | asks a human |
| `threads()` | 500 | by URL, 1 | yes | asks a human |
| `telegram()` | 4096 | by URL, 1 | yes | asks a human |
| `discord()` | 2000 | embed, 1 | yes | asks a human |
| `slack()` | 3000 | none | no | asks a human |
| `linkedin()` | 3000 | link card | no | asks a human |
| `webhook()` | any | passed on | no | **yes**, with a signature |
| `consoleTarget()` | any | shown | no | **yes** |

Credentials come from your environment (`BLUESKY_HANDLE`, `MASTODON_TOKEN` and so on), and `katana init` creates a template. Write your own target with one function: `publish(post, ctx)`.

## Recipes

**A translating news bot with licensed images**

```ts
import { rss } from 'katana-bot/sources';
import { match, newerThan, translate, rewrite, noSourceImages, image, openverse, altText } from 'katana-bot/cuts';
import { claude } from 'katana-bot/ai';

const ai = claude(); // needs: npm install @anthropic-ai/sdk

katana({
  name: 'ukraine-tech',
  sources: [rss('https://example.com/feed'), rss('https://example.org/rss')],
  cuts: [
    newerThan('1d'),
    match({ any: ['startup', 'стартап'], none: ['sponsored', 'реклама'] }),
    translate(ai, { to: 'en' }),
    rewrite(ai, { voice: 'dry, curious, no hype' }),
    noSourceImages(),
    image(openverse()),
    altText(ai),
  ],
  targets: [bluesky({ threads: 3 }), x({ links: false })],
  store: fileStore(),
  pace: { perRun: 1, perDay: 12, gap: '45m' },
  quiet: { from: '23:00', to: '07:00', tz: 'Europe/Kyiv' },
  compose: { label: '🤖' },
});
```

**Read a site with no feed.** Selectors replace counting links by position:

```ts
html('https://example.com/news', { item: 'article', title: 'h2', link: 'h2 a@href', image: 'img@src' })
```

**Any data, any model, any database:**

```ts
from('my-db', () => db.query('select title, url from drafts'))                  // a source
const local = { name: 'mine', complete: async ({ system, prompt }) => callModel(system, prompt) } // an AI
const redis = { get, put, delete: del, all }                                     // a store: four methods
```

**Run it free on GitHub Actions.** See [examples/github-action.yml](examples/github-action.yml). `katana run` exits with an error when something needs a human, so failures show up.

## Command line

| Command | What it does |
|---|---|
| `katana init` | Creates a starter bot and keeps secrets out of git |
| `katana preview [--ai]` | Shows what would be posted. Skips paid AI unless you pass `--ai` |
| `katana run` | Runs once. For cron, Actions and serverless |
| `katana start` | Stays running and follows the schedule |
| `katana status` | What was posted, what is queued, what needs you |
| `katana resolve <id> <sent\|retry\|failed>` | Settles a post whose outcome was unclear |
| `katana doctor` | Checks sources and credentials without posting |
| `katana mcp` | Lets AI agents preview and run bots |

## For AI agents

`katana mcp` is an [MCP](https://modelcontextprotocol.io) server with `katana_preview`, `katana_status` and `katana_run`. Publishing requires an explicit `confirm: true`.

```json
{ "mcpServers": { "katana": { "command": "npx", "args": ["katana", "mcp"] } } }
```

## How a post stays safe

| What happens | What Katana does |
|---|---|
| Crash before sending | Sends it next run |
| Crash during sending | Mastodon, webhook: retries with the same key. Others: stops and asks you |
| Rate limited | Waits for `Retry-After`, then retries only that network |
| Server error or timeout | Treated as "may have posted", same as a crash |
| Post rejected | Records why and moves on |
| Thread breaks at part 3 of 5 | Continues from part 3 |
| Missing credentials | Waits for you to fix them, with no attempts used |
| Two runs overlap | The second one steps aside |
| Corrupt state file | Stops, rather than forgetting everything and reposting |

## Be a good bot

- **Label automation.** Networks have rules about this, and `compose: { label: '🤖' }` is one line.
- **Mind image rights.** Photos in news feeds are usually copyrighted. Uploading one is different from linking to it, so use `noSourceImages()` with `image(openverse())` to post licensed images only.
- **Check each network's terms** before automating, and read the costs. X charges per post, and reportedly much more for posts with links; `x({ links: false })` leaves them out.
- **Keep a human near anything sensitive.** The `approve` hook is your last check before publishing.

## Project status

`2.0.0-alpha`. A full rewrite of a 2016 Python script.

| Tested how | What |
|---|---|
| Automated, on every change | Pipeline, crash recovery, stores, text fitting, MCP, command line |
| Against the real internet, read-only | RSS, Atom, page reading, feed discovery, Openverse, image download |
| Against documented API contracts, with a simulated server | All posting adapters |
| **Not yet tried on live accounts** | **Publishing to any real network, and real Claude calls** |

Run `katana doctor`, then post to a test account first. Reports from live use are the most useful contribution right now. See [CONTRIBUTING.md](CONTRIBUTING.md).

## From Katana 1

| 2016 | Now |
|---|---|
| Keys hardcoded in the script | Environment variables, never in code |
| `findAll('a')`, take links 15 to 20 | Feeds, CSS selectors or automatic discovery |
| A random word for image search on Bing | Distinctive keywords on Openverse, with credit |
| TextBlob translation | Any AI model |
| `history.txt` with substring search | Crash-safe memory and same-story detection |
| `while True` and `sudo nohup` | Schedules, cron, Actions or serverless |
| `except: print("An error occured")` | Every failure classified and reported |
| Twitter only | 10 targets |

MIT. Made in Ukraine and Chicago.
