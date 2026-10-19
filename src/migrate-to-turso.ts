/**
 * One-off: copy the local SQLite data (data/archangel.db + data/images/*) into Turso.
 * Usage: TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node dist/migrate-to-turso.js
 * Safe to re-run (INSERT OR IGNORE).
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.TURSO_DATABASE_URL; const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) { console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN'); process.exit(1); }
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
const local = createClient({ url: `file:${path.join(DATA_DIR, 'archangel.db')}` });
// importing db.js with TURSO_DATABASE_URL set creates the schema remotely
const { ready, db } = await import('./db.js');
const billing = await import('./billing.js');
await ready; await billing.ready;
const remote = createClient({ url, authToken });
const TABLES = ['users', 'profiles', 'chats', 'creations', 'reports', 'entitlements', 'purchases', 'owned_items', 'usage_daily', 'billing_events'];
for (const t of TABLES) {
  const rows = (await local.execute(`SELECT * FROM ${t}`).catch(() => ({ rows: [] as any[], columns: [] as string[] })));
  if (!rows.rows.length) { console.log(`${t}: 0`); continue; }
  const cols = rows.columns;
  const sql = `INSERT OR IGNORE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  for (let i = 0; i < rows.rows.length; i += 100)
    await remote.batch(rows.rows.slice(i, i + 100).map((r: any) => ({ sql, args: cols.map((c) => r[c]) })), 'write');
  console.log(`${t}: ${rows.rows.length}`);
}
const imgDir = path.join(DATA_DIR, 'images');
const owners = new Map((await local.execute('SELECT image_file, user_id FROM creations WHERE image_file IS NOT NULL')).rows.map((r: any) => [r.image_file, r.user_id]));
let n = 0;
for (const f of fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : []) {
  if (!owners.has(f)) continue;
  await db.run('INSERT OR IGNORE INTO image_blobs VALUES (?,?,?,?,?)', f, owners.get(f), f.endsWith('.jpg') ? 'image/jpeg' : 'image/png', fs.readFileSync(path.join(imgDir, f)), Date.now()); n++;
}
console.log(`images: ${n}`);
