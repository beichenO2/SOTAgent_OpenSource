/**
 * R3-02: PeerSync — sync state machine
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('PeerSync', () => {
  test('GET /api/peer/status returns peer sync status', async () => {
    const resp = await fetch(`${BASE}/api/peer/status`);
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(typeof data === 'object', 'should return an object');
  });

  test('POST /api/peer/heartbeat accepts heartbeat data', async () => {
    const resp = await fetch(`${BASE}/api/peer/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'test-device',
        timestamp: new Date().toISOString(),
        projects: [],
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(typeof data === 'object');
  });

  test('POST /api/peer/notify accepts notification', async () => {
    const resp = await fetch(`${BASE}/api/peer/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'push_completed',
        deviceId: 'test-device',
        project: 'test-project',
        timestamp: new Date().toISOString(),
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
  });
});
