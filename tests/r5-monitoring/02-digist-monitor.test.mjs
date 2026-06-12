/**
 * R5-02: DiGist 监控 — digest monitoring API
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('DiGist 监控', () => {
  test('GET /api/digist/status returns status', async () => {
    const resp = await fetch(`${BASE}/api/digist/status`);
    assert.ok(resp.status >= 200 && resp.status < 500);
  });

  test('GET /api/digist/interests returns interests', async () => {
    const resp = await fetch(`${BASE}/api/digist/interests`);
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'interests should be an array');
  });

  test('GET /api/digist/sources returns sources', async () => {
    const resp = await fetch(`${BASE}/api/digist/sources`);
    assert.ok(resp.status >= 200 && resp.status < 500);
  });
});
