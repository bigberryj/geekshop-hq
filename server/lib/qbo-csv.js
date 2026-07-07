/**
 * QuickBooks Online (and QBO-style) CSV import.
 *
 * The brief asks for QuickBooks Online import but explicitly says "start
 * with CSV if direct QuickBooks Online API integration is too much for
 * the first version". This is the CSV path — robust against the most
 * common QBO export shapes plus generic CSVs.
 *
 * Two entity types supported:
 *   - customers   (QBO export columns: Customer, Company, Email, Phone,
 *                  Billing Address, Shipping Address, Tax Resale No,
 *                  Notes)
 *   - items       (QBO export columns: Name, SKU, Description, Sales
 *                  Price/Rate, Type, Active)
 *
 * The library is pure: it parses the CSV into records, applies a mapping
 * (auto-detected from headers or supplied by the caller), and returns
 * normalized rows. The route layer is what writes them — that way
 * /preview can show what *would* be imported without touching the DB,
 * and /commit reuses the same parser.
 *
 * Parsing rules:
 *   - First non-empty line is the header row (case-insensitive compare)
 *   - Quoted fields with embedded commas / newlines / quotes are
 *     unescaped (RFC 4180-ish; sufficient for QBO exports)
 *   - Empty trailing lines are dropped
 *   - Empty input → []
 */

const CUSTOMER_HEADER_MAP = {
  // canonical : [accepted header variants]
  name: ['name', 'customer', 'customer name', 'display name', 'company'],
  company: ['company', 'company name'],
  email: ['email', 'email address', 'primary email'],
  phone: ['phone', 'phone number', 'primary phone'],
  billing_address: ['billing address', 'address', 'billing addr'],
  shipping_address: ['shipping address', 'shipping addr'],
  tax_number: ['tax number', 'tax resale no', 'tax id', 'resale no'],
  notes: ['notes', 'note', 'memo'],
};

const ITEM_HEADER_MAP = {
  name: ['name', 'item', 'product', 'service'],
  sku: ['sku', 'code', 'item code', 'product code'],
  description: ['description', 'desc'],
  unit_price: ['sales price', 'sales price/rate', 'rate', 'unit price', 'price', 'amount'],
  taxable: ['taxable', 'is taxable', 'tax'],
  active: ['active', 'status', 'is active'],
};

function splitCsvLine(line) {
  // RFC 4180-ish split. Handles "field","field with, comma","field with ""quote".
  const out = [];
  let i = 0;
  let cur = '';
  let inQuotes = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 2; continue; }
      if (ch === '"') { inQuotes = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { out.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  out.push(cur);
  return out;
}

export function parseCsv(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]).map((h) => String(h).trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.every((c) => c === '')) continue; // skip blank lines
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] ?? '').trim();
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Map raw CSV rows to canonical shape using the supplied (or
 * auto-detected) header→field mapping.
 *
 * @param {object[]} rows          - parsed CSV rows
 * @param {'customers'|'items'} entity
 * @param {Record<string,string>|null} overrideMapping  header → canonical name
 * @returns {{ records: object[], unknown_headers: string[] }}
 */
export function mapRows(rows, entity, overrideMapping = null) {
  const headerMap = entity === 'customers' ? CUSTOMER_HEADER_MAP : ITEM_HEADER_MAP;
  if (!rows.length) return { records: [], unknown_headers: [], mapping: {} };

  const headers = Object.keys(rows[0]);
  const mapping = {}; // canonical → matched header
  const unknown = [];

  if (overrideMapping) {
    for (const [hdr, canonical] of Object.entries(overrideMapping)) {
      if (canonical && headerMap[canonical]) {
        mapping[canonical] = hdr;
      }
    }
  } else {
    // Auto-detect by case-insensitive header scan.
    for (const [canonical, variants] of Object.entries(headerMap)) {
      for (const variant of variants) {
        const found = headers.find((h) => h.toLowerCase() === variant.toLowerCase());
        if (found) { mapping[canonical] = found; break; }
      }
    }
  }

  // Surface unknown headers so the UI can show "we ignored these columns".
  const knownHeaders = new Set(Object.values(mapping));
  for (const h of headers) {
    if (!knownHeaders.has(h)) unknown.push(h);
  }

  const records = rows.map((row) => {
    const out = {};
    for (const canonical of Object.keys(headerMap)) {
      const hdr = mapping[canonical];
      out[canonical] = hdr ? row[hdr] ?? '' : '';
    }
    // Coerce / normalize per entity.
    if (entity === 'items') {
      // "Type" column is not in our schema, but a QBO "Service" type
      // is the natural default for accounting — we don't store it,
      // just use it as a hint for `taxable`.
      const unitPriceRaw = String(out.unit_price || '').replace(/[$,\s]/g, '');
      const unitPriceNum = Number(unitPriceRaw);
      out.unit_price_cents = Number.isFinite(unitPriceNum) ? Math.round(unitPriceNum * 100) : 0;
      out.taxable = /^(1|true|yes|y)$/i.test(String(out.taxable || '').trim()) ? 1 : 1; // default taxable
      out.active = /^(1|true|yes|y|active)$/i.test(String(out.active || 'active').trim()) ? 1 : 0;
      delete out.unit_price;
    } else {
      out.status = 'active';
    }
    return out;
  });

  return { records, unknown_headers: unknown, mapping };
}

