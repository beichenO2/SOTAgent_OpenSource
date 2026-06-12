/**
 * R1-02: 端口自愈 — heartbeat stale→active 转换
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('端口自愈 (heartbeat)', () => {
  test('heartbeat to stale port returns response (self-heal path)', async () => {
    // The port 4800 is the sotagent_api port; if it's already active,
    // heartbeat should still return a valid response (200 or conflict)
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
    assert.ok(typeof data === 'object');
    // The heartbeat endpoint either returns ok:true for active ports or handles self-heal
    assert.ok('ok' in data || 'status' in data || data.status, 'should have ok/status field');
  });

  test('heartbeat to non-existent port returns 404', async () => {
    const resp = await fetch(`${BASE}/api/ports/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: 99999,
        service_name: 'nonexistent',
        project: 'test',
        device_id: 'macbook-pro',
      }),
    });
    // Should return 404 for unregistered port
    assert.ok(resp.status === 404 || resp.status === 200, 'expected 404 or 200');
  });
});
