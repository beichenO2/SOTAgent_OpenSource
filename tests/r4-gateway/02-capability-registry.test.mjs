/**
 * R4-02: 能力注册表 — capabilities.json loading
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('能力注册表', () => {
  test('GET /api/capabilities returns capabilities list', async () => {
    const resp = await fetch(`${BASE}/api/capabilities`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'capabilities should be an array');
  });

  test('POST /api/capabilities/register registers a capability', async () => {
    const resp = await fetch(`${BASE}/api/capabilities/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test.cap.test',
        project: 'test-project',
        service_name: 'test-svc',
        description: 'Test capability',
        transport: 'http',
        endpoint: '/api/test',
        method: 'GET',
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(data.ok === true, 'should return ok:true');
  });

  test('GET /api/capabilities/search searches capabilities', async () => {
    const resp = await fetch(`${BASE}/api/capabilities/search?q=test`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'search results should be an array');
  });

  test('GET /api/capabilities/stats/summary returns summary', async () => {
    const resp = await fetch(`${BASE}/api/capabilities/stats/summary`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(typeof data.total === 'number');
    assert.ok(data.by_project, 'should have by_project');
    assert.ok(data.by_transport, 'should have by_transport');
  });

  test('POST /api/capabilities/resync triggers resync', async () => {
    const resp = await fetch(`${BASE}/api/capabilities/resync`, { method: 'POST' });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(data.ok === true);
  });

  test('GET /api/capabilities/:id returns single capability', async () => {
    // Register one first
    await fetch(`${BASE}/api/capabilities/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test.cap.single',
        project: 'test',
        service_name: 'test',
        description: 'Test',
        transport: 'http',
      }),
    });
    const resp = await fetch(`${BASE}/api/capabilities/test.cap.single`);
    assert.ok(resp.status >= 200 && resp.status < 500);
  });

  test('DELETE /api/capabilities/:id deletes a capability', async () => {
    // Register one first
    await fetch(`${BASE}/api/capabilities/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test.cap.delete',
        project: 'test',
        service_name: 'test',
        transport: 'http',
      }),
    });
    const resp = await fetch(`${BASE}/api/capabilities/test.cap.delete`, {
      method: 'DELETE',
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(data.ok === true);
  });
});
