/**
 * ssot-watcher.ts — Layer 1 SSoT real-time change detection.
 *
 * Watches all project polaris.json files under ~/Polarisor via fs.watch with a
 * 500 ms debounce, validates JSON + SSoT format + interface snapshots,
 * and distributes results to a jsonl event log and/or inbox flags.
 *
 * Pattern reference: knowlever-monitor.ts (fs.watch + fingerprint + debounce).
 * Audit logic reference: Agent_core/scripts/ssot-audit.mjs (hasWeakBehavior, hasEvidence).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeInboxFlag } from './inbox-flag.js';

// ─── Internal types ──────────────────────────────────────────────

interface IWatchEntry {
  projectDir: string;        // project directory path
  polarisPath: string;       // polaris.json full path
  polarSoulPath: string;     // PolarSoul.md path (optional)
  capabilitiesPath: string;  // capabilities.json path (optional)
  ssotWatchEnabled: boolean; // whether to watch (default true)
}

interface IDebounceState {
  timer: ReturnType<typeof setTimeout> | null;
  lastEventTs: number;
  lastFingerprint: string;   // size + mtime hash
}

interface IValidationResult {
  passed: boolean;
  project: string;
  file: string;
  eventType: 'created' | 'modified' | 'deleted';
  errors: string[];
  warnings: string[];
  timestamp: string;
}

interface ISoTWatcherConfig {
  enabled: boolean;
  debounce_ms: number;
  watch_patterns: string[];
  log_file: string;
  polling_interval_sec: number;
}

// ─── Constants ───────────────────────────────────────────────────

const POLARISOR_ROOT = path.join(process.env.HOME || os.homedir(), 'Polarisor');

const DEFAULT_CONFIG: ISoTWatcherConfig = {
  enabled: true,
  debounce_ms: 500,
  watch_patterns: ['polaris.json', 'PolarSoul.md', 'capabilities.json'],
  log_file: '~/.sotagent/logs/ssot-events.jsonl',
  polling_interval_sec: 60,
};

// ─── State ───────────────────────────────────────────────────────

let _config: ISoTWatcherConfig = { ...DEFAULT_CONFIG };
let _watchEntries: IWatchEntry[] = [];
const _fsWatchers: fs.FSWatcher[] = [];
const _debounceStates = new Map<string, IDebounceState>();
const _interfaceSnapshots = new Map<string, string>(); // key: project::feature → interfaces JSON
let _pollingTimer: ReturnType<typeof setInterval> | null = null;
let _running = false;

// ─── Config ──────────────────────────────────────────────────────

function loadConfig(override?: Partial<ISoTWatcherConfig>): ISoTWatcherConfig {
  // Try reading from SOTAgent config.json
  try {
    const sotagentDir = path.join(POLARISOR_ROOT, 'SOTAgent');
    const configPath = path.join(sotagentDir, 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (raw.ssot_watcher) {
        _config = { ...DEFAULT_CONFIG, ...raw.ssot_watcher };
      }
    }
  } catch {
    // use defaults
  }
  // Apply runtime overrides
  if (override) {
    _config = { ..._config, ...override };
  }
  return _config;
}

// ─── scanProjects() ──────────────────────────────────────────────

/**
 * Scan all project directories under ~/Polarisor for polaris.json files.
 * Mirrors collectPolarisFiles() from ssot-audit.mjs.
 */
function scanProjects(): IWatchEntry[] {
  const entries: IWatchEntry[] = [];
  try {
    const items = fs.readdirSync(POLARISOR_ROOT, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory() && !item.isSymbolicLink()) continue;

      const projectDir = path.join(POLARISOR_ROOT, item.name);
      const polarisPath = path.join(projectDir, 'polaris.json');
      if (!fs.existsSync(polarisPath)) continue;

      // Check if ssot_watch is disabled for this project
      let ssotWatchEnabled = true;
      try {
        const data = JSON.parse(fs.readFileSync(polarisPath, 'utf-8'));
        if (data.ssot_watch === false) {
          ssotWatchEnabled = false;
        }
      } catch {
        // parse error — still watch the file
      }

      const polarSoulPath = path.join(projectDir, 'PolarSoul.md');
      const capabilitiesPath = path.join(projectDir, 'capabilities.json');

      entries.push({
        projectDir,
        polarisPath,
        polarSoulPath,
        capabilitiesPath,
        ssotWatchEnabled,
      });
    }
  } catch (e) {
    console.error('[ssot-watcher] scanProjects error:', e);
  }
  return entries;
}

// ─── fileFingerprint() ───────────────────────────────────────────

/**
 * Generate a fingerprint for a file based on size + mtimeMs.
 * Mirrors rawDirFingerprint() from knowlever-monitor.ts.
 */
