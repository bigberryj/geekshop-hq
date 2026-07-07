// Copy contract-clients rows from /home/byron/projects/geekshop-hq/data/hq.db
// (the "real" DB) into /home/byron/projects/geekshop-hq/server/data/hq.db
// (the dev-server's DB) for browser verification. Read-only on source;
// pure INSERT on destination. Foreign keys ON.
import Database from 'better-sqlite3';

const SRC = '/home/byron/projects/geekshop-hq/data/hq.db';
const DST = '/home/byron/projects/geekshop-hq/server/data/hq.db';

const src = new Database(SRC, { readonly: true });
const dst = new Database(DST);
dst.pragma('foreign_keys = ON');

const tables = [
  'contract_clients',
  'contract_locations',
  'client_contacts',
  'client_assets',
  'contract_requests',
  'contract_request_events',
];

dst.exec('BEGIN');
try {
  for (const t of tables) {
    const cols = dst.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const rows = src.prepare(`SELECT * FROM ${t}`).all();
    const ins = dst.prepare(
      `INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    for (const row of rows) ins.run(...cols.map((c) => row[c]));
    console.log(`${t}: ${rows.length} rows copied`);
  }
  dst.exec('COMMIT');
} catch (e) {
  dst.exec('ROLLBACK');
  throw e;
}
console.log('done.');
