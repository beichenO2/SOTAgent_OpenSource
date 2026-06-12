/**
 * R5-01: KnowLever 监控 — monitoring bridge API
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('KnowLever 监控', () => {
  test('GET /api/knowlever/status returns status', async () => {
    const resp = await fetch(`${BASE}/api/knowlever/status`);
    assert.ok(resp.status >= 200 && resp.status < 500);
  });

  test('GET /api/knowlever/topics returns topics', async () => {
    const resp = await fetch(`${BASE}/api/knowlever/topics`);
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'topics should be an array');
  });

  test('GET /api/knowlever/users returns users', async () => {
    const resp = await fetch(`${BASE}/api/knowlever/users`);
    assert.ok(resp.status >= 200 && resp.status < 500);
  });
});