function fileFingerprint(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

// ─── Validation pipeline ─────────────────────────────────────────

/**
 * Step 1: Validate JSON parsability.
 */
function validateJson(filePath: string): { ok: boolean; data: any | null; error: string | null } {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return { ok: true, data, error: null };
  } catch (e: any) {
    return { ok: false, data: null, error: `JSON parse error: ${e.message}` };
  }
}

/**
 * Check if a feature has weak behavior (copied from ssot-audit.mjs).
 */
function hasWeakBehavior(feature: any): boolean {
  if (!Array.isArray(feature.behavior) || feature.behavior.length === 0) return true;
  const behavior = feature.behavior.map((item: any) => String(item).trim()).filter(Boolean);
  if (behavior.length === 0) return true;
  if (feature.description && behavior.length === 1 && behavior[0] === String(feature.description).trim()) return true;
  return behavior.some((item: string) => item.length < 8);
}

/**
 * Check if a feature has evidence (copied from ssot-audit.mjs).
 */
function hasEvidence(feature: any): boolean {
  const values = [
    feature.evidence,
    feature.tests,
    feature.last_verified_commit,
    feature.last_verified_at,
  ];
  return values.some((value) => {
    if (Array.isArray(value)) return value.some((item: any) => String(item).trim().length > 0);
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return String(value ?? '').trim().length > 0;
  });
}

/**
 * Step 2: Validate SSoT format conventions.
 * Returns warnings (not errors) for soft violations.
 */
function validateSsoTFormat(parsedJson: any, projectDir: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const projectName = parsedJson.name ?? path.basename(projectDir);

  // requirements must be an array
  if (!Array.isArray(parsedJson.requirements)) {
    errors.push('requirements field is missing or not an array');
    return { errors, warnings };
  }

  for (const req of parsedJson.requirements) {
    if (!Array.isArray(req.features)) continue;
    for (const feature of req.features) {
      // done status without test_status
      if (feature.status === 'done' && !feature.test_status) {
        warnings.push(`[${projectName}] feature "${feature.name}" is done but has no test_status`);
      }

      // weak behavior
      if (hasWeakBehavior(feature)) {
        if (!Array.isArray(feature.behavior) || feature.behavior.length === 0) {
          errors.push(`[${projectName}] feature "${feature.name}" has empty behavior array`);
        } else {
          warnings.push(`[${projectName}] feature "${feature.name}" has weak behavior`);
        }
      }

      // done without evidence
      if (feature.status === 'done' && !hasEvidence(feature)) {
        warnings.push(`[${projectName}] feature "${feature.name}" is done but has no evidence`);
      }
    }
  }

  // contacts field checks
  if (!parsedJson.contacts?.last_updated || !parsedJson.contacts?.updated_by) {
    warnings.push(`[${projectName}] contacts field missing last_updated or updated_by`);
  }

  return { errors, warnings };
}

/**
 * Step 3: Snapshot interfaces for drift detection (Layer 2 prep).
 * Records to memory Map; returns true if interface change detected.
 */
function snapshotInterfaces(parsedJson: any, projectDir: string): boolean {
  const projectName = parsedJson.name ?? path.basename(projectDir);
  let hasDrift = false;

  for (const req of parsedJson.requirements ?? []) {
    for (const feat of req.features ?? []) {
      if (!feat.interfaces || !Array.isArray(feat.interfaces)) continue;

      const key = `${projectName}::${feat.name}`;
      const newSnapshot = JSON.stringify(feat.interfaces.sort());
      const oldSnapshot = _interfaceSnapshots.get(key);

      if (oldSnapshot && oldSnapshot !== newSnapshot) {
        hasDrift = true;
      }
      _interfaceSnapshots.set(key, newSnapshot);
    }
  }

  return hasDrift;
}

// ─── Result distribution ─────────────────────────────────────────

/**
 * Append a validated event to the ssot-events.jsonl log.
 * Creates the log directory if it does not exist.
 */
function appendToEventLog(result: IValidationResult): void {
  const logPath = resolvePath(_config.log_file);
  const logDir = path.dirname(logPath);

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const entry = {
      ts: result.timestamp,
      project: result.project,
      file: result.file,
      event: result.eventType,
      result: result.passed ? 'pass' : 'fail',
      errors: result.errors.length > 0 ? result.errors : undefined,
      warnings: result.warnings.length > 0 ? result.warnings : undefined,
    };

    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[ssot-watcher] Failed to append to event log:', e);
  }
}

/**
 * Write an inbox flag for format errors.
 * Also writes a project-specific flag file in ~/.sotagent/inbox/.
 */
