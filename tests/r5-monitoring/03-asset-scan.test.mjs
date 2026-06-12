/**
 * R5-03: 资产扫描 — asset scanning API
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('资产扫描', () => {
  test('GET /api/assets returns asset list', async () => {
    const resp = await fetch(`${BASE}/api/assets`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'assets should be an array');
  });

  test('GET /api/assets/:type returns typed assets', async () => {
    const resp = await fetch(`${BASE}/api/assets/repo`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'typed assets should be an array');
  });
});
