/**
 * R2-02: 静默重启窗口 — silent restart window after code changes
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('静默重启窗口', () => {
  test('GET /api/services/pending-restarts returns list', async () => {
    const resp = await fetch(`${BASE}/api/services/pending-restarts`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data));
  });

  test('POST /api/services/:id/notify-update marks pending restart', async () => {
    const listResp = await fetch(`${BASE}/api/services`);
    const services = await listResp.json();
    if (services.length > 0) {
      const id = services[0].id;
      const resp = await fetch(`${BASE}/api/services/${id}/notify-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: 'pending' }),
      });
      assert.ok(resp.status >= 200 && resp.status < 500);
      const data = await resp.json();
      assert.ok(data.pending_restart === true || data.ok === true);
    }
  });

  test('GET /api/services/:id/restart-window returns window state', async () => {
    const listResp = await fetch(`${BASE}/api/services`);
    const services = await listResp.json();
    if (services.length > 0) {
      const id = services[0].id;
      const resp = await fetch(`${BASE}/api/services/${id}/restart-window`);
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.ok(typeof data.pending_restart === 'boolean');
      assert.ok(typeof data.window_sec === 'number');
    }
  });
});