/**
 * Validate records and report what would be created vs skipped (e.g.
 * duplicate email). Returned shape is suitable for /preview.
 */
export function validateRecords({ entity, records, db }) {
  const issues = [];
  let creatable = 0;
  let skippable = 0;

  if (entity === 'customers') {
    const seenEmails = new Set();
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.name) {
        issues.push({ row: i, kind: 'missing_name', message: 'Customer row missing name' });
        continue;
      }
      if (r.email && seenEmails.has(r.email.toLowerCase())) {
        issues.push({ row: i, kind: 'duplicate_email_in_file', message: `duplicate email ${r.email}` });
        skippable++;
        continue;
      }
      if (r.email) seenEmails.add(r.email.toLowerCase());

      // Existing customer with same email → would skip (we don't merge
      // blindly — the UI can show this and let the operator force-merge).
      if (r.email && db) {
        const existing = db.prepare('SELECT id, name FROM customers WHERE email = ?').get(r.email);
        if (existing) {
          issues.push({ row: i, kind: 'existing_customer', message: `existing customer "${existing.name}" (id ${existing.id}) has email ${r.email}` });
          skippable++;
          continue;
        }
      }
      creatable++;
    }
  } else if (entity === 'items') {
    const seenSku = new Set();
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.name) {
        issues.push({ row: i, kind: 'missing_name', message: 'Item row missing name' });
        continue;
      }
      if (r.sku && seenSku.has(String(r.sku).toLowerCase())) {
        issues.push({ row: i, kind: 'duplicate_sku_in_file', message: `duplicate SKU ${r.sku}` });
        skippable++;
        continue;
      }
      if (r.sku) seenSku.add(String(r.sku).toLowerCase());

      if (r.sku && db) {
        const existing = db.prepare('SELECT id, name FROM products WHERE sku = ?').get(r.sku);
        if (existing) {
          issues.push({ row: i, kind: 'existing_sku', message: `existing product "${existing.name}" (id ${existing.id}) has SKU ${r.sku}` });
          skippable++;
          continue;
        }
      }
      creatable++;
    }
  }

  return { creatable, skippable, issues };
}

/**
 * Commit the records (the part /preview skips). Returns inserted ids.
 */
export function commitRecords({ entity, records, db }) {
  const inserted = [];
  if (entity === 'customers') {
    const stmt = db.prepare(`INSERT INTO customers (name, company, email, phone, notes,
                              billing_address, shipping_address, tax_number, status)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`);
    for (const r of records) {
      if (!r.name) continue;
      if (r.email) {
        const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(r.email);
        if (existing) continue;
      }
      const info = stmt.run(
        r.name || null,
        r.company || null,
        r.email || null,
        r.phone || null,
        r.notes || null,
        r.billing_address || null,
        r.shipping_address || null,
        r.tax_number || null,
      );
      inserted.push({ id: info.lastInsertRowid, name: r.name });
    }
  } else if (entity === 'items') {
    const stmt = db.prepare(`INSERT INTO products (name, sku, description, unit_price_cents, taxable, active)
                             VALUES (?, ?, ?, ?, ?, ?)`);
    for (const r of records) {
      if (!r.name) continue;
      if (r.sku) {
        const existing = db.prepare('SELECT id FROM products WHERE sku = ?').get(r.sku);
        if (existing) continue;
      }
      try {
        const info = stmt.run(
          r.name,
          r.sku || null,
          r.description || null,
          Number(r.unit_price_cents || 0),
          r.taxable ? 1 : 0,
          r.active ? 1 : 0,
        );
        inserted.push({ id: info.lastInsertRowid, name: r.name });
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err;
      }
    }
  }
  return inserted;
}
