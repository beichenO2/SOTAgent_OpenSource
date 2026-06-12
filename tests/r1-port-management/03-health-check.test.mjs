/**
 * R1-03: 健康检查 — HTTP probe 逻辑
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('健康检查 (health probe)', () => {
  test('GET /api/health returns 200 with status ok', async () => {
    const resp = await fetch(`${BASE}/api/health`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.service, 'sotagent');
    assert.ok(typeof data.uptime === 'number');
  });

  test('GET /api/status returns 200 with device/resource/task state', async () => {
    const resp = await fetch(`${BASE}/api/status`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(data.device, 'should have device info');
    assert.ok(data.device.id, 'device should have id');
    assert.ok(data.tasks, 'should have tasks summary');
    assert.ok(typeof data.tasks.queued === 'number');
    assert.ok(typeof data.tasks.running === 'number');
    assert.ok(typeof data.tasks.done === 'number');
    assert.ok(typeof data.tasks.failed === 'number');
  });
});
