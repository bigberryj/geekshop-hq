import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let app;
let baseURL;
let tmpDir;

// Tiny fetch wrapper — Node 26 has global fetch, no need for axios.
async function req(method, url, body, options = {}) {
  const r = await fetch(baseURL + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok && !options.expectError) {
    const err = new Error(`HTTP ${r.status} ${method} ${url}: ${data?.error || text}`);
    err.response = { status: r.status, data };
    throw err;
  }
  return data;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-customer-search-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('customer search benchmark', () => {
  it('implements improved search and filter functionality', async () => {
    // Insert test customers
    const customers = [
      { name: 'John Doe', email: 'john@example.com', company: 'Doe Inc', phone: '123-456-7890', notes: 'Regular customer' },
      { name: 'Jane Smith', email: 'jane@example.com', company: 'Smith LLC', phone: '098-765-4321', notes: 'VIP customer' },
      { name: 'Bob Johnson', email: 'bob@example.com', company: 'Johnson Corp', phone: '555-123-4567', notes: 'New customer' },
      { name: 'Alice Brown', email: 'alice@example.com', company: 'Brown Ltd', phone: '444-987-6543', notes: 'Tech enthusiast' },
      { name: 'Charlie Wilson', email: 'charlie@example.com', company: 'Wilson Industries', phone: '333-654-0987', notes: 'Frequent buyer' }
    ];

    for (const customer of customers) {
      await req('POST', '/api/customers', customer);
    }

    // Test search functionality
    const searchTests = [
      // Search by name - "John" should match both "John Doe" and "Bob Johnson" (contains "John")
      { search: 'John', expectedCount: 2 },
      { search: 'jane', expectedCount: 1 },
      { search: 'bob', expectedCount: 1 },

      // Search by email
      { search: 'example.com', expectedCount: 5 },
      { search: 'john@example', expectedCount: 1 },

      // Search by company
      { search: 'Doe Inc', expectedCount: 1 },
      { search: 'LLC', expectedCount: 1 },

      // Search by phone
      // Note: '123-456' matches BOTH '123-456-7890' (John) AND '555-123-4567' (Bob)
      // — substring search across all phone fields. expectedCount = 2.
      { search: '123-456', expectedCount: 2 },
      { search: '555', expectedCount: 1 },

      // Search by notes
      // 3 rows contain 'customer': 'Regular customer', 'VIP customer', 'New customer'.
      // 'Tech enthusiast' and 'Frequent buyer' do NOT.
      { search: 'customer', expectedCount: 3 },
      { search: 'VIP', expectedCount: 1 },

      // Search with empty string (should return all)
      { search: '', expectedCount: 5 },

      // Search with whitespace (should be trimmed)
      { search: '  John  ', expectedCount: 2 },

      // Search with no matches
      { search: 'nonexistent', expectedCount: 0 }
    ];

    for (const test of searchTests) {
      const result = await req('GET', `/api/customers?search=${encodeURIComponent(test.search)}`);
      // Debug: let's see what we're getting for failing tests
      if (result.length !== test.expectedCount) {
        console.log(`Search: "${test.search}" - Expected: ${test.expectedCount}, Got: ${result.length}`);
        console.log('Results:', result.map(c => ({ id: c.id, name: c.name })));
      }
      expect(result).toHaveLength(test.expectedCount);
    }

    // Test status filtering
    // Archive Bob Johnson explicitly so the combined search test is deterministic.
    const allCustomers = await req('GET', '/api/customers');
    const bob = allCustomers.find((c) => c.name === 'Bob Johnson');
    await req('PUT', `/api/customers/${bob.id}`, { status: 'archived' });

    // Test active status filter
    const activeCustomers = await req('GET', '/api/customers?status=active');
    expect(activeCustomers).toHaveLength(4); // 5 total - 1 archived

    // Test archived status filter
    const archivedCustomers = await req('GET', '/api/customers?status=archived');
    expect(archivedCustomers).toHaveLength(1);

    // Test combined search and status filter
    const activeJohn = await req('GET', `/api/customers?search=John&status=active`);
    expect(activeJohn).toHaveLength(1); // Only John Doe — Bob Johnson was archived

    // Test invalid status — the route validates and returns 400 for unknown statuses.
    // (We can't easily read the statusCode through this test's req helper, so
    // use raw fetch so we can assert on the actual HTTP status.)
    const invalidStatusResponse = await fetch(baseURL + '/api/customers?status=invalid');
    expect(invalidStatusResponse.status).toBe(400);
  });
});