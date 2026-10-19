/** Thin xAI client. The API key never leaves the server. */
const BASE = (process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/+$/, '');
export const CHAT_MODEL = process.env.XAI_CHAT_MODEL ?? 'grok-4.7';
export const IMAGE_MODEL = process.env.XAI_IMAGE_MODEL ?? 'grok-imagine-image-2.0';

export class UpstreamError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

function key() {
  const k = process.env.XAI_API_KEY ?? '';
  if (!k) throw new UpstreamError(503, 'ai_not_configured', 'The AI service isn’t set up on the server yet.');
  return k;
}

function friendly(status: number, detail: string): UpstreamError {
  if (status === 401 || (status === 400 && /api key/i.test(detail))) return new UpstreamError(502, 'ai_bad_key', 'The server’s AI key was rejected. The app owner needs to update it.');
  if (status === 403 && /credit|licen/i.test(detail)) return new UpstreamError(402, 'ai_no_credits', 'The AI service account has no credits yet, so I can’t do that right now.');
  if (status === 403) return new UpstreamError(502, 'ai_forbidden', 'The AI service refused this request.');
  if (status === 400 && /safety|policy|moderat/i.test(detail)) return new UpstreamError(422, 'ai_content_blocked', 'That request was blocked by the content policy. Try rephrasing it.');
  if (status === 404) return new UpstreamError(502, 'ai_model_missing', 'The configured AI model wasn’t found.');
  if (status === 429) return new UpstreamError(429, 'ai_rate_limited', 'The AI service is busy. Please wait a moment and try again.');
  if (status >= 500) return new UpstreamError(502, 'ai_upstream_down', 'The AI service is having trouble right now. Please try again shortly.');
  return new UpstreamError(502, 'ai_error', `The AI service returned an error (${status}).`);
}

async function call(path: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError(502, 'ai_unreachable', 'The server couldn’t reach the AI service. Please try again.');
  }
  const text = await res.text();
  if (!res.ok) { console.warn(`[xai] ${path} HTTP ${res.status}: ${text.slice(0, 300)}`); throw friendly(res.status, text); }
  try { return JSON.parse(text); } catch { throw new UpstreamError(502, 'ai_bad_response', 'The AI service sent an unreadable reply.'); }
}

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
export async function chat(messages: Msg[]): Promise<string> {
  const json = await call('/chat/completions', { model: CHAT_MODEL, messages });
  const out: string = json?.choices?.[0]?.message?.content ?? '';
  if (!out.trim()) throw new UpstreamError(502, 'ai_empty', 'The AI didn’t return a reply. Please try again.');
  return out;
}

export async function image(prompt: string): Promise<Buffer> {
  const json = await call('/images/generations', { model: IMAGE_MODEL, prompt, n: 1, response_format: 'b64_json' });
  const d = json?.data?.[0];
  if (d?.b64_json) return Buffer.from(d.b64_json, 'base64');
  if (d?.url) {
    const r = await fetch(d.url);
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  }
  throw new UpstreamError(502, 'ai_empty', 'The AI didn’t return an image. Please try again.');
}
