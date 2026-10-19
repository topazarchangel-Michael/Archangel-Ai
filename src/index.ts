import 'dotenv/config';
import { Hono, type Context, type Next } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, images, ready, USER_TABLES, dbKind, IMAGE_STORE } from './db.js';
import * as xai from './xai.js';
import * as ai from './providers.js';
import * as billing from './billing.js';

const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = process.env.JWT_SECRET ?? '';
if (JWT_SECRET.length < 32) { console.error('JWT_SECRET must be set (32+ chars) in .env'); process.exit(1); }
const INVITE_CODES = (process.env.INVITE_CODES ?? 'ARCHANGEL-TEST').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const REQUIRE_INVITE = process.env.REQUIRE_INVITE === 'true';
const LIMITS = { chatPerMin: Number(process.env.RATE_CHAT_PER_MIN ?? 20), imagesPerHour: Number(process.env.RATE_IMAGES_PER_HOUR ?? 10), authPerMin: 10 };

type Vars = { userId: string };
const app = new Hono<{ Variables: Vars }>();
const id = () => crypto.randomUUID();
const now = () => Date.now();
const err = (c: Context, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as 400);

app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use('*', bodyLimit({ maxSize: 256 * 1024, onError: (c) => err(c, 413, 'too_large', 'That request is too large.') }));
app.onError((e, c) => {
  if (e instanceof billing.PaywallError) return c.json({ error: { code: 'limit_reached', message: e.kind === 'chat'
    ? `You've used all ${e.info.limit} free chats for today.` : `You've used all ${e.info.limit} images for today.`, paywall: { kind: e.kind, ...e.info } } }, 402);
  if (e instanceof xai.UpstreamError) return err(c, e.status, e.code, e.message);
  console.error(e); return err(c, 500, 'server_error', 'Something went wrong on the server.');
});

// --- rate limiting (in-memory sliding window, per key) ---
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const t = now(); const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(t); hits.set(key, arr); return false;
}
const rate = (name: string, max: number, windowMs: number) => async (c: Context<{ Variables: Vars }>, next: Next) => {
  const who = c.get('userId') ?? c.req.header('x-forwarded-for') ?? c.req.header('cf-connecting-ip') ?? 'anon';
  if (limited(`${name}:${who}`, max, windowMs)) return err(c, 429, 'rate_limited', 'You’re going a bit fast. Please wait a moment and try again.');
  await next();
};

// --- auth ---
const sign = (userId: string) => jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '30d' });
const auth = async (c: Context<{ Variables: Vars }>, next: Next) => {
  const h = c.req.header('Authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    const p = jwt.verify(tok, JWT_SECRET) as { sub: string };
    if (!(await db.get('SELECT 1 FROM users WHERE id=?', p.sub))) throw new Error('gone');
    c.set('userId', p.sub);
  } catch { return err(c, 401, 'unauthorized', 'Please log in again.'); }
  await next();
};
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const publicUser = (u: any) => ({ id: u.id, email: u.email, name: u.name, isTester: !!u.is_tester });

app.get('/health', (c) => c.json({ ok: true, db: dbKind, imageStore: IMAGE_STORE, chatProviders: ai.chatChain(), imageProvider: process.env.IMAGE_PROVIDER ?? 'xai', inviteRequired: REQUIRE_INVITE }));

app.post('/auth/signup', rate('auth', LIMITS.authPerMin, 60_000), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const email = str(b.email, 254).toLowerCase(); const name = str(b.name, 60) || email.split('@')[0]; const password = typeof b.password === 'string' ? b.password : '';
  const invite = str(b.inviteCode, 64).toUpperCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return err(c, 400, 'bad_email', 'Enter a valid email address.');
  if (password.length < 8 || password.length > 128) return err(c, 400, 'bad_password', 'Password must be 8–128 characters.');
  if (invite && !INVITE_CODES.includes(invite)) return err(c, 400, 'bad_invite', 'That invite code isn’t valid.');
  if (REQUIRE_INVITE && !invite) return err(c, 400, 'invite_required', 'An invite code is required during testing.');
  if (await db.get('SELECT 1 FROM users WHERE email=?', email)) return err(c, 409, 'email_taken', 'An account with that email already exists. Try logging in.');
  const u = { id: id(), email, name, password_hash: await bcrypt.hash(password, 10), invite_code: invite || null, is_tester: invite ? 1 : 0, created_at: now() };
  await db.run('INSERT INTO users (id,email,name,password_hash,invite_code,is_tester,created_at) VALUES (?,?,?,?,?,?,?)', u.id, u.email, u.name, u.password_hash, u.invite_code, u.is_tester, u.created_at);
  return c.json({ token: sign(u.id), user: publicUser(u) }, 201);
});

