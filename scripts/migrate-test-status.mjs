#!/usr/bin/env node
/**
 * One-time migration: add test_status="not_tested" to all features
 * in all project polaris.json files that lack the field.
 *
 * Usage: node scripts/migrate-test-status.mjs [--dry-run]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const POLARISOR_ROOT = join(process.env.HOME ?? '', 'Polarisor');
const dryRun = process.argv.includes('--dry-run');

console.log(`[migrate-test-status] Scanning ${POLARISOR_ROOT} (dry-run: ${dryRun})`);

let totalProjects = 0;
let totalFeatures = 0;
let totalMigrated = 0;

const entries = readdirSync(POLARISOR_ROOT, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'ClawBin' || entry.name === '_Polarisor') continue;

  const pjPath = join(POLARISOR_ROOT, entry.name, 'polaris.json');
  if (!existsSync(pjPath)) continue;

  try {
    const raw = readFileSync(pjPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.requirements)) continue;

    totalProjects++;
    let projectMigrated = 0;

    for (const req of data.requirements) {
      if (!Array.isArray(req.features)) continue;
      for (const feat of req.features) {
        totalFeatures++;
        if (feat.test_status === undefined) {
          feat.test_status = 'not_tested';
          projectMigrated++;
          totalMigrated++;
        }
      }
    }

    if (projectMigrated > 0) {
      if (!dryRun) {
        writeFileSync(pjPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      }
      console.log(`  ${entry.name}: ${projectMigrated} features migrated`);
    } else {
      console.log(`  ${entry.name}: already up-to-date`);
    }
  } catch (err) {
    console.error(`  ${entry.name}: ERROR — ${err.message}`);
  }
}

console.log(`\n[migrate-test-status] Done.`);
console.log(`  Projects scanned: ${totalProjects}`);
console.log(`  Features total: ${totalFeatures}`);
console.log(`  Features migrated: ${totalMigrated}`);
if (dryRun) console.log(`  (dry-run — no files modified)`);