function writeErrorFlag(result: IValidationResult): void {
  const detail = result.errors.join('; ');
  writeInboxFlag('sync_suggestion', {
    project: result.project,
    detail: `SSoT validation error in ${result.file}: ${detail}`,
  });

  // Also write a project-specific flag file in ~/.sotagent/inbox/
  const inboxDir = path.join(os.homedir(), '.sotagent', 'inbox');
  const flagFile = path.join(inboxDir, `ssot-error-${result.project}.flag`);
  try {
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }
    const flagContent = JSON.stringify({
      ts: result.timestamp,
      project: result.project,
      file: result.file,
      errors: result.errors,
      type: 'ssot-validation-error',
    }, null, 2);
    fs.writeFileSync(flagFile, flagContent);
    console.log(`[ssot-watcher] inbox flag written to ${flagFile}`);
  } catch (e) {
    console.error('[ssot-watcher] Failed to write error flag:', e);
  }
}

/**
 * Write an inbox flag for interface drift.
 */
function writeDriftFlag(project: string, featureName: string): void {
  writeInboxFlag('sync_suggestion', {
    project,
    detail: `SSoT interface drift detected: ${featureName}`,
  });
}

/**
 * Resolve a path that may start with ~.
 */
function resolvePath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// ─── Debounce + validation trigger ───────────────────────────────

/**
 * Debounce file change events and trigger validation pipeline.
 * Mirrors the cooldown pattern from knowlever-monitor.ts.
 */
function debounceAndValidate(entry: IWatchEntry, eventType: 'created' | 'modified' | 'deleted'): void {
  const filePath = entry.polarisPath;
  const projectName = path.basename(entry.projectDir);

  // Get or create debounce state
  let state = _debounceStates.get(filePath);
  if (!state) {
    state = { timer: null, lastEventTs: 0, lastFingerprint: '' };
    _debounceStates.set(filePath, state);
  }

  // Handle deletion
  if (eventType === 'deleted') {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const result: IValidationResult = {
      passed: false,
      project: projectName,
      file: filePath,
      eventType: 'deleted',
      errors: ['File deleted'],
      warnings: [],
      timestamp: new Date().toISOString(),
    };
    appendToEventLog(result);
    writeErrorFlag(result);
    return;
  }

  // Check actual content change via fingerprint
  const fp = fileFingerprint(filePath);
  if (fp === state.lastFingerprint) return; // no actual change
  state.lastFingerprint = fp;

  // Clear previous debounce timer
  if (state.timer) clearTimeout(state.timer);

  state.lastEventTs = Date.now();

  // Set debounce timer
  state.timer = setTimeout(() => {
    state.timer = null;
    void runValidationPipeline(entry, eventType);
  }, _config.debounce_ms);
}

/**
 * Run the full validation pipeline for a changed file.
 */
async function runValidationPipeline(entry: IWatchEntry, eventType: 'created' | 'modified' | 'deleted'): Promise<void> {
  const filePath = entry.polarisPath;
  const projectName = path.basename(entry.projectDir);

  // Step 1: JSON validation
  const jsonResult = validateJson(filePath);
  if (!jsonResult.ok) {
    const result: IValidationResult = {
      passed: false,
      project: projectName,
      file: filePath,
      eventType,
      errors: [jsonResult.error!],
      warnings: [],
      timestamp: new Date().toISOString(),
    };
    appendToEventLog(result);
    writeErrorFlag(result);
    console.log(`[ssot-watcher] ${projectName}: validation FAILED — ${jsonResult.error}`);
    return;
  }

  // Step 2: SSoT format validation
  const { errors, warnings } = validateSsoTFormat(jsonResult.data, entry.projectDir);

  // Step 3: Interface snapshot + drift detection
  const hasDrift = snapshotInterfaces(jsonResult.data, entry.projectDir);

  const passed = errors.length === 0;
  const result: IValidationResult = {
    passed,
    project: projectName,
    file: filePath,
    eventType,
    errors,
    warnings,
    timestamp: new Date().toISOString(),
  };

  // Distribute results
  appendToEventLog(result);

  if (!passed) {
    writeErrorFlag(result);
    console.log(`[ssot-watcher] ${projectName}: validation FAILED — ${errors.length} error(s)`);
  } else if (hasDrift) {
    // Find which features had drift
    for (const req of jsonResult.data.requirements ?? []) {
      for (const feat of req.features ?? []) {
        if (feat.interfaces && Array.isArray(feat.interfaces)) {
          const key = `${projectName}::${feat.name}`;
          // drift already tracked in snapshotInterfaces, just write flag
        }
      }
    }
    writeDriftFlag(projectName, 'interfaces');
    console.log(`[ssot-watcher] ${projectName}: pass with interface drift`);
  } else {
    console.log(`[ssot-watcher] ${projectName}: validation passed`);
  }
}

// ─── fs.watch setup ──────────────────────────────────────────────

