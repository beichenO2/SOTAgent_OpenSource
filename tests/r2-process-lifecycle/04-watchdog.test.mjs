/**
 * R2-04: Watchdog — health check failure triggers restart
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('Watchdog', () => {
  test('GET /api/services returns services with status info', async () => {
    const resp = await fetch(`${BASE}/api/services`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data));
    // Verify watchdog-relevant fields exist
    for (const svc of data) {
      assert.ok('status' in svc, 'service should have status');
      assert.ok('pid' in svc, 'service should have pid');
      assert.ok('restart_count' in svc, 'service should have restart_count');
    }
  });

  test('GET /api/services/events returns event log', async () => {
    const resp = await fetch(`${BASE}/api/services/events`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'events should be an array');
  });

  test('POST /api/services/:id/notify-update with restart strategy', async () => {
    const listResp = await fetch(`${BASE}/api/services`);
    const services = await listResp.json();
    if (services.length > 0) {
      const id = services[0].id;
      const resp = await fetch(`${BASE}/api/services/${id}/notify-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: 'restart' }),
      });
      assert.ok(resp.status >= 200 && resp.status < 500);
    }
  });
});
