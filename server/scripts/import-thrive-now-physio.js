#!/usr/bin/env node
// Import contract requests from the two Thrive Now Physio January 2026
// task-list CSVs into GeekShop HQ's Contract Clients module.
//
// Idempotent: rerunning will not create duplicates. Dedup key is the
// external Task ID (`IT-NNN`) stamped into the request `description`
// as `[source: IT-NNN]`, enforced with a SELECT before each INSERT.
//
// Mapping summary (see WORKER_PROMPT contract for full spec):
//   - Task ID     -> stamped as `[source: IT-NNN]` in description; not a
//                    dedicated column in v1 schema (preserved verbatim).
//   - Task Name   -> subject
//   - Priority    -> low/normal/high/urgent (low/medium/high -> low/normal/high)
//   - Assigned To -> "Assigned: <name>" line in description; assigned_to column
//                    set to the source initials/csv-stripped value
//   - Splashtop / Employee or Computer -> description "Asset hint: ..." line
//                    (no asset row created without an obvious hostname match)
//   - Date Created-> description "Source date: ..." line; created_at left as
//                    the import timestamp (no source-date column in v1)
//   - Status      -> TRUE -> resolved, FALSE -> open
//   - Notes       -> description body before the metadata footer
//
// Usage:
//   node scripts/import-thrive-now-physio.js
//
// Safe to rerun at any time. Backups live in data/backups/.

import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const DB_PATH = "/home/byron/projects/geekshop-hq/data/hq.db";

const CLIENT_NAME = "Thrive Now Physio";

// Tiny CSV parser — handles double-quoted fields with embedded commas.
function parseCsv(text) {
  const rows = [];
  let cur = "", row = [], q = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cur += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ",") { row.push(cur); cur = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; i++; continue; }
    cur += c; i++;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function trim(s) { return (s == null ? "" : String(s)).trim(); }

function findHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some(c => /^Task ID$/i.test(trim(c)))) return i;
  }
  return -1;
}

function rowsToTasks(rows, startIdx) {
  const tasks = [];
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    const tid = trim(r[0]);
    if (!tid) continue;
    tasks.push({
      task_id: tid,
      name: trim(r[1]),
      priority: trim(r[2]),
      assigned: trim(r[3]),
      asset_hint: trim(r[4]),
      date: trim(r[5]),
      status: trim(r[6]).toUpperCase(), // TRUE / FALSE
      notes: trim(r[7]),
    });
  }
  return tasks;
}

function mapPriority(p) {
  const norm = (p || "").toLowerCase();
  if (norm === "low") return "low";
  if (norm === "high") return "high";
  if (norm === "urgent") return "urgent";
  if (norm === "medium" || norm === "normal" || norm === "") return "normal";
  return "normal";
}

function mapStatus(s) {
  return s === "TRUE" ? "resolved" : "open";
}

function mapSourceDateToIso(d) {
  // Accept m/d/yyyy or m/d/yyyy
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d || "");
  if (!m) return null;
  const [, mo, da, ye] = m;
  const mm = mo.padStart(2, "0");
  const dd = da.padStart(2, "0");
  return `${ye}-${mm}-${dd}`;
}

function buildDescription(task) {
  const meta = [];
  meta.push(`[source: ${task.task_id}]`);
  if (task.asset_hint) meta.push(`Asset hint: ${task.asset_hint}`);
  if (task.assigned) meta.push(`Assigned: ${task.assigned}`);
  if (task.date) {
    const iso = mapSourceDateToIso(task.date);
    if (iso) meta.push(`Source date: ${task.date} (${iso})`);
    else meta.push(`Source date: ${task.date}`);
  }
  const notes = task.notes || "";
  return notes
    ? `${notes}\n\n— import metadata —\n${meta.join("\n")}`
    : `— import metadata —\n${meta.join("\n")}`;
}

