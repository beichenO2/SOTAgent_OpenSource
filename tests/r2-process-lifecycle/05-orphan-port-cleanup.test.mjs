/**
 * R2-05: 孤儿端口清理 — detect+cleanup orphan ports
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('孤儿端口清理', () => {
  test('GET /api/services/port-conflicts returns conflict scan', async () => {
    const resp = await fetch(`${BASE}/api/services/port-conflicts`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'port conflicts should be an array');
    for (const item of data) {
      assert.ok('serviceId' in item, 'should have serviceId');
      assert.ok('port' in item, 'should have port');
      assert.ok('conflict' in item, 'should have conflict status');
    }
  });

  test('GET /api/services/alerts returns service alerts', async () => {
    const resp = await fetch(`${BASE}/api/services/alerts`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'alerts should be an array');
  });
});
