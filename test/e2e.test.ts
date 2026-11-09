import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs the built command line against a real local HTTP server, including a real kill -9.
const CLI = resolve('dist/cli.js');
const lib = (p: string) => pathToFileURL(resolve(`dist/${p}`)).href;

const FEED = `<rss><channel><title>Local News</title>
<item><title>The first story to publish today</title><link>http://news.test/1</link></item>
<item><title>A completely unrelated second report</title><link>http://news.test/2</link></item>
</channel></rss>`;

let server: Server;
let base: string;
let dir: string;
let received: string[] = [];
let hang = false;
let onReceive: (() => void) | undefined;

const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
  const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { cwd: dir });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  child.on('close', (code) => done({ code, out }));
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'katana-e2e-'));
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/feed') return res.end(FEED);
      if (req.url?.startsWith('/hook')) {
        received.push(JSON.parse(body).content);
        onReceive?.();
        if (hang) return; // Never answers, like a network that dies after accepting a post.
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ id: String(received.length) }));
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(join(dir, 'katana.config.mjs'), `
    import { katana, consoleLogger } from ${JSON.stringify(lib('index.js'))};
    import { rss } from ${JSON.stringify(lib('sources/index.js'))};
    import { discord } from ${JSON.stringify(lib('targets/index.js'))};
    import { fileStore } from ${JSON.stringify(lib('stores/index.js'))};
    export default katana({
      name: 'e2e',
      sources: [rss('${base}/feed')],
      targets: [discord({ webhook: '${base}/hook' })],
      store: fileStore(),
      http: { hostDelayMs: 0, timeoutMs: 120000 },
      log: consoleLogger,
    });
  `);
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the built command line', () => {
  it('prints help', async () => {
    const { code, out } = await run(['help']);
    expect(code).toBe(0);
    expect(out).toContain('katana preview');
  });

  it('previews without posting', async () => {
    const { code, out } = await run(['preview']);
    expect(code).toBe(0);
    expect(out).toContain('preview, nothing was posted');
    expect(out).toContain('The first story to publish today');
    expect(out).toContain('via Local News');
    expect(received).toEqual([]);
  });

  it('posts for real, once per run, across separate processes', async () => {
    expect((await run(['run'])).code).toBe(0);
    expect(received).toHaveLength(1);
    expect((await run(['run'])).code).toBe(0);
    expect(received).toHaveLength(2);
    expect(new Set(received).size).toBe(2);
    const third = await run(['run']);
    expect(third.out).toContain('nothing to post');
    expect(received).toHaveLength(2);
    const state = JSON.parse(await readFile(join(dir, '.katana/state.json'), 'utf8'));
    expect(Object.keys(state.seen)).toHaveLength(2);
  });
});

describe('a real kill -9 in the middle of posting', () => {
  it('does not post again, and asks a human to check', async () => {
    await writeFile(join(dir, 'katana.config.mjs'), (await readFile(join(dir, 'katana.config.mjs'), 'utf8')).replace("store: fileStore()", "store: fileStore('.katana/crash.json')"));
    received = [];
    hang = true;
    const child: ChildProcess = spawn(process.execPath, ['--no-warnings', CLI, 'run'], { cwd: dir, stdio: 'ignore' });
    await new Promise<void>((r) => (onReceive = r));
    onReceive = undefined;
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    expect(received).toHaveLength(1);
    const crashed = received[0]!;
    hang = false;

    // The dead process left its lock behind, which expires instead of blocking forever.
    const state = () => readFile(join(dir, '.katana/crash.json'), 'utf8').then(JSON.parse);
    const before = Object.values<any>((await state()).deliveries);
    expect(before[0].status).toBe('sending');
    const lock = join(dir, '.katana/crash.json.run-e2e.lock');
    expect(await readFile(lock, 'utf8')).toBeTruthy();
    const blocked = await run(['run']);
    expect(blocked.out).toContain('another run is still going');
    expect(received).toHaveLength(1);
    await writeFile(lock, '0'); // Fast-forward past the 30 minute expiry.

    const after = await run(['run']);
    expect(after.out).toContain('may or may not have posted');
    // The next story went out. The one in doubt did not go out twice.
    expect(received).toHaveLength(2);
    expect(received[1]).not.toBe(crashed);
    expect(received.filter((r) => r === crashed)).toHaveLength(1);

    const status = await run(['status']);
    expect(status.out).toContain('UNKNOWN');
    const id = Object.values<any>((await state()).deliveries).find((d) => d.status === 'unknown').id;

    const settled = await run(['resolve', id, 'sent']);
    expect(settled.code).toBe(0);
    expect((await run(['status'])).out).toContain('nothing needs your attention');
    await run(['run']);
    expect(received).toHaveLength(2);
  });
});

describe('katana init', () => {
  it('creates a starter without touching existing work', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'katana-init-'));
    const inFresh = (args: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { cwd: fresh });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('close', (code) => done({ code, out }));
    });
    expect((await inFresh(['init'])).code).toBe(0);
    expect(await readFile(join(fresh, '.gitignore'), 'utf8')).toContain('.env');
    expect(await readFile(join(fresh, 'katana.config.mjs'), 'utf8')).toContain("from 'katana-bot'");
    const again = await inFresh(['init']);
    expect(again.code).toBe(1);
    expect(again.out).toContain('already has');
    await rm(fresh, { recursive: true, force: true });
  });
  it('explains a missing config', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'katana-none-'));
    const out = await new Promise<string>((done) => {
      const child = spawn(process.execPath, ['--no-warnings', CLI, 'run'], { cwd: fresh });
      let text = '';
      child.stderr.on('data', (c) => (text += c));
      child.on('close', () => done(text));
    });
    expect(out).toContain('katana init');
    await rm(fresh, { recursive: true, force: true });
  });
});
