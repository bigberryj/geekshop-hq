# Database & ORM Choice

## Decision

- **Database:** SQLite (WAL mode)
- **ORM:** None; direct `better-sqlite3` prepared statements
- **Decided:** 2026-06-15
- **Decided by:** Byron + Johnny5

## Why SQLite

- GeekShop HQ is a small-business internal tool with one primary operator.
- Local-first operation is valuable: one file, easy backups, simple recovery.
- The current workload is low-concurrency and CRUD-heavy.
- Railway/Postgres can be revisited if/when multi-user remote production becomes important.

## Why no ORM

- The schema is small and explicit migrations are clearer than an ORM layer here.
- `better-sqlite3` prepared statements are fast and simple.
- The project benefits more from small route files and clear SQL than from generated model abstractions.

## Revisit when

- Multiple staff use the app concurrently.
- Remote production deployment needs managed backups/replicas.
- Reporting queries become complex enough that PostgreSQL features would pay off.
