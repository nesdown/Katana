// A translating news bot with licensed images. Previews need no credentials.
//   node examples/news-bot.mjs           preview, posts nothing
import { katana, consoleLogger } from 'katana-bot';
import { web } from 'katana-bot/sources';
import { newerThan, noSourceImages, image, openverse, match } from 'katana-bot/cuts';
import { bluesky, mastodon, x } from 'katana-bot/targets';
import { fileStore } from 'katana-bot/stores';

const bot = katana({
  name: 'news',
  sources: [web('https://www.nasa.gov/news-release/feed/', { limit: 10 }), web('https://feeds.bbci.co.uk/news/technology/rss.xml', { limit: 10 })],
  cuts: [newerThan('2d'), match({ none: ['sponsored'] }), noSourceImages(), image(openverse())],
  targets: [bluesky(), mastodon({ instance: 'https://mastodon.social' }), x({ links: false })],
  store: fileStore('.katana/news.json'),
  pace: { perRun: 1, perDay: 10 },
  compose: { label: '🤖' },
  log: consoleLogger,
});

const { drafts } = await bot.preview({ limit: 3 });
for (const draft of drafts) {
  console.log(`\n${draft.item.title}`);
  for (const post of draft.posts) console.log(`  ${post.target}: ${post.chars}/${post.maxChars}\n    ${post.parts[0].replaceAll('\n', '\n    ')}`);
}
