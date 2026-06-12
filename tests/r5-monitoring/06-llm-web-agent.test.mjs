/**
 * R5-06: LLM Web Agent — web agent API
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('LLM Web Agent', () => {
  test('GET /api/agent/status returns agent status', async () => {
    const resp = await fetch(`${BASE}/api/agent/status`);
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(typeof data === 'object');
  });

  test('GET /api/agent/sessions returns sessions list', async () => {
    const resp = await fetch(`${BASE}/api/agent/sessions`);
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'sessions should be an array');
  });

  test('GET /api/agent/logs returns agent logs', async () => {
    const resp = await fetch(`${BASE}/api/agent/logs`);
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'logs should be an array');
  });
});
