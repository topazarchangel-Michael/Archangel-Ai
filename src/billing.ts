/**
 * Monetisation: plans (free/pro), credits, owned shop items, daily allowances.
 * TEST MODE (BILLING_MODE=test, default): POST /billing/purchase grants immediately and records test=1.
 * LIVE MODE (BILLING_MODE=live): purchases come only from the store via RevenueCat webhooks
 * (POST /billing/webhooks/revenuecat), and /billing/purchase refuses.
 */
import crypto from 'node:crypto';
import { db, ready as dbReady } from './db.js';

export const ready = (async () => { await dbReady; await db.exec(`
CREATE TABLE IF NOT EXISTS entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, pro_product TEXT, pro_expires_at INTEGER,
  pro_source TEXT, credits INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id TEXT NOT NULL,
  kind TEXT NOT NULL, store TEXT NOT NULL, transaction_id TEXT, test INTEGER NOT NULL, amount_aud REAL,
  created_at INTEGER NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS owned_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id TEXT NOT NULL, acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id));
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
  chats INTEGER NOT NULL DEFAULT 0, images INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, type TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
`); })();

const num = (k: string, d: number) => Number(process.env[k] ?? d);
export const MODE = (process.env.BILLING_MODE ?? 'test') === 'live' ? 'live' : 'test';
const TZ = process.env.BILLING_TZ ?? 'Australia/Sydney';
export const LIMITS = {
  free: { chats: num('FREE_CHATS_PER_DAY', 15), images: num('FREE_IMAGES_PER_DAY', 2) },
  pro: { chats: num('PRO_CHATS_PER_DAY', 300), images: num('PRO_IMAGES_PER_DAY', 30) },
};
/** Credits spent once the daily allowance is used up. */
export const COST = { chat: num('CREDIT_COST_CHAT', 1), image: num('CREDIT_COST_IMAGE', 3) };
const PRO_BONUS_CREDITS = num('PRO_MONTHLY_BONUS_CREDITS', 50);
const adminEmails = () => (process.env.ADMIN_PRO_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

type Kind = 'subscription' | 'credits' | 'item';
export type Product = { id: string; kind: Kind; title: string; description: string; priceAud: number; period?: 'month' | 'year';
  credits?: number; category?: 'voice' | 'personality' | 'theme' | 'style'; badge?: string };
/** Store product IDs. Prices are SUGGESTED AUD tiers, real prices are set in App Store Connect / Play Console. */
export const PRODUCTS: Product[] = [
  { id: 'archangel_pro_monthly', kind: 'subscription', period: 'month', title: 'Pro Monthly', priceAud: 9.99, description: `${LIMITS.pro.chats} chats & ${LIMITS.pro.images} images a day, ${PRO_BONUS_CREDITS} bonus credits a month, premium voices.` },
  { id: 'archangel_pro_yearly', kind: 'subscription', period: 'year', title: 'Pro Yearly', priceAud: 79.99, badge: 'Save 33%', description: 'Everything in Pro Monthly, billed yearly.' },
  { id: 'credits_30', kind: 'credits', credits: 30, title: '30 credits', priceAud: 2.99, description: 'About 10 extra images.' },
  { id: 'credits_100', kind: 'credits', credits: 100, title: '100 credits', priceAud: 7.99, badge: 'Popular', description: 'About 33 extra images.' },
  { id: 'credits_300', kind: 'credits', credits: 300, title: '300 credits', priceAud: 19.99, badge: 'Best value', description: 'About 100 extra images.' },
  { id: 'voice_aurora', kind: 'item', category: 'voice', title: 'Aurora voice', priceAud: 2.99, description: 'A warm, calm premium voice.' },
  { id: 'voice_atlas', kind: 'item', category: 'voice', title: 'Atlas voice', priceAud: 2.99, description: 'A deep, steady premium voice.' },
  { id: 'persona_mentor', kind: 'item', category: 'personality', title: 'Wise Mentor pack', priceAud: 3.99, description: 'Thoughtful coaching personality and prompts.' },
  { id: 'persona_comedian', kind: 'item', category: 'personality', title: 'Comedian pack', priceAud: 3.99, description: 'Playful, witty personality.' },
  { id: 'theme_celestial', kind: 'item', category: 'theme', title: 'Celestial theme & avatars', priceAud: 1.99, description: 'Starfield theme and 6 avatar orbs.' },
  { id: 'theme_aurora', kind: 'item', category: 'theme', title: 'Aurora theme & avatars', priceAud: 1.99, description: 'Northern-lights theme and 6 avatar orbs.' },
  { id: 'style_anime', kind: 'item', category: 'style', title: 'Anime studio styles', priceAud: 2.49, description: 'Anime, manga and cel-shaded image styles.' },
  { id: 'style_oil', kind: 'item', category: 'style', title: 'Fine-art studio styles', priceAud: 2.49, description: 'Oil paint, charcoal and impressionist styles.' },
];
/** Items Pro subscribers get included. */
const PRO_INCLUDES = ['voice_aurora', 'voice_atlas'];
export const product = (id: string) => PRODUCTS.find((p) => p.id === id);

const now = () => Date.now();
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
async function ent(uid: string): Promise<any> {
  await db.run('INSERT OR IGNORE INTO entitlements (user_id,credits,updated_at) VALUES (?,0,?)', uid, now());
  return db.get('SELECT * FROM entitlements WHERE user_id=?', uid);
}
async function isAdmin(uid: string) {
  const u: any = await db.get('SELECT email FROM users WHERE id=?', uid);
  return !!u && adminEmails().includes(String(u.email).toLowerCase());
}
const usage = async (uid: string) => (await db.get<any>('SELECT chats,images FROM usage_daily WHERE user_id=? AND day=?', uid, today())) ?? { chats: 0, images: 0 };

export async function status(uid: string) {
  const e = await ent(uid);
  const admin = await isAdmin(uid);
  const pro = admin || (e.pro_expires_at ?? 0) > now();
  const plan: 'pro' | 'free' = pro ? 'pro' : 'free';
  const lim = LIMITS[plan];
  const u = await usage(uid);
  const owned = (await db.all('SELECT item_id FROM owned_items WHERE user_id=?', uid)).map((r: any) => r.item_id as string);
  return {
    mode: MODE, plan,
    pro: pro ? { productId: admin ? 'admin_grant' : e.pro_product, expiresAt: admin ? null : e.pro_expires_at, source: admin ? 'admin' : e.pro_source, willRenew: !admin } : null,
    credits: e.credits as number,
    usage: { day: today(), chats: u.chats as number, images: u.images as number },
    limits: lim, costs: COST,
    ownedItems: Array.from(new Set([...owned, ...(pro ? PRO_INCLUDES : [])])),
  };
}

/** Called before an AI action. Uses the daily allowance first, then credits; throws a paywall error otherwise. */
export class PaywallError extends Error { constructor(public kind: 'chat' | 'image', public info: any) { super('limit'); } }
export async function consume(uid: string, kind: 'chat' | 'image') {
  const s = await status(uid);
  const col = kind === 'chat' ? 'chats' : 'images';
  const used = s.usage[col]; const limit = s.limits[col];
  const cost = COST[kind];
  let paidWith: 'allowance' | 'credits';
  if (used < limit) paidWith = 'allowance';
  else if (s.credits >= cost) paidWith = 'credits';
  else throw new PaywallError(kind, { plan: s.plan, used, limit, credits: s.credits, cost });
  const day = today();
  const stmts: [string, ...unknown[]][] = [[`INSERT INTO usage_daily (user_id,day,${col}) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET ${col}=${col}+1`, uid, day]];
  if (paidWith === 'credits') stmts.unshift(['UPDATE entitlements SET credits=credits-?, updated_at=? WHERE user_id=? AND credits>=?', cost, now(), uid, cost]);
  await db.batch(stmts);
  return { paidWith, refund: async () => {
    const r: [string, ...unknown[]][] = [[`UPDATE usage_daily SET ${col}=MAX(${col}-1,0) WHERE user_id=? AND day=?`, uid, day]];
    if (paidWith === 'credits') r.push(['UPDATE entitlements SET credits=credits+? WHERE user_id=?', cost, uid]);
    await db.batch(r);
  } };
}

/** Apply a purchase (test grant or verified store event). Idempotent on transaction_id. */
export async function grant(uid: string, p: Product, opts: { store: string; test: boolean; transactionId?: string; expiresAt?: number }) {
  if (opts.transactionId && await db.get('SELECT 1 FROM purchases WHERE transaction_id=? AND store=?', opts.transactionId, opts.store)) return status(uid);
  const e = await ent(uid);
  let expires: number | null = null;
  const stmts: [string, ...unknown[]][] = [];
  if (p.kind === 'subscription') {
    const base = Math.max(now(), e.pro_expires_at ?? 0);
    expires = opts.expiresAt ?? base + (p.period === 'year' ? 365 : 30) * 86_400_000;
    stmts.push(['UPDATE entitlements SET pro_product=?, pro_expires_at=?, pro_source=?, credits=credits+?, updated_at=? WHERE user_id=?', p.id, expires, opts.test ? 'test' : opts.store, PRO_BONUS_CREDITS, now(), uid]);
  } else if (p.kind === 'credits') {
    stmts.push(['UPDATE entitlements SET credits=credits+?, updated_at=? WHERE user_id=?', p.credits ?? 0, now(), uid]);
  } else {
    stmts.push(['INSERT OR IGNORE INTO owned_items VALUES (?,?,?)', uid, p.id, now()]);
  }
  stmts.push(['INSERT INTO purchases VALUES (?,?,?,?,?,?,?,?,?,?)', crypto.randomUUID(), uid, p.id, p.kind, opts.store, opts.transactionId ?? null, opts.test ? 1 : 0, p.priceAud, now(), expires]);
  await db.batch(stmts);
  return status(uid);
}

/** Restore: rebuild non-consumable items and the latest active subscription from the purchase ledger. */
export async function restore(uid: string) {
  const rows = await db.all('SELECT * FROM purchases WHERE user_id=? ORDER BY created_at', uid);
  const stmts: [string, ...unknown[]][] = rows.filter((r: any) => r.kind === 'item').map((r: any) => ['INSERT OR IGNORE INTO owned_items VALUES (?,?,?)', uid, r.product_id, r.created_at]);
  const sub = rows.filter((r: any) => r.kind === 'subscription' && (r.expires_at ?? 0) > now()).pop();
  if (sub) stmts.push(['UPDATE entitlements SET pro_product=?, pro_expires_at=MAX(COALESCE(pro_expires_at,0),?), updated_at=? WHERE user_id=?', sub.product_id, sub.expires_at, now(), uid]);
  const res = stmts.length ? await db.batch(stmts) : [];
  const restored = res.slice(0, rows.filter((r: any) => r.kind === 'item').length).reduce((n, r) => n + r.changes, 0);
  return { restored, purchases: rows.length, status: await status(uid) };
}

export async function history(uid: string) {
  return (await db.all('SELECT product_id,kind,store,test,amount_aud,created_at,expires_at FROM purchases WHERE user_id=? ORDER BY created_at DESC LIMIT 50', uid))
    .map((r: any) => ({ productId: r.product_id, kind: r.kind, store: r.store, test: !!r.test, priceAud: r.amount_aud, createdAt: r.created_at, expiresAt: r.expires_at }));
}

export async function cancelTestSubscription(uid: string) {
  await db.run("UPDATE entitlements SET pro_expires_at=?, updated_at=? WHERE user_id=? AND pro_source='test'", now() - 1, now(), uid);
  return status(uid);
}

/**
 * RevenueCat webhook (stub, ready for live). Configure in RevenueCat > Integrations > Webhooks with an
 * Authorization header equal to REVENUECAT_WEBHOOK_AUTH. app_user_id must be our user id (set via Purchases.logIn).
 */
export async function handleRevenueCat(body: any) {
  const ev = body?.event ?? {};
  await db.run('INSERT OR IGNORE INTO billing_events VALUES (?,?,?,?,?)', String(ev.id ?? crypto.randomUUID()), 'revenuecat', String(ev.type ?? ''), JSON.stringify(body).slice(0, 20000), now());
  const uid = String(ev.app_user_id ?? '');
  if (!uid || !(await db.get('SELECT 1 FROM users WHERE id=?', uid))) return { handled: false, reason: 'unknown_user' };
  const p = product(String(ev.product_id ?? ''));
  const store = String(ev.store ?? 'revenuecat').toLowerCase();
  const test = ev.environment === 'SANDBOX';
  switch (ev.type) {
    case 'INITIAL_PURCHASE': case 'RENEWAL': case 'NON_RENEWING_PURCHASE': case 'UNCANCELLATION': case 'PRODUCT_CHANGE':
      if (!p) return { handled: false, reason: 'unknown_product' };
      await grant(uid, p, { store, test, transactionId: String(ev.transaction_id ?? ev.id ?? ''), expiresAt: ev.expiration_at_ms ? Number(ev.expiration_at_ms) : undefined });
      return { handled: true };
    case 'EXPIRATION':
      await db.run('UPDATE entitlements SET pro_expires_at=?, updated_at=? WHERE user_id=?', now() - 1, now(), uid);
      return { handled: true };
    case 'CANCELLATION': // auto-renew turned off; access continues until EXPIRATION
    default:
      return { handled: true, note: 'logged' };
  }
}
