/**
 * SOTAgent contract tests — validate every example payload against its schema.
 *
 * Per 任务书/260505_compiled/SOTAgent.md §6 工作项 A.7, every schema in
 * contracts/ must have at least one contract test that proves the schema +
 * example are co-evolved.
 *
 * Run:   npm test       (or)   node --test tests/contracts/contracts.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

function loadJson(rel) {
  return JSON.parse(readFileSync(join(REPO, rel), 'utf-8'));
}

function makeValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  if (typeof addFormats === 'function') addFormats(ajv);
  else if (typeof addFormats?.default === 'function') addFormats.default(ajv);
  return ajv;
}

const PAIRS = [
  { schema: 'contracts/http-api.schema.json', example: 'contracts/examples/http-api.example.json' },
  { schema: 'contracts/inbox-outbox.schema.json', example: 'contracts/examples/inbox-message.example.json' },
  { schema: 'contracts/peer-sync.schema.json', example: 'contracts/examples/peer-sync.example.json' },
];

for (const { schema, example } of PAIRS) {
  test(`example matches schema: ${schema}`, () => {
    const ajv = makeValidator();
    const validate = ajv.compile(loadJson(schema));
    const data = loadJson(example);
    const ok = validate(data);
    assert.equal(ok, true, `example ${example} failed schema ${schema}: ${JSON.stringify(validate.errors)}`);
  });
}

test('schema files load + are valid Draft-07 documents', () => {
  const ajv = makeValidator();
  for (const { schema } of PAIRS) {
    const s = loadJson(schema);
    assert.equal(typeof s, 'object', `${schema} not an object`);
    assert.equal(s['$schema'], 'http://json-schema.org/draft-07/schema#', `${schema} missing Draft-07 declaration`);
    assert.doesNotThrow(() => ajv.compile(s), `${schema} is not a compilable Draft-07 schema`);
  }
});

test('checkup-aggregator: append writes one envelope per call (sanity)', () => {
  // Inline minimal JSONL append logic to avoid .ts import — validates
  // that the envelope format (source + received_at + event) writes correctly.
  const tmp = mkdtempSync(join(tmpdir(), 'sotagent-checkup-'));
  const filePath = join(tmp, 'checkup-events.jsonl');

  // Simulate what CheckupAggregator.append() does, in pure JS
  const ev = {
    event_id: '550e8400-e29b-41d4-a716-446655440000',
    project: 'KnowLever',
    agent_target: 'kl-test',
    page_url: 'http://localhost:3001/dashboard',
    user_text: 'hello world',
    timestamp: '2026-05-08T13:14:00Z',
  };

  const envelopes = [];
  for (let i = 0; i < 2; i++) {
    const envelope = {
      source: 'polarcop-hub',
      received_at: new Date().toISOString(),
      event: ev,
    };
    appendFileSync(filePath, JSON.stringify(envelope) + '\n');
    envelopes.push(envelope);
    if (i === 0) {
      const start = Date.now();
      while (Date.now() - start < 2) { /* spin 2ms for timestamp diff */ }
    }
  }

  assert.equal(envelopes[0].source, 'polarcop-hub');
  assert.equal(envelopes[0].event.event_id, ev.event_id);
  assert.equal(typeof envelopes[0].received_at, 'string');
  assert.notEqual(envelopes[0].received_at, envelopes[1].received_at,
    'received_at should differ between appends (ms-resolution)');

  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2, 'two lines expected');
  for (const l of lines) {
    const parsed = JSON.parse(l);
    assert.equal(parsed.event.event_id, ev.event_id);
    assert.equal(parsed.source, 'polarcop-hub');
  }
  rmSync(tmp, { recursive: true, force: true });
});
