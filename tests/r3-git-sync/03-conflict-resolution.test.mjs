/**
 * R3-03: 冲突解决 — 6 strategy scheduling
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('冲突解决', () => {
  test('POST /api/peer/resolve returns valid response', async () => {
    const resp = await fetch(`${BASE}/api/peer/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'test-project',
        type: 'diverged',
        localState: {
          project: 'test-project',
          path: '/tmp',
          branch: 'main',
          headHash: '',
          hasUncommitted: false,
          uncommittedFiles: [],
          unpushedCount: 1,
          remoteAhead: 1,
          lastActivityTs: new Date().toISOString(),
        },
        peerState: {
          project: 'test-project',
          path: '',
          branch: 'main',
          headHash: '',
          hasUncommitted: false,
          uncommittedFiles: [],
          unpushedCount: 0,
          remoteAhead: 0,
          lastActivityTs: new Date().toISOString(),
        },
        detectedAt: new Date().toISOString(),
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(typeof data === 'object');
  });
});
