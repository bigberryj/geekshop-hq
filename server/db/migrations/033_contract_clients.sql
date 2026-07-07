-- 033 — Contract Clients module
--
-- Adds multi-location contract-client management (replaces the Google Sheets
-- "Contract Clients" workbook Byron was running). Designed to live alongside
-- the existing `customers` / `tickets` tables — contract clients are corporate
-- entities, distinct from one-off paying customers.
--
-- Design choices:
--   • Additive only — no ALTER on existing tables.
--   • Requests are an entirely separate concept (contract_requests), not a
--     flag on `tickets`. A contract-client ticket is a different SLA, a
--     different scope, and a different billing path (covered by the monthly
--     contract, not invoiced per-ticket). They share the file/attachment
--     pipeline where useful, but we do not couple their tables.
--   • Client-portal access uses its own sessions table + magic-link invite
--     table; no new rows in `sessions`.
--   • `editable_after_submission` is reserved but disabled in v1 (see
--     `contract_requests.can_be_edited_until`); schema/API seam keeps the
--     future-edit feature cheap to add without an ALTER.
--
-- Tables added:
--   contract_clients           — corporate entity (the contract holder)
--   contract_locations         — offices / branches of a contract client
--   client_contacts            — people (named + email) attached to a location
--   client_portal_credentials  — login email + password_hash, scoped to a contract client + zero-or-more locations
--   client_portal_sessions     — server-side portal sessions (cookie = hq_csid)
--   client_invites             — magic-link invites so admin can hand portal access to office managers
--   client_assets              — computer/device inventory at a location
--   contract_requests          — requests/tasks submitted by a contact (links client + location + contact + optional asset)
--   contract_request_events    — append-only status/cancellation event log per request
--
-- All FKs use ON DELETE CASCADE for client/contact cascades; assets and
-- requests cascade from their contract_client root via location_id.

-- -- contract_clients ----------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                      -- e.g. 'Acme Holdings'
  status TEXT NOT NULL DEFAULT 'active',   -- active | archived
  primary_contact_name TEXT,
  primary_contact_email TEXT,
  phone TEXT,
  billing_address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contract_clients_status ON contract_clients(status);
CREATE INDEX IF NOT EXISTS idx_contract_clients_name ON contract_clients(name);

