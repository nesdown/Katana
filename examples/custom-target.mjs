// A new network is one function. This one appends posts to a file.
//   node examples/custom-target.mjs
import { appendFile } from 'node:fs/promises';
import { katana } from 'katana-bot';
import { list } from 'katana-bot/sources';

const journal = {
  name: 'journal',
  idempotent: false,
  limits: { maxChars: 140, count: (t) => t.length, maxMedia: 0, links: true, maxThread: 1 },
  async publish(post) {
    await appendFile('journal.txt', `${post.parts[0]}\n\n`);
    return { id: post.key };
  },
};

const report = await katana({
  name: 'journal-bot',
  sources: [list('thoughts', ['Sharp tools make small cuts.'])],
  targets: [journal],
}).run();

console.log(report.deliveries[0].status);