app.post('/auth/login', rate('auth', LIMITS.authPerMin, 60_000), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const u: any = await db.get('SELECT * FROM users WHERE email=?', str(b.email, 254).toLowerCase());
  if (!u || typeof b.password !== 'string' || !(await bcrypt.compare(b.password, u.password_hash))) return err(c, 401, 'bad_credentials', 'Incorrect email or password.');
  return c.json({ token: sign(u.id), user: publicUser(u) });
});

// public image files (unguessable ids)
app.get('/files/:name', async (c) => {
  const name = path.basename(c.req.param('name'));
  if (!/^[0-9a-f-]+\.(png|jpg)$/.test(name)) return c.notFound();
  const img = await images.read(name);
  if (!img) return c.notFound();
  return c.body(new Uint8Array(img.data), 200, { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
});

const api = new Hono<{ Variables: Vars }>();
api.use('*', auth);

api.get('/me', async (c) => c.json({ user: publicUser(await db.get('SELECT * FROM users WHERE id=?', c.get('userId'))) }));
api.delete('/me', async (c) => {
  const uid = c.get('userId');
  const files = await db.all<{ image_file: string }>('SELECT image_file FROM creations WHERE user_id=? AND image_file IS NOT NULL', uid);
  for (const f of files) await images.remove(f.image_file);
  // explicit deletes (don't rely on ON DELETE CASCADE, which hosted DBs may not enforce)
  await db.batch([...USER_TABLES.map((t) => [`DELETE FROM ${t} WHERE user_id=?`, uid] as [string, string]), ['DELETE FROM users WHERE id=?', uid]]);
  return c.json({ deleted: true });
});

api.get('/profile', async (c) => {
  const r: any = await db.get('SELECT data, updated_at FROM profiles WHERE user_id=?', c.get('userId'));
  return c.json({ profile: r ? JSON.parse(r.data) : null, updatedAt: r?.updated_at ?? 0 });
});
api.put('/profile', async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b.profile !== 'object') return err(c, 400, 'bad_profile', 'Invalid profile.');
  const p = b.profile;
  const clean = {
    name: str(p.name, 40), description: str(p.description, 500), voice: str(p.voice, 40),
    traits: Array.isArray(p.traits) ? p.traits.slice(0, 10).map((t: unknown) => str(t, 40)) : [],
    memories: Array.isArray(p.memories) ? p.memories.slice(0, 100).map((t: unknown) => str(t, 300)) : [],
    skills: Array.isArray(p.skills) ? p.skills.slice(0, 30).map((s: any) => ({ id: str(s?.id, 40), name: str(s?.name, 60), on: !!s?.on })) : [],
    readAloud: !!p.readAloud, notifications: !!p.notifications, onboarded: !!p.onboarded,
  };
  await db.run('INSERT INTO profiles (user_id,data,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at', c.get('userId'), JSON.stringify(clean), now());
  return c.json({ profile: clean });
});

function systemPrompt(p: any): string {
  if (!p) return 'You are a helpful personal AI in the Archangel AI app.';
  const skills = (p.skills ?? []).filter((s: any) => s.on).map((s: any) => s.name).join(', ') || 'none';
  return [`You are ${p.name || 'Seraph'}, the user's personal AI in the Archangel AI app.`,
    `Personality: ${(p.traits ?? []).join(', ') || 'helpful'}. ${p.description ?? ''}`, `Enabled skills: ${skills}.`,
    p.memories?.length ? `Things you remember about the user:\n- ${p.memories.join('\n- ')}` : '',
    'Keep replies concise and friendly. Plain text, no markdown headings.'].filter(Boolean).join('\n');
}

