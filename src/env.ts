import { ConfigError } from './types.js';

const vars = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export function optionalEnv(name: string): string | undefined {
  const value = vars()[name];
  return value === '' ? undefined : value;
}

/** Reads a credential at the moment it is needed, so previews work without any secrets. */
export function env(name: string): string {
  const value = optionalEnv(name);
  if (value === undefined) throw new ConfigError(`Missing ${name}. Add it to your environment or .env file.`);
  return value;
}

export function credential(explicit: string | undefined, name: string): () => string {
  return () => explicit ?? env(name);
}
