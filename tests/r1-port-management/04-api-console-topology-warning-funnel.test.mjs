/**
 * R1-04 to R1-07: API 控制台, 架构拓扑图, 接口变更预警, Funnel Dashboard
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('API 控制台', () => {
  test('GET /api/services returns services list', async () => {
    const resp = await fetch(`${BASE}/api/services`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'services should be an array');
  });
});

describe('架构拓扑图', () => {
  test('GET /api/architecture returns nodes+edges', async () => {
    const resp = await fetch(`${BASE}/api/architecture`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.nodes), 'should have nodes array');
    assert.ok(Array.isArray(data.edges), 'should have edges array');
  });
});

describe('接口变更预警', () => {
  test('GET /api/interface-changes returns changes', async () => {
    const resp = await fetch(`${BASE}/api/interface-changes`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.changes), 'should have changes array');
    assert.ok(typeof data.total === 'number', 'should have total count');
  });

  test('GET /api/interface-changes/SOTAgent returns project-specific changes', async () => {
    const resp = await fetch(`${BASE}/api/interface-changes/SOTAgent`);
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(Array.isArray(data.changes));
  });

  test('POST /api/interface-snapshots/refresh works', async () => {
    const resp = await fetch(`${BASE}/api/interface-snapshots/refresh`, {
      method: 'POST',
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(data.ok === true, 'should return ok:true');
  });
});

describe('Funnel Dashboard', () => {
  test('GET /api/funnel/status returns funnel state', async () => {
    const resp = await fetch(`${BASE}/api/funnel/status`);
    assert.ok(resp.status >= 200 && resp.status < 500);
  });

  test('GET /api/costs returns cost breakdown', async () => {
    const resp = await fetch(`${BASE}/api/costs`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(data.total, 'should have total cost');
    assert.ok(Array.isArray(data.daily), 'should have daily array');
    assert.ok(Array.isArray(data.monthly), 'should have monthly array');
  });
});