/**
 * Set up fs.watch for a watch entry's files.
 * Falls back to polling on error.
 */
function setupFsWatch(entry: IWatchEntry): void {
  if (!entry.ssotWatchEnabled) return;

  // Watch polaris.json (always exists)
  watchFile(entry.polarisPath, entry);

  // Optionally watch PolarSoul.md and capabilities.json if they exist
  if (fs.existsSync(entry.polarSoulPath)) {
    watchFile(entry.polarSoulPath, entry);
  }
  if (fs.existsSync(entry.capabilitiesPath)) {
    watchFile(entry.capabilitiesPath, entry);
  }
}

function watchFile(filePath: string, entry: IWatchEntry): void {
  try {
    const watcher = fs.watch(filePath, { recursive: false }, (eventType) => {
      if (eventType === 'rename' || eventType === 'change') {
        // Check if file still exists
        if (fs.existsSync(filePath)) {
          debounceAndValidate(entry, 'modified');
        } else {
          debounceAndValidate(entry, 'deleted');
        }
      }
    });
    _fsWatchers.push(watcher);

    watcher.on('error', (err) => {
      console.error(`[ssot-watcher] fs.watch error on ${filePath}:`, err.message);
      // Remove broken watcher from list
      const idx = _fsWatchers.indexOf(watcher);
      if (idx >= 0) _fsWatchers.splice(idx, 1);
    });
  } catch (e: any) {
    console.warn(`[ssot-watcher] fs.watch setup failed for ${filePath}:`, e.message);
  }
}

// ─── Polling fallback ────────────────────────────────────────────

/**
 * Poll all watch entries every N seconds.
 * Compares current fingerprint against last known.
 * Mirrors scanRawChanges() from knowlever-monitor.ts.
 */
function pollingFallback(): void {
  if (_pollingTimer) clearInterval(_pollingTimer);

  _pollingTimer = setInterval(() => {
    try {
      for (const entry of _watchEntries) {
        if (!entry.ssotWatchEnabled) continue;

        const fp = fileFingerprint(entry.polarisPath);
        const state = _debounceStates.get(entry.polarisPath);

        if (state && state.lastFingerprint && fp !== state.lastFingerprint) {
          // Content changed, trigger debounce pipeline
          if (fs.existsSync(entry.polarisPath)) {
            debounceAndValidate(entry, 'modified');
          } else {
            debounceAndValidate(entry, 'deleted');
          }
        }
      }
    } catch (e) {
      console.error('[ssot-watcher] polling fallback error:', e);
    }
  }, _config.polling_interval_sec * 1000);
}

// ─── Lifecycle exports ───────────────────────────────────────────

/**
 * Start the SSoT watcher.
 * Reads config, scans projects, sets up fs.watch, and starts polling fallback.
 */
export function startSSoTWatcher(config?: Partial<ISoTWatcherConfig>): void {
  if (_running) {
    console.log('[ssot-watcher] already running, skipping');
    return;
  }

  loadConfig(config);

  if (!_config.enabled) {
    console.log('[ssot-watcher] disabled by config');
    return;
  }

  // Scan projects to build watch list
  _watchEntries = scanProjects();

  // Set up fs.watch for each entry
  for (const entry of _watchEntries) {
    setupFsWatch(entry);
  }

  // Start polling fallback
  pollingFallback();

  // Pre-populate interface snapshots from current state
  for (const entry of _watchEntries) {
    try {
      if (!fs.existsSync(entry.polarisPath)) continue;
      const raw = fs.readFileSync(entry.polarisPath, 'utf-8');
      const data = JSON.parse(raw);
      snapshotInterfaces(data, entry.projectDir);
    } catch {
      // skip
    }
  }

  _running = true;

  const watchCount = _watchEntries.filter(e => e.ssotWatchEnabled).length;
  console.log(`[ssot-watcher] started, watching ${watchCount} projects`);
}

/**
 * Stop the SSoT watcher.
 * Closes all fs.FSWatcher instances, clears debounce timers and polling.
 */
export function stopSSoTWatcher(): void {
  // Close all fs watchers
  for (const w of _fsWatchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  _fsWatchers.length = 0;

  // Clear all debounce timers
  for (const [filePath, state] of _debounceStates) {
    if (state.timer) clearTimeout(state.timer);
  }
  _debounceStates.clear();

  // Clear polling timer
  if (_pollingTimer) {
    clearInterval(_pollingTimer);
    _pollingTimer = null;
  }

  // Clear memory state
  _interfaceSnapshots.clear();
  _watchEntries = [];
  _running = false;

  console.log('[ssot-watcher] stopped');
}

/**
 * Check if the watcher is currently running.
 */
export function isWatcherRunning(): boolean {
  return _running;
}
