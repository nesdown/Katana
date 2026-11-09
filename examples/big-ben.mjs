// The BigBen bot from the 2016 version, ten years on. It says BOM once for every hour.
//   node examples/big-ben.mjs
import { katana, cron, consoleLogger } from 'katana-bot';
import { from } from 'katana-bot/sources';
import { consoleTarget } from 'katana-bot/targets';
import { fileStore } from 'katana-bot/stores';

const bigBen = katana({
  name: 'big-ben',
  sources: [
    from('tower', () => {
      const now = new Date();
      const hour = now.getHours() % 12 || 12;
      const key = `bong:${now.toISOString().slice(0, 13)}`;
      return [{ key, title: 'BOM '.repeat(hour).trim() }];
    }),
  ],
  targets: [consoleTarget()],
  store: fileStore('.katana/big-ben.json'),
  schedule: cron('0 * * * *', { tz: 'Europe/London' }),
  dedupe: { similarity: false },
  log: consoleLogger,
});

await bigBen.run();
