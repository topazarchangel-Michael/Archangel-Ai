/**
 * Database adapter. One code path (@libsql/client) for both:
 *  - local:  a SQLite file on disk (default: file:<DATA_DIR>/archangel.db), same file format as before
 *  - hosted: Turso (free, no card), set TURSO_DATABASE_URL=libsql://<db>.turso.io and TURSO_AUTH_TOKEN
 * Images are stored on disk locally (IMAGE_STORE=disk) or as BLOBs in the database (IMAGE_STORE=db),
 * which is what free hosts with an ephemeral filesystem (Render free) need.
 */
import { createClient, type InArgs, type InStatement } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
const REMOTE = !!process.env.TURSO_DATABASE_URL;
export const IMAGE_STORE = (process.env.IMAGE_STORE ?? (REMOTE ? 'db' : 'disk')) === 'db' ? 'db' : 'disk';
if (!REMOTE || IMAGE_STORE === 'disk') fs.mkdirSync(IMAGE_DIR, { recursive: true });

const client = REMOTE
  ? createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: `file:${path.join(DATA_DIR, 'archangel.db')}` });
export const dbKind = REMOTE ? 'turso' : 'sqlite-file';

const norm = (row: any) => {
  if (!row) return row;
  const o: any = {};
  for (const k of Object.keys(row)) { const v = row[k]; o[k] = v instanceof ArrayBuffer ? Buffer.from(v) : typeof v === 'bigint' ? Number(v) : v; }
  return o;
};
const st = (sql: string, args: unknown[]): InStatement => ({ sql, args: args as InArgs });

/** Async query helpers. `args` are positional (?). */
export const db = {
  async get<T = any>(sql: string, ...args: unknown[]): Promise<T | undefined> { const r = await client.execute(st(sql, args)); return norm(r.rows[0]) as T | undefined; },
  async all<T = any>(sql: string, ...args: unknown[]): Promise<T[]> { const r = await client.execute(st(sql, args)); return r.rows.map(norm) as T[]; },
  async run(sql: string, ...args: unknown[]): Promise<{ changes: number }> { const r = await client.execute(st(sql, args)); return { changes: r.rowsAffected }; },
  /** Atomic multi-statement write. */
  async batch(stmts: [string, ...unknown[]][]): Promise<{ changes: number }[]> {
    const rs = await client.batch(stmts.map(([sql, ...args]) => st(sql, args)), 'write');
    return rs.map((r) => ({ changes: r.rowsAffected }));
  },
  exec: (sql: string) => client.executeMultiple(sql),
};

export const ready = (async () => {
  if (!REMOTE) { await client.execute('PRAGMA journal_mode = WAL'); }
  await client.execute('PRAGMA foreign_keys = ON');
  await client.executeMultiple(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  invite_code TEXT, is_tester INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
  messages TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS creations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  title TEXT NOT NULL, prompt TEXT NOT NULL, text TEXT, image_file TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  excerpt TEXT NOT NULL, reason TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS image_blobs (
  name TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
`);
})();

/** Tables holding per-user rows; deleted explicitly (hosted DBs may not enforce ON DELETE CASCADE per connection). */
export const USER_TABLES = ['profiles', 'chats', 'creations', 'reports', 'image_blobs', 'entitlements', 'purchases', 'owned_items', 'usage_daily'];

// ---- image storage ----
const mimeOf = (name: string) => (name.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
export const images = {
  async save(name: string, data: Buffer, userId: string) {
    if (IMAGE_STORE === 'db') await db.run('INSERT INTO image_blobs VALUES (?,?,?,?,?)', name, userId, mimeOf(name), data, Date.now());
    else fs.writeFileSync(path.join(IMAGE_DIR, name), data);
  },
  async read(name: string): Promise<{ data: Buffer; mime: string } | null> {
    const p = path.join(IMAGE_DIR, name);
    if (fs.existsSync(p)) return { data: fs.readFileSync(p), mime: mimeOf(name) };
    const r = await db.get<{ data: Buffer; mime: string }>('SELECT data, mime FROM image_blobs WHERE name=?', name);
    return r ? { data: r.data, mime: r.mime } : null;
  },
  async remove(name: string) {
    fs.rmSync(path.join(IMAGE_DIR, name), { force: true });
    await db.run('DELETE FROM image_blobs WHERE name=?', name);
  },
};
