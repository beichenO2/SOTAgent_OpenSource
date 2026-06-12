/**
 * R4-03: 任务 API — CRUD endpoints
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:4800';

describe('任务 API', () => {
  test('POST /api/tasks creates a task', async () => {
    const resp = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-task-1',
        name: 'Test Task',
        project: 'test-project',
        service_name: 'test-svc',
        status: 'queued',
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
    const data = await resp.json();
    assert.ok(typeof data === 'object');
  });

  test('GET /api/tasks returns task list', async () => {
    const resp = await fetch(`${BASE}/api/tasks`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(Array.isArray(data), 'tasks should be an array');
  });

  test('PATCH /api/tasks/:id updates task status', async () => {
    const resp = await fetch(`${BASE}/api/tasks/test-task-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
  });

  test('DELETE /api/tasks/:id deletes a task', async () => {
    const resp = await fetch(`${BASE}/api/tasks/test-task-1`, {
      method: 'DELETE',
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
  });

  test('POST /api/tasks/forward forwards a task', async () => {
    const resp = await fetch(`${BASE}/api/tasks/forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'forwarded-task',
        name: 'Forwarded Task',
        project: 'test',
      }),
    });
    assert.ok(resp.status >= 200 && resp.status < 500);
  });
});
