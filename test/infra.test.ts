import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { katana } from '../src/bot.js';
import { ms } from '../src/duration.js';
import { serveMcp } from '../src/mcp.js';
import { cron, daily, every, isQuiet } from '../src/schedule.js';
import { list } from '../src/sources/index.js';
import { fileStore, memoryStore, sqliteStore } from '../src/stores/index.js';
import { recordingTarget } from '../src/testing.js';
import type { Store } from '../src/types.js';

describe('durations', () => {
  it('reads human durations', () => {
    expect(ms('90s')).toBe(90_000);
    expect(ms('1h30m')).toBe(5_400_000);
    expect(ms('2d')).toBe(172_800_000);
    expect(ms(5)).toBe(5);
  });
  it('rejects nonsense', () => {
    expect(() => ms('soon')).toThrow(/duration/);
    expect(() => ms('5 parsecs')).toThrow(/duration/);
  });
});

describe('schedules', () => {
  const at = new Date('2026-11-09T10:15:30Z');
  it('every', () => {
    expect(every('30m').next(at).getTime()).toBe(at.getTime() + 1_800_000);
    const j = every('30m', { jitter: '5m' }).next(at).getTime() - at.getTime();
    expect(j).toBeGreaterThanOrEqual(1_500_000);
    expect(j).toBeLessThanOrEqual(2_100_000);
    expect(() => every('10s')).toThrow(/minute/);
  });
  it('cron in UTC', () => {
    expect(cron('*/15 * * * *', { tz: 'UTC' }).next(at).toISOString()).toBe('2026-11-09T10:30:00.000Z');
    expect(cron('0 9 * * 1-5', { tz: 'UTC' }).next(new Date('2026-11-13T10:00:00Z')).toISOString()).toBe('2026-11-16T09:00:00.000Z');
    expect(cron('0 0 1 1 *', { tz: 'UTC' }).next(at).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(cron('0 12 * * 0', { tz: 'UTC' }).next(at).toISOString()).toBe('2026-11-15T12:00:00.000Z');
    expect(cron('0 12 * * 7', { tz: 'UTC' }).next(at).toISOString()).toBe('2026-11-15T12:00:00.000Z');
  });
  it('cron in a time zone', () => {
    expect(daily('09:30', { tz: 'Europe/Kyiv' }).next(at).toISOString()).toBe('2026-11-10T07:30:00.000Z');
    expect(daily('09:30', { tz: 'America/Chicago' }).next(at).toISOString()).toBe('2026-11-09T15:30:00.000Z');
  });
  it('rejects bad cron', () => {
    expect(() => cron('* * *')).toThrow(/five/);
    expect(() => cron('99 * * * *')).toThrow(/range/);
    expect(() => daily('noon')).toThrow(/time/);
  });
  it('finds a leap day', () => {
    expect(cron('0 0 29 2 *', { tz: 'UTC' }).next(at).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });
  it('quiet hours cross midnight', () => {
    const q = { from: '22:00', to: '07:00', tz: 'UTC' };
    expect(isQuiet(new Date('2026-11-09T23:00:00Z'), q)).toBe(true);
    expect(isQuiet(new Date('2026-11-09T03:00:00Z'), q)).toBe(true);
    expect(isQuiet(new Date('2026-11-09T12:00:00Z'), q)).toBe(false);
    expect(isQuiet(new Date('2026-11-09T12:00:00Z'), { from: '11:00', to: '13:00', tz: 'UTC' })).toBe(true);
  });
});

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'katana-'));
  dirs.push(d);
  return d;
};
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const contract = (name: string, make: () => Promise<Store>) =>
  describe(`${name} store`, () => {
    it('stores, lists and deletes', async () => {
      const s = await make();
      expect(await s.get('c', 'k')).toBeUndefined();
      await s.put('c', 'k', { a: 1, text: 'Київ 🇺🇦' });
      await s.put('c', 'k2', { a: 2 });
      await s.put('other', 'k', { a: 3 });
      expect(await s.get('c', 'k')).toEqual({ a: 1, text: 'Київ 🇺🇦' });
      expect((await s.all('c')).map(([k]) => k).sort()).toEqual(['k', 'k2']);
      await s.put('c', 'k', { a: 9 });
      expect(await s.get('c', 'k')).toEqual({ a: 9 });
      await s.delete('c', 'k');
      expect(await s.get('c', 'k')).toBeUndefined();
      await s.delete('c', 'never-existed');
      await s.close?.();
    });
    it('locks exclusively and honours expiry', async () => {
      const s = await make();
      expect(await s.acquire!('run', 60_000)).toBe(true);
      expect(await s.acquire!('run', 60_000)).toBe(false);
      await s.release!('run');
      expect(await s.acquire!('run', -1)).toBe(true);
      expect(await s.acquire!('run', 60_000)).toBe(true);
      await s.release!('run');
      await s.close?.();
    });
  });

