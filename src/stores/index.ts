import type { Store } from '../types.js';

type Data = Record<string, Record<string, unknown>>;

/** State in memory. For tests and previews. */
export function memoryStore(): Store {
  const data: Data = {};
  const locks = new Map<string, number>();
  return {
    async get<T>(c: string, k: string) {
      return structuredClone(data[c]?.[k]) as T | undefined;
    },
    async put(c, k, v) {
      (data[c] ??= {})[k] = structuredClone(v);
    },
    async delete(c, k) {
      delete data[c]?.[k];
    },
    async all<T>(c: string) {
      return Object.entries(structuredClone(data[c] ?? {})) as Array<[string, T]>;
    },
    async acquire(name, ttlMs) {
      const until = locks.get(name);
      if (until && until > Date.now()) return false;
      locks.set(name, Date.now() + ttlMs);
      return true;
    },
    async release(name) {
      locks.delete(name);
    },
  };
}

/** State in one JSON file, written atomically. Good for a bot on a single machine. */
export function fileStore(path = '.katana/state.json'): Store {
  let cache: Data | undefined;
  let loading: Promise<Data> | undefined;
  let writing: Promise<void> = Promise.resolve();

  // Shared by concurrent callers. Two separate reads would each create their own copy and lose writes.
  const load = (): Promise<Data> =>
    (loading ??= (async () => {
      const fs = await import('node:fs/promises');
      try {
        cache = JSON.parse(await fs.readFile(path, 'utf8')) as Data;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          loading = undefined;
          throw new Error(`Cannot read Katana state at ${path}: ${(err as Error).message}`);
        }
        cache = {};
      }
      return cache;
    })());

  const save = () => {
    writing = writing.then(async () => {
      const fs = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await fs.mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(cache));
      await fs.rename(temp, path);
    });
    return writing;
  };

  const lockPath = (name: string) => `${path}.${name}.lock`;

  return {
    async get<T>(c: string, k: string) {
      return (await load())[c]?.[k] as T | undefined;
    },
    async put(c, k, v) {
      const data = await load();
      (data[c] ??= {})[k] = JSON.parse(JSON.stringify(v));
      await save();
    },
    async delete(c, k) {
      const data = await load();
      if (data[c]?.[k] === undefined) return;
      delete data[c][k];
      await save();
    },
    async all<T>(c: string) {
      return Object.entries((await load())[c] ?? {}) as Array<[string, T]>;
    },
    async acquire(name, ttlMs) {
      const fs = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await fs.mkdir(dirname(path), { recursive: true });
      const file = lockPath(name);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const handle = await fs.open(file, 'wx');
          await handle.writeFile(String(Date.now() + ttlMs));
          await handle.close();
          loading = undefined; // Another process may have written since we last read.
          return true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          const until = Number(await fs.readFile(file, 'utf8').catch(() => '0'));
          if (until > Date.now()) return false;
          await fs.rm(file, { force: true });
        }
      }
      return false;
    },
    async release(name) {
      const fs = await import('node:fs/promises');
      await fs.rm(lockPath(name), { force: true });
    },
    async close() {
      await writing;
    },
  };
}

/** State in SQLite through Node's built-in module (Node 22.13 or newer). Survives power loss best. */
export function sqliteStore(path = '.katana/state.db'): Store {
  type Db = {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...a: unknown[]): any;
      all(...a: unknown[]): any[];
      run(...a: unknown[]): { changes: number | bigint };
    };
    close(): void;
  };
  let opened: Promise<Db> | undefined;
  const db = () =>
    (opened ??= (async () => {
      const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string) => Db };
      if (path !== ':memory:') {
        const fs = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        await fs.mkdir(dirname(path), { recursive: true });
      }
      const conn = new DatabaseSync(path);
      conn.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS kv (c TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (c, k));
        CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, until INTEGER NOT NULL);`);
      return conn;
    })());

  return {
    async get<T>(c: string, k: string) {
      const row = (await db()).prepare('SELECT v FROM kv WHERE c = ? AND k = ?').get(c, k);
      return row ? (JSON.parse(row.v) as T) : undefined;
    },
    async put(c, k, v) {
      (await db())
        .prepare('INSERT INTO kv (c, k, v) VALUES (?, ?, ?) ON CONFLICT (c, k) DO UPDATE SET v = excluded.v')
        .run(c, k, JSON.stringify(v));
    },
    async delete(c, k) {
      (await db()).prepare('DELETE FROM kv WHERE c = ? AND k = ?').run(c, k);
    },
    async all<T>(c: string) {
      return (await db())
        .prepare('SELECT k, v FROM kv WHERE c = ?')
        .all(c)
        .map((r) => [r.k, JSON.parse(r.v)] as [string, T]);
    },
    async acquire(name, ttlMs) {
      const now = Date.now();
      const result = (await db())
        .prepare('INSERT INTO locks (name, until) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET until = excluded.until WHERE locks.until < ?')
        .run(name, now + ttlMs, now);
      return Number(result.changes) > 0;
    },
    async release(name) {
      (await db()).prepare('DELETE FROM locks WHERE name = ?').run(name);
    },
    async close() {
      if (opened) (await opened).close();
      opened = undefined;
    },
  };
}