api.post('/chat', rate('chat', LIMITS.chatPerMin, 60_000), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-30)
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.text === 'string')
    .map((m: any) => ({ role: m.role, content: m.text.slice(0, 4000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return err(c, 400, 'bad_messages', 'Send at least one message.');
  const mode = b.mode === 'writing' ? 'writing' : 'chat';
  const row: any = await db.get('SELECT data FROM profiles WHERE user_id=?', c.get('userId'));
  const sys = mode === 'writing'
    ? 'You are a skilled copywriter in the Archangel AI Studio. Write exactly what the user asks for: polished, ready to use, no preamble. Keep it under 150 words unless asked otherwise.'
    : systemPrompt(b.profile ?? (row ? JSON.parse(row.data) : null));
  const spend = await billing.consume(c.get('userId'), 'chat');
  let r;
  try { r = await ai.chat([{ role: 'system', content: sys }, ...msgs], { maxTokens: mode === 'writing' ? 400 : 600 }); }
  catch (e) { await spend.refund(); throw e; }
  return c.json({ reply: r.reply, provider: r.provider, model: r.model, billing: await billing.status(c.get('userId')) });
});

api.get('/chats', async (c) => c.json({ chats: (await db.all('SELECT id,title,messages,updated_at FROM chats WHERE user_id=? ORDER BY updated_at DESC LIMIT 100', c.get('userId')))
  .map((r) => ({ id: r.id, title: r.title, messages: JSON.parse(r.messages), updatedAt: r.updated_at })) }));
api.put('/chats/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const cid = str(c.req.param('id'), 64);
  const messages = (Array.isArray(b.messages) ? b.messages : []).slice(-200).map((m: any) => ({ id: str(m?.id, 64), role: m?.role === 'user' ? 'user' : 'assistant', text: str(m?.text, 8000), createdAt: Number(m?.createdAt) || now() }));
  const owner: any = await db.get('SELECT user_id FROM chats WHERE id=?', cid);
  if (owner && owner.user_id !== c.get('userId')) return err(c, 404, 'not_found', 'Chat not found.');
  await db.run('INSERT INTO chats (id,user_id,title,messages,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, messages=excluded.messages, updated_at=excluded.updated_at', cid, c.get('userId'), str(b.title, 80) || 'Chat', JSON.stringify(messages), now());
  return c.json({ ok: true });
});

const creationOut = (r: any, base: string) => ({ id: r.id, kind: r.kind, title: r.title, prompt: r.prompt, text: r.text ?? undefined, imageUrl: r.image_file ? `${base}/files/${r.image_file}` : undefined, createdAt: r.created_at });
const baseUrl = (c: Context) => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const host = c.req.header('x-forwarded-host');
  if (host) return `${c.req.header('x-forwarded-proto') ?? 'https'}://${host.split(',')[0].trim()}${(c.req.header('x-forwarded-prefix') ?? '').replace(/\/+$/, '')}`;
  return new URL(c.req.url).origin;
};

api.get('/creations', async (c) => c.json({ creations: (await db.all('SELECT * FROM creations WHERE user_id=? ORDER BY created_at DESC LIMIT 200', c.get('userId'))).map((r) => creationOut(r, baseUrl(c))) }));
api.post('/creations', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const r = { id: id(), user_id: c.get('userId'), kind: 'text', title: str(b.title, 80) || 'Writing', prompt: str(b.prompt, 1000), text: str(b.text, 8000), image_file: null, created_at: now() };
  if (!r.text) return err(c, 400, 'bad_creation', 'Nothing to save.');
  await db.run('INSERT INTO creations VALUES (?,?,?,?,?,?,?,?)', r.id, r.user_id, r.kind, r.title, r.prompt, r.text, r.image_file, r.created_at);
  return c.json({ creation: creationOut(r, baseUrl(c)) }, 201);
});
api.delete('/creations/:id', async (c) => {
  const r: any = await db.get('SELECT image_file FROM creations WHERE id=? AND user_id=?', c.req.param('id'), c.get('userId'));
  if (!r) return err(c, 404, 'not_found', 'Creation not found.');
  await db.run('DELETE FROM creations WHERE id=?', c.req.param('id'));
  if (r.image_file) await images.remove(r.image_file);
  return c.json({ deleted: true });
});