contract('memory', async () => memoryStore());
contract('file', async () => fileStore(join(await tmp(), 'nested/state.json')));
contract('sqlite', async () => sqliteStore(join(await tmp(), 'nested/state.db')));

describe('durable stores', () => {
  it('file state survives a restart', async () => {
    const path = join(await tmp(), 'state.json');
    const a = fileStore(path);
    await a.put('c', 'k', { v: 1 });
    await a.close!();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ c: { k: { v: 1 } } });
    expect(await fileStore(path).get('c', 'k')).toEqual({ v: 1 });
  });
  it('sqlite state survives a restart', async () => {
    const path = join(await tmp(), 'state.db');
    const a = sqliteStore(path);
    await a.put('c', 'k', { v: 1 });
    await a.close!();
    expect(await sqliteStore(path).get('c', 'k')).toEqual({ v: 1 });
  });
  it('refuses corrupt state rather than starting over and re-posting everything', async () => {
    const path = join(await tmp(), 'state.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{broken');
    await expect(fileStore(path).get('c', 'k')).rejects.toThrow(/Cannot read/);
  });
  it('concurrent writes all land', async () => {
    const path = join(await tmp(), 'state.json');
    const s = fileStore(path);
    await Promise.all(Array.from({ length: 50 }, (_, i) => s.put('c', `k${i}`, i)));
    await s.close!();
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).c)).toHaveLength(50);
  });
  it('a bot restarted on the same file does not repost', async () => {
    const path = join(await tmp(), 'state.json');
    const target = recordingTarget();
    const make = () => katana({ name: 'b', sources: [list('s', [{ title: 'One story to post here', url: 'https://n.test/1' }])], targets: [target], store: fileStore(path) });
    await make().run();
    await make().run();
    expect(target.posts).toHaveLength(1);
  });
});

describe('MCP server', () => {
  const session = async (bots: any[], messages: object[]) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: any[] = [];
    let buffer = '';
    output.on('data', (c) => {
      buffer += c;
      const parts = buffer.split('\n');
      buffer = parts.pop()!;
      for (const p of parts) if (p) lines.push(JSON.parse(p));
    });
    const done = serveMcp(bots, { input, output });
    for (const m of messages) input.write(`${JSON.stringify(m)}\n`);
    input.write('not json\n');
    input.end();
    await done;
    await new Promise((r) => setImmediate(r));
    return lines;
  };
  const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  it('handshakes and lists tools', async () => {
    const target = recordingTarget();
    const bot = katana({ name: 'b', sources: [list('s', [])], targets: [target] });
    const out = await session([bot], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'nope' },
    ]);
    expect(out.find((m) => m.id === 1).result.protocolVersion).toBe('2025-06-18');
    expect(out.find((m) => m.id === 2).result.tools.map((t: any) => t.name)).toEqual(['katana_preview', 'katana_status', 'katana_run']);
    expect(out.find((m) => m.id === 3).error.code).toBe(-32601);
    expect(out.find((m) => m.error?.code === -32700)).toBeTruthy();
  });
  it('previews without posting, and refuses to publish without confirmation', async () => {
    const target = recordingTarget();
    const bot = katana({ name: 'b', sources: [list('s', [{ title: 'One story to post here', url: 'https://n.test/1' }])], targets: [target] });
    const out = await session([bot], [call(1, 'katana_preview'), call(2, 'katana_run'), call(3, 'katana_status')]);
    expect(JSON.parse(out.find((m) => m.id === 1).result.content[0].text).drafts).toHaveLength(1);
    expect(out.find((m) => m.id === 2).result.isError).toBe(true);
    expect(target.posts).toHaveLength(0);
    expect(JSON.parse(out.find((m) => m.id === 3).result.content[0].text).seen).toBe(0);
  });
  it('publishes when confirmed', async () => {
    const target = recordingTarget();
    const bot = katana({ name: 'b', sources: [list('s', [{ title: 'One story to post here', url: 'https://n.test/1' }])], targets: [target] });
    await session([bot], [call(1, 'katana_run', { confirm: true })]);
    expect(target.posts).toHaveLength(1);
  });
  it('asks which bot when there are several', async () => {
    const mk = (name: string) => katana({ name, sources: [list('s', [])], targets: [recordingTarget()] });
    const out = await session([mk('a'), mk('b')], [call(1, 'katana_status'), call(2, 'katana_status', { bot: 'a' }), call(3, 'katana_status', { bot: 'zzz' })]);
    expect(out.find((m) => m.id === 1).result.isError).toBe(true);
    expect(out.find((m) => m.id === 2).result.isError).toBeUndefined();
    expect(out.find((m) => m.id === 3).result.isError).toBe(true);
  });
});
