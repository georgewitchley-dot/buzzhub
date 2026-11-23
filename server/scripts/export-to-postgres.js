#!/usr/bin/env node
// Copy every BuzzHub location from the SQLite files into Postgres for the Go server.
//
//   DATABASE_URL=postgres://... node scripts/export-to-postgres.js [--data DIR] [--migrations DIR] [--replace]
//
// Main location -> schema "public", others -> "loc_<slug>". Tables are created with the Go server's
// migrations if they don't exist yet. With --replace, existing rows in the target are deleted first;
// without it the script refuses to touch a schema that already has data. Identity sequences are reset,
// and the server secrets (JWT key, phone-alert VAPID keys) are carried over so staff stay signed in
// and phones keep getting alerts.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const DATA = path.resolve(arg('--data', process.env.DATA_DIR || 'data'));
const MIG = path.resolve(arg('--migrations', path.join(path.dirname(new URL(import.meta.url).pathname), '../../backend/migrations')));
const REPLACE = process.argv.includes('--replace');
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }

const schemaFor = (slug) => (slug === 'main' ? 'public' : `loc_${slug.replace(/-/g, '_')}`);
const q = (id) => `"${id.replace(/"/g, '""')}"`;

const files = [['main', path.join(DATA, 'buzzhub.db')]];
const locDir = path.join(DATA, 'locations');
if (fs.existsSync(locDir)) for (const f of fs.readdirSync(locDir).sort()) if (f.endsWith('.db')) files.push([f.slice(0, -3), path.join(locDir, f)]);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function migrate(schema) {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(4210921)');
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${q(schema)}`);
  await client.query(`SELECT set_config('search_path', $1, true)`, [schema]);
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) {
    const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
    if (done.rowCount) continue;
    await client.query(fs.readFileSync(path.join(MIG, f), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  }
  await client.query('COMMIT');
}

let total = 0;
for (const [slug, file] of files) {
  const schema = schemaFor(slug);
  await migrate(schema);
  const src = new Database(file, { readonly: true, fileMustExist: true });
  const tables = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const pgCols = new Map();
  for (const r of (await client.query('SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1', [schema])).rows) {
    if (!pgCols.has(r.table_name)) pgCols.set(r.table_name, new Map());
    pgCols.get(r.table_name).set(r.column_name, r.data_type);
  }
  await client.query('BEGIN');
  let hasData = false;
  for (const t of tables) if (pgCols.has(t) && t !== 'schema_migrations') {
    const r = await client.query(`SELECT 1 FROM ${q(schema)}.${q(t)} LIMIT 1`);
    if (r.rowCount) hasData = true;
  }
  if (hasData && !REPLACE) { console.error(`${schema} already has data; run with --replace to overwrite it`); process.exit(1); }
  let n = 0;
  for (const t of tables) {
    const cols = pgCols.get(t);
    if (!cols || t === 'schema_migrations') { if (!cols) console.warn(`  skip ${t}: no such table in Postgres`); continue; }
    if (REPLACE) await client.query(`DELETE FROM ${q(schema)}.${q(t)}`);
    const srcCols = src.prepare(`PRAGMA table_info(${q(t)})`).all().map((c) => c.name).filter((c) => cols.has(c));
    const rows = src.prepare(`SELECT ${srcCols.map(q).join(', ')} FROM ${q(t)}`).raw().all();
    const identity = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND is_identity = 'YES'`, [schema, t])).rows.map((r) => r.column_name);
    const override = identity.some((c) => srcCols.includes(c)) ? ' OVERRIDING SYSTEM VALUE' : '';
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const params = []; const tuples = chunk.map((row) => `(${row.map((v, j) => {
        const type = cols.get(srcCols[j]);
        if (type === 'bytea' && typeof v === 'string') v = Buffer.from(v);
        if (type !== 'bytea' && Buffer.isBuffer(v)) v = v.toString('utf8');
        params.push(v); return `$${params.length}`;
      }).join(', ')})`);
      await client.query(`INSERT INTO ${q(schema)}.${q(t)} (${srcCols.map(q).join(', ')})${override} VALUES ${tuples.join(', ')}`, params);
    }
    for (const c of identity) {
      await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE((SELECT MAX(${q(c)}) FROM ${q(schema)}.${q(t)}), 0), 1), (SELECT COUNT(*) > 0 FROM ${q(schema)}.${q(t)}))`, [`${q(schema)}.${q(t)}`, c]);
    }
    n += rows.length;
  }
  await client.query('COMMIT');
  src.close();
  console.log(`${slug} -> ${schema}: ${n} rows`);
  total += n;
}

// carry over server secrets
await client.query('CREATE TABLE IF NOT EXISTS public.app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
for (const [name, file, read] of [['jwt', '.jwt_secret', (s) => s.trim()], ['vapid', '.vapid.json', (s) => JSON.stringify(JSON.parse(s))]]) {
  const p = path.join(DATA, file);
  if (fs.existsSync(p)) {
    await client.query('INSERT INTO public.app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = excluded.value', [name, read(fs.readFileSync(p, 'utf8'))]);
    console.log(`copied ${file}`);
  }
}
await client.end();
console.log(`done: ${total} rows from ${files.length} location(s)`);
