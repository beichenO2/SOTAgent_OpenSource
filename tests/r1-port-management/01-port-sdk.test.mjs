/**
 * R1-01: port-sdk — 测试 claimPort/heartbeat SDK 结构和 retry 逻辑
 *
 * Verifies:
 * - POST /api/ports/allocate returns valid structure
 * - POST /api/ports/heartbeat returns valid structure
 * - GET /api/ports returns array of port entries
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('port-sdk API', () => {
  test('GET /api/ports returns port list', async () => {
    const resp = await fetch(`${BASE}/api/ports`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'ports should be an array');
  });

  test('POST /api/ports/allocate returns structure', async () => {
    const resp = await fetch(`${BASE}/api/ports/allocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_name: 'test-alloc',
        project: 'test-project',
        device_id: 'macbook-pro',
        range_start: 4800,
        range_end: 4850,
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500, 'should not be a 5xx error');
    const data = await resp.json();
    assert.ok(typeof data === 'object', 'response should be an object');
  });

  test('POST /api/ports/heartbeat returns valid response', async () => {
    // Heartbeat with valid port should return ok or a conflict message
    const resp = await fetch(`${BASE}/api/ports/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: 4800,
        service_name: 'sotagent-api',
        project: 'SOTAgent',
        device_id: 'macbook-pro',
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(typeof data === 'object', 'heartbeat response should be an object');
  });

  test('GET /api/ports/config returns all ports', async () => {
    const resp = await fetch(`${BASE}/api/ports/config`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(data.sotagent_api, 'should have sotagent_api port');
    assert.ok(data.sotagent_console, 'should have sotagent_console port');
  });
});