function ingestFile(db, filePath, locationLabel, contactId, results) {
  console.log(`\n[ingest] ${filePath}`);
  const text = readFileSync(filePath, "utf8");
  const rows = parseCsv(text);
  const hIdx = findHeader(rows);
  if (hIdx < 0) {
    console.error(`  ! no header row found in ${filePath}`);
    return;
  }
  const tasks = rowsToTasks(rows, hIdx + 1);
  console.log(`  parsed ${tasks.length} task(s)`);

  // Look up the location_id for this file
  const loc = db.prepare(
    "SELECT id FROM contract_locations WHERE label = ? AND client_id = (SELECT id FROM contract_clients WHERE name = ?)"
  ).get(locationLabel, CLIENT_NAME);
  if (!loc) {
    console.error(`  ! location '${locationLabel}' not found for client '${CLIENT_NAME}'`);
    results.errors.push({ file: filePath, error: "location not found" });
    return;
  }
  const locationId = loc.id;

  // Pre-fetch existing source markers to keep this idempotent.
  // contract_requests has no dedicated source column, so we lean on the
  // `[source: IT-NNN]` marker in `description` and filter via LIKE.
  const existingMarkers = new Set(
    db.prepare(
      "SELECT description FROM contract_requests WHERE client_id = (SELECT id FROM contract_clients WHERE name = ?) AND location_id = ?"
    ).all(CLIENT_NAME, locationId).map(r => {
      const m = /\[source:\s*([^\]]+)\]/.exec(r.description || "");
      return m ? m[1].trim() : null;
    }).filter(Boolean)
  );

  const insertStmt = db.prepare(`
    INSERT INTO contract_requests
      (request_uid, client_id, location_id, submitting_contact_id, asset_id,
       subject, description, category, priority, status, assigned_to)
    VALUES (?, (SELECT id FROM contract_clients WHERE name = ?), ?, ?, NULL,
            ?, ?, NULL, ?, ?, ?)
  `);
  const eventStmt = db.prepare(`
    INSERT INTO contract_request_events
      (request_id, actor, event_type, from_status, to_status, note)
    VALUES (?, 'system', 'imported', NULL, ?, ?)
  `);

  for (const t of tasks) {
    if (existingMarkers.has(t.task_id)) {
      console.log(`  skip ${t.task_id} (already imported)`);
      results.skipped.push({ task_id: t.task_id, location: locationLabel });
      continue;
    }
    const client = db.prepare("SELECT id FROM contract_clients WHERE name = ?").get(CLIENT_NAME);
    if (!client) throw new Error(`client ${CLIENT_NAME} vanished`);
    const uid = nextRequestUid(db);
    const description = buildDescription(t);
    const priority = mapPriority(t.priority);
    const status = mapStatus(t.status);

    const txn = db.transaction(() => {
      const info = insertStmt.run(
        uid, CLIENT_NAME, locationId, contactId,
        t.name || `(${t.task_id})`,
        description,
        priority,
        status,
        t.assigned || null
      );
      eventStmt.run(info.lastInsertRowid, status, `Imported from ${filePath.split('/').pop()} (${t.task_id})`);
      return info.lastInsertRowid;
    });
    const id = txn();
    console.log(`  + ${uid} ${t.task_id} ${t.name} [${priority}/${status}] -> req#${id}`);
    results.inserted.push({ task_id: t.task_id, request_uid: uid, id, location: locationLabel, status });
  }
}

// Generate CR-NNNNNN uids
function nextRequestUid(db) {
  const row = db.prepare(
    "SELECT request_uid FROM contract_requests ORDER BY id DESC LIMIT 1"
  ).get();
  let n = 1;
  if (row && row.request_uid) {
    const m = /CR-(\d+)/.exec(row.request_uid);
    if (m) n = Number(m[1]) + 1;
  }
  return `CR-${String(n).padStart(6, "0")}`;
}

// Pick the submitting contact per location.
function pickContact(db, locationLabel) {
  // Prefer the office-manager (is_office_manager=1) for that location.
  const row = db.prepare(`
    SELECT c.id, c.name FROM client_contacts c
    JOIN contract_locations l ON l.id = c.location_id
    JOIN contract_clients cc ON cc.id = c.client_id
    WHERE cc.name = ? AND l.label = ? AND c.status = 'active'
    ORDER BY c.is_office_manager DESC, c.id ASC
    LIMIT 1
  `).get(CLIENT_NAME, locationLabel);
  if (!row) {
    console.error(`  ! no active contact found for ${CLIENT_NAME} / ${locationLabel}`);
    return null;
  }
  console.log(`  submitting contact for ${locationLabel}: id=${row.id} (${row.name})`);
  return row.id;
}

const args = process.argv.slice(2);
const writeMode = args.includes("--write"); // default = dry run

const db = new Database(DB_PATH);
const client = db.prepare("SELECT id FROM contract_clients WHERE name = ?").get(CLIENT_NAME);
if (!client) {
  console.error(`Client '${CLIENT_NAME}' does not exist. Apply migration 033 and create the client first.`);
  process.exit(2);
}
console.log(`Client: ${CLIENT_NAME} (id=${client.id})`);

const results = { inserted: [], skipped: [], errors: [] };

const runAll = db.transaction(() => {
  const cobbleId = pickContact(db, "Thrive Cobble Hill");
  if (cobbleId == null) throw new Error("no contact for Cobble Hill");
  ingestFile(
    db,
    "/home/byron/.hermes/cache/documents/doc_374d7bdcb2c8_Thrive Now Task List - Jan 2026 - Cobble Hill.csv",
    "Thrive Cobble Hill",
    cobbleId,
    results
  );
  const duncanId = pickContact(db, "Thrive Duncan");
  if (duncanId == null) throw new Error("no contact for Duncan");
  ingestFile(
    db,
    "/home/byron/.hermes/cache/documents/doc_68ecbba4d363_Thrive Now Task List - Jan 2026 - Duncan.csv",
    "Thrive Duncan",
    duncanId,
    results
  );
});

if (writeMode) {
  runAll();
  console.log("\n[mode] WRITE — committed");
} else {
  const savepoint = db.savepoint ? `dry_${Date.now()}` : null;
  console.log("\n[mode] DRY RUN — preview only; nothing will be committed.");
  try {
    db.exec("SAVEPOINT dry_run");
    runAll();
    db.exec("ROLLBACK TO SAVEPOINT dry_run; RELEASE SAVEPOINT dry_run;");
    console.log("\n  (dry run rolled back)");
  } catch (e) {
    try { db.exec("ROLLBACK TO SAVEPOINT dry_run; RELEASE SAVEPOINT dry_run;"); } catch {}
    throw e;
  }
}

console.log(`\nSummary: inserted=${results.inserted.length} skipped=${results.skipped.length} errors=${results.errors.length}`);
if (results.inserted.length > 0) {
  console.log("Inserted:", JSON.stringify(results.inserted, null, 2));
}
if (results.skipped.length > 0) {
  console.log("Skipped:", JSON.stringify(results.skipped, null, 2));
}
if (results.errors.length > 0) {
  console.log("Errors:", JSON.stringify(results.errors, null, 2));
  process.exit(1);
}
