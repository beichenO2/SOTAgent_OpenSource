/**
 * R2-03: Start 脚本自托管 — SOTAgent's own start scripts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SOTAGENT_DIR = join(import.meta.dirname, '..', '..');
const START_DIR = join(SOTAGENT_DIR, 'Start');

describe('Start 脚本自托管', () => {
  test('Start/start.sh exists', () => {
    assert.ok(existsSync(join(START_DIR, 'start.sh')), 'start.sh should exist');
  });

  test('Start/stop.sh exists', () => {
    assert.ok(existsSync(join(START_DIR, 'stop.sh')), 'stop.sh should exist');
  });

  test('Start/restart.sh exists', () => {
    assert.ok(existsSync(join(START_DIR, 'restart.sh')), 'restart.sh should exist');
  });

  test('Start/status.sh exists', () => {
    assert.ok(existsSync(join(START_DIR, 'status.sh')), 'status.sh should exist');
  });

  test('Start/version.sh exists', () => {
    assert.ok(existsSync(join(START_DIR, 'version.sh')), 'version.sh should exist');
  });

  test('Start/version.sh runs successfully', () => {
    const output = execSync('bash Start/version.sh', {
      cwd: SOTAGENT_DIR,
      encoding: 'utf-8',
    });
    assert.ok(output.trim().length > 0, 'version.sh should output a git hash');
  });
});
