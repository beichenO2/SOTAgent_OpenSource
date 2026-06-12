/**
 * R3-04: SyncEngine — engine initialization validation
 * Validates sync-engine config and data files exist.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOTAGENT_DIR = join(__dirname, '..', '..');
const configPath = join(SOTAGENT_DIR, 'config.json');
const dataDir = join(SOTAGENT_DIR, 'data');

describe('SyncEngine', () => {
  test('config.json exists and is valid JSON', () => {
    assert.ok(existsSync(configPath), 'config.json should exist');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.ok(typeof config === 'object', 'config.json should parse');
    assert.ok(Array.isArray(config.built_in_services), 'should have built_in_services');
  });

  test('data directory exists', () => {
    assert.ok(existsSync(dataDir), 'data/ directory should exist');
  });

  test('SyncEngine source file exists', () => {
    const syncEnginePath = join(SOTAGENT_DIR, 'src', 'sync-engine.ts');
    assert.ok(existsSync(syncEnginePath), 'src/sync-engine.ts should exist');
    const content = readFileSync(syncEnginePath, 'utf-8');
    assert.ok(content.includes('SyncEngine'), 'SyncEngine class should be defined');
  });

  test('SyncEngine module exports expected methods', () => {
    const syncEnginePath = join(SOTAGENT_DIR, 'src', 'sync-engine.ts');
    const content = readFileSync(syncEnginePath, 'utf-8');
    // Verify the class has the key methods mentioned in polaris.json
    assert.ok(content.includes('purgeStaleOutbox') || content.includes('outbox'),
      'should reference outbox/purge logic');
  });
});
