# Thrive Now Physio CSV import — 2026-06-29

## Task
T-F97890 (HQ UI). Import contract client task lists from two January-2026
CSVs into the Contract Clients module.

## Sources
- Cobble Hill: `~/.hermes/cache/documents/doc_374d7bdcb2c8_Thrive Now Task List - Jan 2026 - Cobble Hill.csv` (12 task rows)
- Duncan:     `~/.hermes/cache/documents/doc_68ecbba4d363_Thrive Now Task List - Jan 2026 - Duncan.csv` (11 task rows — note: IT-009 absent in source, jumps IT-008 → IT-010)

## Safety
- DB backed up to `data/backups/hq.db.pre-thrive-20260629T211414Z` (5.6 MB).
- Dry run was executed first via SQLite SAVEPOINT + ROLLBACK; verified counts
  before committing.

## Tool
`server/scripts/import-thrive-now-physio.js`

Run modes:
```
node server/scripts/import-thrive-now-physio.js          # dry run (preview + rollback)
node server/scripts/import-thrive-now-physio.js --write  # commit
```

The script is idempotent: rerunning matches existing requests via the
`[source: IT-NNN]` marker stamped into each `description` and skips them.

## Mapping
| Source column                                  | Target column                                                                  |
|------------------------------------------------|--------------------------------------------------------------------------------|
| Task ID                                        | `[source: IT-NNN]` line in `description`                                       |
| Task Name                                      | `subject`                                                                      |
| Priority (Low/Medium/High)                     | `priority` (low/normal/high); unknown/empty → `normal`                         |
| Assigned To                                    | `assigned_to` + `Assigned: <name>` line in description                         |
| Splashtop / Employee or Computer for Task      | `Asset hint: ...` line in description (no asset row auto-created)              |
| Date Created (m/d/yyyy)                        | `Source date: ... (YYYY-MM-DD)` line in description; `created_at` = import ts |
| Status (TRUE/FALSE)                            | `status` = `resolved` / `open`                                                 |
| Notes                                          | `description` body before the import metadata footer                           |

## Submitting contact selection
- Cobble Hill → Jenaya (`client_contacts.id=1`, `is_office_manager=1`)
- Duncan      → Michelle (`client_contacts.id=3`, `is_office_manager=1`)

## Result counts (verified via DB query)
| Location            | open | resolved | total |
|---------------------|-----:|---------:|------:|
| Thrive Cobble Hill  |    4 |        8 |    12 |
| Thrive Duncan       |    7 |        4 |    11 |
| **TOTAL**           |   11 |       12 |    23 |

## Idempotency test
Second invocation (`--write`) reported:
```
Summary: inserted=0 skipped=23 errors=0
```
All 23 markers matched, zero duplicates created.

## UI verification
HTTP `GET /api/contract-clients/2` returned:
```json
"counts": { "locations": 2, "contacts": 3, "assets": 0, "requests_total": 23, "requests_open": 11, "portal_users": 0 }
```
Browser screenshot saved at `data/evidence/thrive-now-physio-import/locations-tab.png`
shows both locations with their contact counts and open-request badges.

## Event log
23 `contract_request_events` rows written (`event_type='imported'`),
one per inserted request, with a note naming the source CSV and Task ID.

## Files added/changed
- NEW `server/scripts/import-thrive-now-physio.js`
- `docs/changelog.md` — added 2026-06-29 entry
- `data/backups/hq.db.pre-thrive-20260629T211414Z` (backup)
- `data/evidence/thrive-now-physio-import/SUMMARY.md` (this file)
- `data/evidence/thrive-now-physio-import/locations-tab.png` (screenshot)