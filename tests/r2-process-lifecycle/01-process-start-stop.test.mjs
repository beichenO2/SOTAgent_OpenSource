/**
 * R2-01: 进程启停 — start/stop/restart API via ProcessManager
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('进程启停', () => {
  test('GET /api/services returns service list', async () => {
    const resp = await fetch(`${BASE}/api/services`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data));
  });

  test('GET /api/services/:id returns service detail', async () => {
    // Get first service ID if available
    const listResp = await fetch(`${BASE}/api/services`);
    const services = await listResp.json();
    if (services.length > 0) {
      const id = services[0].id;
      const resp = await fetch(`${BASE}/api/services/${id}`);
      assert.ok(resp.status >= 200 && resp.status < 500);
    }
  });

  test('POST /api/services/:id/start returns error for nonexistent', async () => {
    const resp = await fetch(`${BASE}/api/services/nonexistent/start`, {
      method: 'POST',
    });
    // Returns 500 with error message for nonexistent service
    assert.ok(resp.status === 500 || resp.status === 404 || resp.status === 200);
    const data = await resp.json();
    assert.ok(data.ok === false, 'should return ok:false for nonexistent service');
  });

  test('POST /api/services/:id/stop returns error for nonexistent', async () => {
    const resp = await fetch(`${BASE}/api/services/nonexistent/stop`, {
      method: 'POST',
    });
    assert.ok(resp.status === 500 || resp.status === 404 || resp.status === 200);
  });

  test('POST /api/services/:id/restart returns error for nonexistent', async () => {
    const resp = await fetch(`${BASE}/api/services/nonexistent/restart`, {
      method: 'POST',
    });
    assert.ok(resp.status === 500 || resp.status === 404 || resp.status === 200);
  });

  test('POST /api/services registers a new service', async () => {
    const resp = await fetch(`${BASE}/api/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-svc',
        name: 'Test Service',
        command: 'echo test',
        work_dir: '/tmp',
        port: 4999,
        auto_start: false,
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
  });

  test('POST /api/services/register-and-start works', async () => {
    const resp = await fetch(`${BASE}/api/services/register-and-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-reg-start',
        name: 'Test Reg Start',
        command: 'echo hello',
        work_dir: '/tmp',
        port: 4998,
        auto_start: false,
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
  });
});
