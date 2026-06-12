/**
 * R2-06: 外部进程接管 — adopt external process
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('外部进程接管', () => {
  test('POST /api/processes/adopt returns valid response', async () => {
    const resp = await fetch(`${BASE}/api/processes/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pid: 1,
        name: 'test-adopt',
        port: 4997,
        work_dir: '/tmp',
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(typeof data === 'object');
  });

  test('GET /api/processes returns process list', async () => {
    const resp = await fetch(`${BASE}/api/processes`);
    assert.ok(resp.status >= 200 && resp.status < 500);
  });
});
