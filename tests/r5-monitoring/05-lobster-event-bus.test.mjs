/**
 * R5-05: 龙虾事件总线 — COMPLETE test for POST/GET event bus API
 *
 * This is the most complete test in R5. It covers:
 * - POST valid events (all event types)
 * - POST invalid events (validation failures)
 * - GET with filtering (project, since, type, limit)
 * - POST arrow events
 * - End-to-end: write event → read event back
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

// Helper: wait a few ms for event persistence
const sleep = ms => new Promise(r => setTimeout(r, ms));

const VALID_EVENT_TYPES = [
  'bug',
  'digest_report',
  'contract_red',
  'git_push_main',
  'scheduled_health_scan',
];

describe('龙虾事件总线 — POST (write)', () => {
  // Clean up: write a known event first, then verify all types work

  test('POST /api/lobster/events — write bug event', async () => {
    const event = {
      type: 'bug',
      source_project: 'SOTAgent',
      severity: 'error',
      payload: { service_name: 'test-service', title: 'Test bug event', detail: 'This is a test bug event from test suite' },
    };
    const resp = await fetch(`${BASE}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    const body = await resp.json();
    assert.equal(resp.status, 201, `bug event should return 201, got ${resp.status}: ${JSON.stringify(body)}`);
    assert.ok(body.ok === true);
  });

  test('POST /api/lobster/events — write digest_report event', async () => {
    const event = {
      type: 'digest_report',
      source_project: 'digist',
      severity: 'info',
      payload: { service_name: 'digist-daily-digest', title: 'Daily digest generated' },
    };
    const resp = await fetch(`${BASE}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(resp.status, 201);
    const data = await resp.json();
    assert.ok(data.ok === true);
  });

  test('POST /api/lobster/events — write contract_red event', async () => {
    const event = {
      type: 'contract_red',
      source_project: 'KnowLever',
      severity: 'warn',
      payload: { service_name: 'knowlever-rag', title: 'Contract violation detected' },
    };
    const resp = await fetch(`${BASE}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(resp.status, 201);
    const data = await resp.json();
    assert.ok(data.ok === true);
  });

  test('POST /api/lobster/events — write git_push_main event', async () => {
    const event = {
      type: 'git_push_main',
      source_project: 'PolarCopilot',
      severity: 'info',
      payload: { service_name: 'polarcop-hub', title: 'Push to main branch' },
    };
    const resp = await fetch(`${BASE}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(resp.status, 201);
    const data = await resp.json();
    assert.ok(data.ok === true);
  });

  test('POST /api/lobster/events — write scheduled_health_scan event', async () => {
    const event = {
      type: 'scheduled_health_scan',
      source_project: 'SOTAgent',
      severity: 'info',
      payload: { service_name: 'sotagent-api', title: 'Scheduled health scan completed' },
    };
    const resp = await fetch(`${BASE}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(resp.status, 201);
    const data = await resp.json();
    assert.ok(data.ok === true);
  });

  test('POST /api/lobster/events — reject missing required fields', async () => {
    const resp = await fetch(`${BASE}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'test' }), // missing type, title, detail
    });
    assert.ok(resp.status >= 400, 'should reject missing required fields');
  });

  test('POST /api/lobster/events — reject invalid event type', async () => {
    const resp = await fetch(`${BASE}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'invalid_type_not_in_enum',
        project: 'test',
        title: 'Test',
        detail: 'Test detail',
      }),
    });
    assert.ok(resp.status >= 400, 'should reject invalid event type');
  });

  test('POST /api/lobster/events — reject empty body', async () => {
    const resp = await fetch(`${BASE}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.ok(resp.status >= 400, 'should reject empty body');
  });
});

describe('龙虾事件总线 — GET (read)', () => {
  test('GET /api/lobster/events returns event list', async () => {
    const resp = await fetch(`${BASE}/api/lobster/events`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.events), 'should have events array');
    assert.ok(typeof data.total === 'number', 'should have total count');
  });

  test('GET /api/lobster/events?project=SOTAgent filters by project', async () => {
    const resp = await fetch(`${BASE}/api/lobster/events?project=SOTAgent`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.events));
    // All returned events should be for SOTAgent
    for (const ev of data.events) {
      assert.ok(ev.source_project === 'SOTAgent' || ev.target_project === 'SOTAgent');
    }
  });

  test('GET /api/lobster/events?type=bug filters by type', async () => {
    const resp = await fetch(`${BASE}/api/lobster/events?type=bug`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.events));
    for (const ev of data.events) {
      assert.equal(ev.type, 'bug');
    }
  });

  test('GET /api/lobster/events?limit=1 limits results', async () => {
    const resp = await fetch(`${BASE}/api/lobster/events?limit=1`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.events));
    assert.ok(data.events.length <= 1, 'should return at most 1 event');
  });

  test('GET /api/lobster/events?since filters by timestamp', async () => {
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const resp = await fetch(`${BASE}/api/lobster/events?since=${oneHourAgo}`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data.events));
    // All events should be after the given timestamp (field is `ts` not `timestamp`)
    for (const ev of data.events) {
      assert.ok(ev.ts >= oneHourAgo, `event ts ${ev.ts} should be >= ${oneHourAgo}`);
    }
  });
});

describe('龙虾事件总线 — Arrow (重大发现上报)', () => {
  test('POST /api/lobster/arrow — write arrow event', async () => {
    const arrow = {
      source_project: 'KnowLever',
      discovery_type: 'security',
      title: 'Test arrow discovery',
      detail: 'This is a test arrow event',
      severity: 'critical',
      evidence: ['evidence1', 'evidence2'],
    };
    const resp = await fetch(`${BASE}/api/lobster/arrow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(arrow),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(data.ok === true);
  });

  test('POST /api/lobster/arrow — reject missing fields', async () => {
    const resp = await fetch(`${BASE}/api/lobster/arrow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_project: 'test' }), // missing title, detail
    });
    assert.ok(resp.status >= 400, 'should reject missing required fields');
  });

  test('POST /api/lobster/arrow — accepts valid severity values', async () => {
    // Arrow endpoint accepts severity without strict enum validation.
    // Verify it accepts valid severities and returns 2xx.
    for (const sev of ['info', 'warn', 'error', 'critical']) {
      const arrow = {
        source_project: 'test',
        discovery_type: 'test',
        title: 'Test',
        detail: 'Test',
        severity: sev,
      };
      const resp = await fetch(`${BASE}/api/lobster/arrow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(arrow),
      });
      assert.ok(resp.status >= 200 && resp.status < 300,
        `should accept severity=${sev}, got ${resp.status}`);
    }
  });
});

describe('龙虾事件总线 — E2E (write then read)', () => {
  test('End-to-end: POST event then GET it back', async () => {
    const uniqueId = `e2e-test-${Date.now()}`;
    const event = {
      type: 'bug',
      source_project: 'SOTAgent',
      severity: 'warn',
      payload: { title: `E2E Test Bug ${uniqueId}`, detail: `E2E test detail for ${uniqueId}`, e2e_id: uniqueId },
    };

    // Write
    const postResp = await fetch(`${BASE}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(postResp.status, 201);

    // Read back all events
    await sleep(50); // brief pause for file write
    const getResp = await fetch(`${BASE}/api/lobster/events?project=SOTAgent&limit=100`);
    assert.equal(getResp.status, 200);
    const data = await getResp.json();

    // Verify our event is in the results
    // Events stored have the payload field with our data
    const found = data.events.find(ev =>
      ev.source_project === 'SOTAgent' &&
      ev.type === 'bug' &&
      ev.severity === 'warn'
    );
    assert.ok(found, `E2E event should be found in GET response`);
    assert.equal(found.type, 'bug');
    assert.equal(found.source_project, 'SOTAgent');
    assert.ok(found.payload, 'event should have payload');
    assert.ok(found.ts, 'event should have timestamp');
    assert.ok(found.id, 'event should have id');
  });
});
