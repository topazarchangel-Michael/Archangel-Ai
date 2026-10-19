/**
 * AI provider layer. Chat tries each provider in CHAT_PROVIDERS order until one succeeds.
 * Providers:
 *  - xai          https://api.x.ai/v1 (XAI_API_KEY)                      paid
 *  - openai_compat any OpenAI-compatible endpoint (OPENAI_COMPAT_BASE_URL/_API_KEY/_MODEL),
 *                 e.g. Groq, OpenRouter (:free models), GitHub Models, Mistral, Cerebras
 *  - pollinations keyless legacy endpoint text.pollinations.ai/openai     free, best-effort
 *  - ollama       local Ollama server (OLLAMA_URL, OLLAMA_MODEL)          free, slow on CPU
 * Images use IMAGE_PROVIDER: pollinations (keyless) or xai.
 */
import { UpstreamError } from './xai.js';
import * as xai from './xai.js';

export type Msg = xai.Msg;
type ChatFn = (messages: Msg[], opts: { maxTokens: number }) => Promise<string>;

const env = (k: string, d = '') => (process.env[k] ?? d).trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([402, 429, 502, 503]);

async function openAiCompatible(name: string, baseUrl: string, key: string, model: string, messages: Msg[], maxTokens: number, timeoutMs: number, retries = 0): Promise<string> {
  try { return await openAiCompatibleOnce(name, baseUrl, key, model, messages, maxTokens, timeoutMs); }
  catch (e) {
    if (retries > 0 && e instanceof UpstreamError && (e as any).httpStatus && RETRYABLE.has((e as any).httpStatus)) {
      await sleep(4000);
      return openAiCompatible(name, baseUrl, key, model, messages, maxTokens, timeoutMs, retries - 1);
    }
    throw e;
  }
}

async function openAiCompatibleOnce(name: string, baseUrl: string, key: string, model: string, messages: Msg[], maxTokens: number, timeoutMs: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new UpstreamError(502, 'ai_unreachable', `${name} couldn’t be reached.`);
  }
  const text = await res.text();
  if (!res.ok) {
    console.warn(`[${name}] HTTP ${res.status}: ${text.slice(0, 200)}`);
    const err = res.status === 429
      ? new UpstreamError(429, 'ai_rate_limited', 'The free AI service is busy. Please wait a moment and try again.')
      : new UpstreamError(502, 'ai_error', `${name} returned an error (${res.status}).`);
    (err as any).httpStatus = res.status;
    throw err;
  }
  let out = '';
  try { out = JSON.parse(text)?.choices?.[0]?.message?.content ?? ''; } catch { /* fallthrough */ }
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!out) throw new UpstreamError(502, 'ai_empty', `${name} returned an empty reply.`);
  return out;
}

export const PROVIDERS: Record<string, { configured: () => boolean; model: () => string; chat: ChatFn }> = {
  xai: {
    configured: () => !!env('XAI_API_KEY'),
    model: () => xai.CHAT_MODEL,
    chat: (m) => xai.chat(m),
  },
  openai_compat: {
    configured: () => !!env('OPENAI_COMPAT_BASE_URL') && !!env('OPENAI_COMPAT_MODEL'),
    model: () => env('OPENAI_COMPAT_MODEL'),
    chat: (m, o) => openAiCompatible('AI provider', env('OPENAI_COMPAT_BASE_URL'), env('OPENAI_COMPAT_API_KEY'), env('OPENAI_COMPAT_MODEL'), m, o.maxTokens, 60_000),
  },
  pollinations: {
    configured: () => true,
    model: () => env('POLLINATIONS_TEXT_MODEL', 'openai'),
    chat: (m, o) => openAiCompatible('Pollinations', env('POLLINATIONS_TEXT_URL', 'https://text.pollinations.ai/openai'), env('POLLINATIONS_API_KEY'), env('POLLINATIONS_TEXT_MODEL', 'openai'), m, o.maxTokens, 45_000, 1),
  },
  ollama: {
    configured: () => !!env('OLLAMA_URL'),
    model: () => env('OLLAMA_MODEL', 'archangel-qwen2.5-1.5b'),
    // Small CPU model: keep the history short and replies brief so latency stays reasonable.
    chat: (m, o) => openAiCompatible('Local AI', `${env('OLLAMA_URL')}/v1`, '', env('OLLAMA_MODEL', 'archangel-qwen2.5-1.5b'),
      [m[0], ...m.slice(1).slice(-6)], Math.min(o.maxTokens, 220), 150_000),
  },
};

export const chatChain = () => env('CHAT_PROVIDERS', 'xai').split(',').map((s) => s.trim()).filter((p) => PROVIDERS[p]?.configured());

/** Runs the chain; returns the first successful reply and which provider produced it. */
export async function chat(messages: Msg[], opts: { maxTokens?: number } = {}): Promise<{ reply: string; provider: string; model: string }> {
  const chain = chatChain();
  if (!chain.length) throw new UpstreamError(503, 'ai_not_configured', 'The AI service isn’t set up on the server yet.');
  let last: unknown;
  for (const p of chain) {
    try {
      const reply = await PROVIDERS[p].chat(messages, { maxTokens: opts.maxTokens ?? 600 });
      return { reply, provider: p, model: PROVIDERS[p].model() };
    } catch (e) {
      last = e;
      if (e instanceof UpstreamError && e.code === 'ai_content_blocked') throw e;
      console.warn(`[chat] ${p} failed (${(e as Error).message}); trying next`);
    }
  }
  if (last instanceof UpstreamError && chain.length === 1) throw last;
  throw new UpstreamError(502, 'ai_all_failed', 'The AI is unavailable right now. Please try again in a minute.');
}

/** Image generation. Returns PNG/JPEG bytes and the file extension. */
export async function image(prompt: string): Promise<{ data: Buffer; ext: 'png' | 'jpg'; provider: string; model: string }> {
  const p = env('IMAGE_PROVIDER', 'xai');
  if (p === 'xai') return { data: await xai.image(prompt), ext: 'png', provider: 'xai', model: xai.IMAGE_MODEL };
  if (p === 'pollinations') {
    const model = env('POLLINATIONS_IMAGE_MODEL', 'flux');
    const seed = Math.floor(Math.random() * 1e9);
    const url = `${env('POLLINATIONS_IMAGE_URL', 'https://image.pollinations.ai/prompt')}/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&private=true&model=${encodeURIComponent(model)}&seed=${seed}`;
    let res: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: env('POLLINATIONS_API_KEY') ? { Authorization: `Bearer ${env('POLLINATIONS_API_KEY')}` } : {} }); }
      catch { throw new UpstreamError(502, 'ai_unreachable', 'The free image service couldn’t be reached. Please try again.'); }
      if (!RETRYABLE.has(res.status) || attempt === 1) break;
      await sleep(4000);
    }
    if (!res) throw new UpstreamError(502, 'ai_unreachable', 'The free image service couldn’t be reached. Please try again.');
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 429) throw new UpstreamError(429, 'ai_rate_limited', 'The free image service is busy. Please wait a minute and try again.');
    if (!res.ok || !type.startsWith('image/')) {
      console.warn(`[pollinations-image] HTTP ${res.status} ${type}`);
      throw new UpstreamError(502, 'ai_error', 'The free image service couldn’t make that image. Please try again.');
    }
    return { data: Buffer.from(await res.arrayBuffer()), ext: type.includes('png') ? 'png' : 'jpg', provider: 'pollinations', model };
  }
  throw new UpstreamError(503, 'ai_not_configured', 'Image generation isn’t set up on the server.');
}