-- -- contract_locations --------------------------------------------------
CREATE TABLE IF NOT EXISTS contract_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES contract_clients(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                     -- e.g. 'Vancouver HQ', 'Surrey Branch'
  address TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  timezone TEXT,                           -- IANA tz string; null = assume operator default
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active | archived
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contract_locations_client ON contract_locations(client_id, status);

-- -- client_contacts -----------------------------------------------------
-- A person who can submit requests on behalf of a contract location.
-- Distinct from `customers` (which is a paying individual). Multiple contacts
-- per location supported.
CREATE TABLE IF NOT EXISTS client_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES contract_locations(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES contract_clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT,                               -- free-text, e.g. 'Office Manager', 'IT Coordinator'
  is_office_manager INTEGER NOT NULL DEFAULT 0,  -- 1 = office manager (scope: their location), 0 = regular contact
  notify_on_request INTEGER NOT NULL DEFAULT 1,  -- email notify on request state changes
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_contacts_location ON client_contacts(location_id);
CREATE INDEX IF NOT EXISTS idx_client_contacts_email ON client_contacts(email);

-- -- client_portal_credentials -------------------------------------------
-- ONE row per authorized portal login. Office managers log in here; their
-- scope is determined by `scope_type`:
--   'client_manager'   — sees entire contract client, all locations
--   'location_manager' — sees only the assigned location
-- Locations are encoded as a JSON array on `scoped_location_ids` (NULL for
-- client_manager). Future: a 'request_only' role can submit but not browse.
CREATE TABLE IF NOT EXISTS client_portal_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  contact_id INTEGER REFERENCES client_contacts(id) ON DELETE SET NULL,
  client_id INTEGER NOT NULL REFERENCES contract_clients(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'location_manager', -- 'client_manager' | 'location_manager'
  scoped_location_ids TEXT,                  -- JSON array of location ids; NULL = all locations on the client
  last_login_at TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_portal_creds_client ON client_portal_credentials(client_id);
CREATE INDEX IF NOT EXISTS idx_client_portal_creds_contact ON client_portal_credentials(contact_id);

-- -- client_portal_sessions ----------------------------------------------
-- Mirrors admin sessions but lives under /api/portal/*; cookie name `hq_csid`.
CREATE TABLE IF NOT EXISTS client_portal_sessions (
  id TEXT PRIMARY KEY,                       -- 48-hex cookie value
  credential_id INTEGER NOT NULL REFERENCES client_portal_credentials(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES contract_clients(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_portal_sessions_cred ON client_portal_sessions(credential_id);

-- -- client_invites ------------------------------------------------------
-- Magic-link invites. Admin generates an invite token, sends the URL to the
-- future user; first GET on /api/portal/redeem/:token sets the password and
-- creates a client_portal_credentials row.
CREATE TABLE IF NOT EXISTS client_invites (
  token TEXT PRIMARY KEY,                    -- 32-hex
  email TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES contract_clients(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'location_manager',
  scoped_location_ids TEXT,
  display_name TEXT,
  contact_id INTEGER REFERENCES client_contacts(id) ON DELETE SET NULL,
  invited_by TEXT NOT NULL DEFAULT 'admin',
  expires_at TEXT NOT NULL,                  -- 7-day default
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_invites_email ON client_invites(email);

-- -- client_assets -------------------------------------------------------
-- Manual inventory per location. Schema leaves room for soft-delete and a
-- status enum that mirrors common MSP statuses.
CREATE TABLE IF NOT EXISTS client_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES contract_clients(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES contract_locations(id) ON DELETE CASCADE,
  hostname TEXT,                             -- e.g. ACME-LAPTOP-04
  asset_tag TEXT,                            -- Byron-friendly tag
  assigned_user TEXT,                        -- who uses it day-to-day
  type TEXT NOT NULL,                        -- laptop | desktop | server | printer | network | other
  manufacturer TEXT,
  model TEXT,
  serial TEXT,
  os TEXT,
  cpu TEXT,
  ram_gb INTEGER,
  storage_gb INTEGER,
  warranty_until TEXT,                       -- ISO date
  last_serviced_at TEXT,                     -- ISO date
  status TEXT NOT NULL DEFAULT 'active',     -- active | retired | decommissioned
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_assets_location ON client_assets(location_id, status);
CREATE INDEX IF NOT EXISTS idx_client_assets_client ON client_assets(client_id);
CREATE INDEX IF NOT EXISTS idx_client_assets_hostname ON client_assets(hostname);

-- -- contract_requests ---------------------------------------------------
-- A request/task raised by a contract contact at a location, optionally
-- tied to a specific asset. Status enum: open -> in_progress -> resolved;
-- cancelled is a terminal state only achievable by the submitting contact
-- (or admin) while the request is still cancellable (see cancel rules in
-- lib/contract-clients.js).
--
-- Future edit seam: `editable_until` (NULL until feature ships) will let
-- office managers amend their own submitted request for a short window.
-- Schema reserves the column; route layer enforces it.
CREATE TABLE IF NOT EXISTS contract_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_uid TEXT NOT NULL,                 -- e.g. CR-000123; unique, admin-facing
  client_id INTEGER NOT NULL REFERENCES contract_clients(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES contract_locations(id) ON DELETE CASCADE,
  submitting_contact_id INTEGER NOT NULL REFERENCES client_contacts(id) ON DELETE RESTRICT,
  asset_id INTEGER REFERENCES client_assets(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,                             -- hardware | software | network | account | other
  priority TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  status TEXT NOT NULL DEFAULT 'open',       -- open | in_progress | resolved | cancelled
  assigned_to TEXT,                          -- admin / tech initials
  resolved_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,                         -- 'contact' | 'admin' | 'system'
  cancel_reason TEXT,
  editable_until TEXT,                       -- NULL = no further edits in v1
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_requests_uid ON contract_requests(request_uid);
CREATE INDEX IF NOT EXISTS idx_contract_requests_client_status ON contract_requests(client_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_requests_location_status ON contract_requests(location_id, status);
CREATE INDEX IF NOT EXISTS idx_contract_requests_asset ON contract_requests(asset_id);

-- -- contract_request_events --------------------------------------------
-- Append-only log per request (status transitions, cancellations, edits).
-- Cheap; admin UI can replay history.
CREATE TABLE IF NOT EXISTS contract_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES contract_requests(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,                       -- 'admin' | 'contact:<id>' | 'system'
  event_type TEXT NOT NULL,                  -- created | status_change | cancelled | edited | assigned
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contract_request_events_req ON contract_request_events(request_id, created_at);

-- -- portal audit log ----------------------------------------------------
-- Separate from `audit_log` because admin-only audit isn't visible to clients.
CREATE TABLE IF NOT EXISTS client_portal_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id INTEGER REFERENCES client_portal_credentials(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES contract_clients(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_portal_audit_client ON client_portal_audit(client_id, created_at DESC);
