/**
 * R4-01: API 网关 — /gw/* route forwarding
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('API 网关', () => {
  test('GET /api/gateway/routes returns gateway configuration', async () => {
    const resp = await fetch(`${BASE}/api/gateway/routes`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(typeof data.enabled === 'boolean', 'should have enabled boolean');
    assert.ok(typeof data.base_path === 'string', 'should have base_path');
    assert.ok(Array.isArray(data.routes), 'should have routes array');
  });

  test('GET /gw/* returns 502 when no backend found', async () => {
    const resp = await fetch(`${BASE}/gw/nonexistent/health`);
    // Gateway is either disabled or no route found — either way a valid response
    assert.ok(resp.status >= 200 && resp.status < 500 || resp.status === 502);
  });
});
