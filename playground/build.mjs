import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const { outputFiles } = await build({
  entryPoints: ['playground/entry.ts'],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  globalName: 'Katana',
  platform: 'browser',
  target: 'es2022',
});
const bundle = outputFiles[0].text.replaceAll('</script', '<\\/script');
const page = (await readFile('playground/page.html', 'utf8')).replace('/*KATANA_BUNDLE*/', () => bundle);
await mkdir('playground/dist', { recursive: true });
await writeFile('playground/dist/katana-playground.html', page);
// A standalone copy for GitHub Pages or local viewing.
await writeFile('playground/dist/index.html', `<!doctype html>\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${page}`);
console.log(`bundle ${(bundle.length / 1024).toFixed(1)} KB, page ${(page.length / 1024).toFixed(1)} KB`);
