import { ConfigError } from '../types.js';

export interface AiRequest {
  system: string;
  prompt: string;
  imageUrls?: string[];
  maxTokens?: number;
}

/** Any model works: implement `complete` and pass the object to an AI cut. */
export interface Ai {
  name: string;
  complete(request: AiRequest): Promise<string>;
}

/** The model declined. AI cuts drop the item instead of failing the run. */
export class AiRefusal extends Error {
  constructor(message = 'The model declined this request') {
    super(message);
    this.name = 'AiRefusal';
  }
}

export interface ClaudeOptions {
  model?: string;
  /** Short writing tasks do well at `low`. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  apiKey?: string;
  maxTokens?: number;
  /** Bring your own Anthropic client, for example on a cloud platform or in tests. */
  client?: any;
  /** Server-side retry on another model when a request is declined. Claude API only. */
  fallbacks?: boolean;
}

/** Claude through the official Anthropic SDK. Install `@anthropic-ai/sdk` to use it. */
export function claude(options: ClaudeOptions = {}): Ai {
  const model = options.model ?? 'claude-opus-5-5';
  let client: any = options.client;

  const getClient = async () => {
    if (client) return client;
    let Anthropic: any;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      throw new ConfigError('claude() needs the Anthropic SDK. Run: npm install @anthropic-ai/sdk');
    }
    client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    return client;
  };

  return {
    name: `claude:${model}`,
    async complete({ system, prompt, imageUrls = [], maxTokens }) {
      const anthropic = await getClient();
      const content = [
        ...imageUrls.map((url) => ({ type: 'image', source: { type: 'url', url } })),
        { type: 'text', text: prompt },
      ];
      const response = await anthropic.beta.messages.create({
        model,
        max_tokens: maxTokens ?? options.maxTokens ?? 16000,
        output_config: { effort: options.effort ?? 'low' },
        system,
        messages: [{ role: 'user', content }],
        ...(options.fallbacks === false ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
      });
      if (response.stop_reason === 'refusal') throw new AiRefusal();
      const text = response.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('')
        .trim();
      if (!text) throw new Error('Claude returned no text');
      if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of tokens before finishing');
      return text;
    },
  };
}
