/**
 * Run all SQL migrations idempotently.
 * Migrations live in db/migrations/ as numbered .sql files.
 * Tracks applied versions in a `_migrations` table.
 */

import Database from 'better-sqlite3';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function runMigrations(dbPath) {
  await mkdir(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Bootstrap migrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Run any migrations not yet applied
  const migrationsDir = resolve(__dirname, 'migrations');
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(db.prepare('SELECT version FROM _migrations').all().map((r) => r.version));

  for (const file of files) {
    const version = Number(file.split('_')[0]);
    if (applied.has(version)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(version, file);
    });
    tx();
  }

  return db;
}

// CLI usage: node db/migrate.js [path]
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || resolve(process.cwd(), 'data/hq.db');
  await runMigrations(target);
  console.log(`migrations applied to ${target}`);
}
