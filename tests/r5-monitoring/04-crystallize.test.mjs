/**
 * R5-04: Crystallize — data snapshots
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('Crystallize', () => {
  test('GET /api/crystals returns crystals list', async () => {
    const resp = await fetch(`${BASE}/api/crystals`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'crystals should be an array');
  });

  test('POST /api/crystals/match returns match results', async () => {
    const resp = await fetch(`${BASE}/api/crystals/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: ['test'], project_type: [], tags: [] }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'match results should be an array');
  });
});
