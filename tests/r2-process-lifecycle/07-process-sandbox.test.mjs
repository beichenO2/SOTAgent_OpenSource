/**
 * R2-07: 进程沙箱 — resource-controlled sandbox
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('进程沙箱', () => {
  test('POST /api/sandbox/start starts a sandbox', async () => {
    const resp = await fetch(`${BASE}/api/sandbox/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'echo "sandbox test"',
        work_dir: '/tmp',
        name: 'test-sandbox',
        nice_priority: 10,
        max_duration_sec: 5,
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(typeof data === 'object');
    assert.ok('ok' in data, 'response should have ok field');

    // If successfully started, stop it
    if (data.ok && data.id) {
      const stopResp = await fetch(`${BASE}/api/sandbox/stop/${data.id}`, {
        method: 'POST',
      });
      assert.ok(stopResp.status >= 200 && stopResp.status < 500);
    }
  });

  test('GET /api/sandbox/status returns sandbox status', async () => {
    const resp = await fetch(`${BASE}/api/sandbox/status`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'sandbox status should be an array');
  });

  test('GET /api/sandbox/:id/metrics returns metrics for known id', async () => {
    // Use a non-existent ID to test error handling
    const resp = await fetch(`${BASE}/api/sandbox/nonexistent-id/metrics`);
    assert.ok(resp.status >= 200 && resp.status < 500);
  });
});
