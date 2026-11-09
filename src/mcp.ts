import { createInterface } from 'node:readline';
import type { Katana } from './bot.js';

const PROTOCOL = '2025-06-18';

const botArg = { bot: { type: 'string', description: 'Bot name. Optional when the project has one bot.' } };

const TOOLS = [
  {
    name: 'katana_preview',
    description: 'Show the posts a bot would publish right now. Publishes nothing and changes nothing.',
    inputSchema: {
      type: 'object',
      properties: { ...botArg, limit: { type: 'number', description: 'How many posts to draft. Default 5.' }, ai: { type: 'boolean', description: 'Run AI cuts, which cost money. Default false.' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'katana_status',
    description: 'Show what a bot has posted, what is queued, and which deliveries need a human to check them.',
    inputSchema: { type: 'object', properties: botArg },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'katana_run',
    description: 'Run a bot once. This PUBLISHES real posts to real accounts. Only call it after the user has reviewed a preview and clearly asked to publish, and pass confirm: true.',
    inputSchema: {
      type: 'object',
      properties: { ...botArg, confirm: { type: 'boolean', description: 'Must be true. Confirms the user asked to publish.' } },
      required: ['confirm'],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
] as const;

/** Lets AI agents preview and run bots over MCP. Speaks newline-delimited JSON-RPC on stdio. */
export function serveMcp(bots: Katana[], io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<void> {
  const output = io.output ?? process.stdout;
  const send = (message: object) => output.write(`${JSON.stringify(message)}\n`);
  const result = (id: unknown, value: object) => send({ jsonrpc: '2.0', id, result: value });
  const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const findBot = (name?: string): Katana => {
    if (name) {
      const bot = bots.find((b) => b.name === name);
      if (!bot) throw new Error(`No bot named "${name}". Available: ${bots.map((b) => b.name).join(', ')}`);
      return bot;
    }
    if (bots.length !== 1) throw new Error(`Say which bot. Available: ${bots.map((b) => b.name).join(', ')}`);
    return bots[0]!;
  };

  const callTool = async (name: string, args: any): Promise<object> => {
    const bot = findBot(args.bot);
    switch (name) {
      case 'katana_preview':
        return bot.preview({ limit: args.limit, ai: args.ai });
      case 'katana_status':
        return bot.status();
      case 'katana_run':
        if (args.confirm !== true) throw new Error('Publishing needs confirm: true, after the user has asked for it.');
        return bot.run();
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  };

  const handle = async (message: any) => {
    const { id, method, params } = message;
    if (id === undefined) return; // Notifications need no reply.
    switch (method) {
      case 'initialize':
        return result(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'katana', version: '2.0.0' },
        });
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: TOOLS });
      case 'tools/call':
        try {
          const value = await callTool(params.name, params.arguments ?? {});
          return result(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
        } catch (err) {
          return result(id, { isError: true, content: [{ type: 'text', text: (err as Error).message }] });
        }
      default:
        return fail(id, -32601, `Unknown method ${method}`);
    }
  };

  return new Promise((resolve) => {
    const pending = new Set<Promise<void>>();
    const lines = createInterface({ input: io.input ?? process.stdin });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fail(null, -32700, 'Could not parse message');
        return;
      }
      const job: Promise<void> = handle(message).catch((err) => fail((message as any).id ?? null, -32603, (err as Error).message)).finally(() => pending.delete(job)) as Promise<void>;
      pending.add(job);
    });
    lines.on('close', () => void Promise.all(pending).then(() => resolve()));
  });
}