api.post('/images', rate('images', LIMITS.imagesPerHour, 3_600_000), async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const prompt = str(b.prompt, 1000);
  if (prompt.length < 3) return err(c, 400, 'bad_prompt', 'Describe the image you want (at least a few words).');
  const spend = await billing.consume(c.get('userId'), 'image');
  let img;
  try { img = await ai.image(prompt); } catch (e) { await spend.refund(); throw e; }
  const fileId = id(); const file = `${fileId}.${img.ext}`;
  await images.save(file, img.data, c.get('userId'));
  const r = { id: fileId, user_id: c.get('userId'), kind: 'image', title: prompt.split(/\s+/).slice(0, 5).join(' '), prompt, text: null, image_file: file, created_at: now() };
  await db.run('INSERT INTO creations VALUES (?,?,?,?,?,?,?,?)', r.id, r.user_id, r.kind, r.title, r.prompt, r.text, r.image_file, r.created_at);
  return c.json({ creation: creationOut(r, baseUrl(c)), provider: img.provider, model: img.model, billing: await billing.status(c.get('userId')) }, 201);
});

const REASONS = ['harmful', 'inaccurate', 'inappropriate', 'other'];
api.post('/reports', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const list = (Array.isArray(b.reports) ? b.reports : [b]).slice(0, 50);
  const accepted: string[] = [];
  for (const r of list) {
    if (!REASONS.includes(r?.reason) || !['chat_message', 'creation'].includes(r?.type)) continue;
    const rid = str(r.reportId, 64) || id();
    await db.run('INSERT OR IGNORE INTO reports VALUES (?,?,?,?,?,?,?,?)', rid, c.get('userId'), r.type, str(r.id, 64), str(r.excerpt, 500), r.reason, str(r.note, 500) || null, Number(r.createdAt) || now());
    accepted.push(rid);
  }
  if (!accepted.length) return err(c, 400, 'bad_report', 'Invalid report.');
  return c.json({ accepted }, 201);
});

// ---- Billing ----
app.get('/billing/products', (c) => c.json({ mode: billing.MODE, currency: 'AUD', pricesAreSuggestions: true, limits: billing.LIMITS, costs: billing.COST, products: billing.PRODUCTS }));
app.post('/billing/webhooks/revenuecat', async (c) => {
  const secret = process.env.REVENUECAT_WEBHOOK_AUTH ?? '';
  if (!secret || c.req.header('authorization') !== secret) return err(c, 401, 'unauthorized', 'Bad webhook auth.');
  return c.json(await billing.handleRevenueCat(await c.req.json().catch(() => ({}))));
});
api.get('/billing/status', async (c) => c.json(await billing.status(c.get('userId'))));
api.get('/billing/history', async (c) => c.json({ purchases: await billing.history(c.get('userId')) }));
api.post('/billing/purchase', async (c) => {
  if (billing.MODE !== 'test') return err(c, 400, 'store_only', 'Purchases are made through the App Store / Google Play.');
  const b = await c.req.json().catch(() => ({}));
  const p = billing.product(str(b.productId, 64));
  if (!p) return err(c, 404, 'unknown_product', 'That product doesn’t exist.');
  const st = await billing.status(c.get('userId'));
  if (p.kind === 'item' && st.ownedItems.includes(p.id)) return err(c, 409, 'already_owned', 'You already own this.');
  return c.json({ test: true, charged: false, product: p, status: await billing.grant(c.get('userId'), p, { store: 'test', test: true }) });
});
api.post('/billing/restore', async (c) => c.json(await billing.restore(c.get('userId'))));
api.post('/billing/test/cancel', async (c) => billing.MODE === 'test' ? c.json(await billing.cancelTestSubscription(c.get('userId'))) : err(c, 400, 'store_only', 'Manage subscriptions in your store account.'));

app.route('/', api);
await ready; await billing.ready;
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => console.log(`Archangel backend on :${PORT} (db: ${dbKind}, images stored: ${IMAGE_STORE}, chat: ${ai.chatChain().join(' > ') || 'NONE'}, images: ${process.env.IMAGE_PROVIDER ?? 'xai'}, invites: ${INVITE_CODES.length})`));
