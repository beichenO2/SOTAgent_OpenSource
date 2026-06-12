/**
 * R3-01: 仓库扫描 — scan API returns structure
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('仓库扫描', () => {
  test('GET /api/scan returns scan result structure', async () => {
    const resp = await fetch(`${BASE}/api/scan`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.repos), 'should have repos array');
    assert.ok(Array.isArray(data.ports), 'should have ports array');
    assert.ok(typeof data.scannedAt === 'string', 'should have scannedAt timestamp');
  });

  test('POST /api/scan/refresh triggers rescan', async () => {
    const resp = await fetch(`${BASE}/api/scan/refresh`, { method: 'POST' });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.repos), 'refresh should return repos');
  });

  test('GET /api/projects returns project list', async () => {
    const resp = await fetch(`${BASE}/api/projects`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'projects should be an array');
  });

  test('GET /api/assets returns asset list', async () => {
    const resp = await fetch(`${BASE}/api/assets`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'assets should be an array');
  });
});
