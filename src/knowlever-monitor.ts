/**
 * knowlever-monitor.ts — KnowLever pipeline monitoring, auto-compile, and AutoOffice integration.
 *
 * Watches KnowLever raw directories for changes, triggers auto-compile after
 * a 30-minute cooldown, tracks pipeline runs, and delegates PPT/PDF generation
 * to AutoOffice.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { validateTopicName, shellEscape } from './command-guard.js';
import { AUTOOFFICE_PORT } from './ports.js';

const execP = promisify(exec);

// ─── Types ──────────────────────────────────────────────

export type PipelineStep =
  | 'idle'
  | 'ingest'
  | 'compile'
  | 'build'
  | 'autooffice:pptx'
  | 'autooffice:pdf'
  | 'site:enhanced'
  | 'done'
  | 'error';

export interface ITopicMeta {
  topic_id: string;
  name: string;
  mode: string;
  mode_suggestion: string | null;
  metrics: Record<string, unknown>;
  created_at: string;
  last_evaluated: string | null;
  retrieval_indexed?: boolean;
  last_indexed_pages?: number;
  last_indexed_chunks?: number;
}

export interface ITopicStatus {
  name: string;
  user: string;
  meta: ITopicMeta | null;
  rawFileCount: number;
  normalizedCount: number;
  wikiPageCount: number;
  outputPageCount: number;
  lastRawChange: string | null;
  lastCompile: string | null;
  lastBuild: string | null;
  pipeline: IPipelineRun | null;
}

export interface IPipelineRun {
  topicId: string;
  step: PipelineStep;
  progress: number; // 0..100
  startedAt: string;
  outputs: string[];
  logs: string[];
  pid: number | null;
  error: string | null;
  resourceUsage: { cpu: number; mem: number } | null;
  elapsedMs: number;
}

export type OutputFormat = 'html' | 'pptx' | 'pdf' | 'enhanced';

export interface IKnowLeverConfig {
  autoCompile: boolean;
  cooldownMinutes: number;
  defaultOutputs: OutputFormat[];
  autoOfficeUrl: string;
}

interface IRawWatchState {
  lastChangeTs: number;
  cooldownTimer: ReturnType<typeof setTimeout> | null;
  fileHash: string;
}

// ─── Constants ──────────────────────────────────────────

const POLARISOR = path.join(process.env.HOME || '~', 'Polarisor');
const KNOWLEVER_ROOT = path.join(POLARISOR, 'KnowLever');
const DATA_DIR = path.join(KNOWLEVER_ROOT, 'data');

const DEFAULT_CONFIG: IKnowLeverConfig = {
  autoCompile: true,
  cooldownMinutes: 30,
  defaultOutputs: ['html'],
  autoOfficeUrl: `http://127.0.0.1:${AUTOOFFICE_PORT}`,
};

// ─── State ──────────────────────────────────────────────

let _config: IKnowLeverConfig = { ...DEFAULT_CONFIG };
const _pipelines = new Map<string, IPipelineRun>();
const _processes = new Map<string, ChildProcess>();
const _rawWatch = new Map<string, IRawWatchState>();
let _fsWatchers: fs.FSWatcher[] = [];
let _scanTimer: ReturnType<typeof setInterval> | null = null;
const MAX_COMPLETED_PIPELINES = 20;
const PIPELINE_EVICT_AGE_MS = 30 * 60_000; // 30 min after completion

// ─── Config ─────────────────────────────────────────────

const CONFIG_PATH = path.join(KNOWLEVER_ROOT, '.knowlever-monitor.json');

function loadConfig(): IKnowLeverConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      _config = { ...DEFAULT_CONFIG, ...raw };
    }
  } catch { /* use defaults */ }
  return _config;
}

function saveConfig(cfg: Partial<IKnowLeverConfig>): IKnowLeverConfig {
  _config = { ..._config, ...cfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2) + '\n');
  return _config;
}

export function getConfig(): IKnowLeverConfig {
  return { ..._config };
}

export function updateConfig(cfg: Partial<IKnowLeverConfig>): IKnowLeverConfig {
  return saveConfig(cfg);
}

// ─── Topic scanning ─────────────────────────────────────

function countFiles(dir: string, ext?: string): number {
  try {
    if (!fs.existsSync(dir)) return 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let count = 0;
    for (const e of entries) {
      if (e.isFile() && (!ext || e.name.endsWith(ext))) count++;
      else if (e.isDirectory()) count += countFiles(path.join(dir, e.name), ext);
    }
    return count;
  } catch { return 0; }
}

function latestMtime(dir: string): number {
  try {
    if (!fs.existsSync(dir)) return 0;
    let latest = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        const mt = fs.statSync(full).mtimeMs;
        if (mt > latest) latest = mt;
      } else if (e.isDirectory()) {
        const sub = latestMtime(full);
        if (sub > latest) latest = sub;
      }
    }
    return latest;
  } catch { return 0; }
}

function readCompileManifest(topicDir: string): string | null {
  const manifestPath = path.join(topicDir, 'wiki', '.compile-manifest.json');
  try {
    if (!fs.existsSync(manifestPath)) return null;
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (data._lastRun) return data._lastRun;
    const times = Object.values(data)
      .filter((v: any) => v?.compiled_at)
      .map((v: any) => v.compiled_at);
    return times.length ? times.sort().pop()! : null;
  } catch { return null; }
}

function readBuildManifest(topicDir: string): string | null {
  const manifestPath = path.join(topicDir, 'output', 'assets', 'data', 'build-manifest.json');
  try {
    if (!fs.existsSync(manifestPath)) return null;
    const stat = fs.statSync(manifestPath);
    return stat.mtime.toISOString();
  } catch { return null; }
}

export function listTopics(user = 'admin'): ITopicStatus[] {
  const topicsDir = path.join(DATA_DIR, 'users', user, 'topics');
  if (!fs.existsSync(topicsDir)) return [];

  return fs.readdirSync(topicsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const topicDir = path.join(topicsDir, d.name);
      let meta: ITopicMeta | null = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(topicDir, 'meta.json'), 'utf-8'));
      } catch { /* no meta */ }

      const rawMtime = latestMtime(path.join(topicDir, 'raw'));
      const topicId = `${user}/${d.name}`;

      return {
        name: d.name,
        user,
        meta,
        rawFileCount: countFiles(path.join(topicDir, 'raw')),
        normalizedCount: countFiles(path.join(topicDir, 'normalized')),
        wikiPageCount: countFiles(path.join(topicDir, 'wiki'), '.md'),
        outputPageCount: countFiles(path.join(topicDir, 'output'), '.html'),
        lastRawChange: rawMtime > 0 ? new Date(rawMtime).toISOString() : null,
        lastCompile: readCompileManifest(topicDir),
        lastBuild: readBuildManifest(topicDir),
        pipeline: _pipelines.get(topicId) ?? null,
      };
    });
}

export function getTopicStatus(topicName: string, user = 'admin'): ITopicStatus | null {
  return listTopics(user).find(t => t.name === topicName) ?? null;
}

export function listAllTopics(): ITopicStatus[] {
  const usersDir = path.join(DATA_DIR, 'users');
  if (!fs.existsSync(usersDir)) return [];

  const all: ITopicStatus[] = [];
  for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    all.push(...listTopics(entry.name));
  }
  return all;
}

export function listUsers(): string[] {
  const usersDir = path.join(DATA_DIR, 'users');
  if (!fs.existsSync(usersDir)) return [];
  return fs.readdirSync(usersDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

// ─── Pipeline execution ─────────────────────────────────

function createPipelineRun(topicId: string): IPipelineRun {
  return {
    topicId,
    step: 'idle',
    progress: 0,
    startedAt: new Date().toISOString(),
    outputs: [],
    logs: [],
    pid: null,
    error: null,
    resourceUsage: null,
    elapsedMs: 0,
  };
}

function appendLog(run: IPipelineRun, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  run.logs.push(`[${ts}] ${msg}`);
  if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 400);
}

async function sampleProcessResource(pid: number): Promise<{ cpu: number; mem: number } | null> {
  try {
    const { stdout } = await execP(`ps -p ${pid} -o %cpu,%mem | tail -1`, { timeout: 3000 });
    const parts = stdout.trim().split(/\s+/);
    if (parts.length >= 2) {
      return { cpu: parseFloat(parts[0]!) || 0, mem: parseFloat(parts[1]!) || 0 };
    }
  } catch { /* process may have exited */ }
  return null;
}

function runStep(
  topicName: string,
  user: string,
  step: PipelineStep,
  cmd: string,
  cwd: string,
  run: IPipelineRun,
): Promise<boolean> {
  return new Promise((resolve) => {
    run.step = step;
    appendLog(run, `开始: ${step}`);

    const child = spawn('bash', ['-c', cmd], { cwd, env: { ...process.env } });
    const topicId = `${user}/${topicName}`;
    _processes.set(topicId, child);
    run.pid = child.pid ?? null;

    const resourceTimer = setInterval(async () => {
      if (child.pid) {
        run.resourceUsage = await sampleProcessResource(child.pid);
        run.elapsedMs = Date.now() - new Date(run.startedAt).getTime();
      }
    }, 5000);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines.slice(-3)) appendLog(run, line);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearInterval(resourceTimer);
      _processes.delete(topicId);
      run.pid = null;
      run.elapsedMs = Date.now() - new Date(run.startedAt).getTime();

      if (code === 0) {
        appendLog(run, `完成: ${step}`);
        resolve(true);
      } else {
        const errMsg = stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`;
        appendLog(run, `失败: ${step} — ${errMsg}`);
        run.error = errMsg;
        resolve(false);
      }
    });

    child.on('error', (err) => {
      clearInterval(resourceTimer);
      _processes.delete(topicId);
      run.pid = null;
      run.error = err.message;
      appendLog(run, `错误: ${step} — ${err.message}`);
      resolve(false);
    });
  });
}

export async function runPipeline(
  topicName: string,
  outputs: OutputFormat[] = _config.defaultOutputs,
  user = 'admin',
): Promise<IPipelineRun> {
  const topicId = `${user}/${topicName}`;

  if (_pipelines.has(topicId) && _pipelines.get(topicId)!.step !== 'done' && _pipelines.get(topicId)!.step !== 'error' && _pipelines.get(topicId)!.step !== 'idle') {
    return _pipelines.get(topicId)!;
  }

  const run = createPipelineRun(topicId);
  _pipelines.set(topicId, run);

  const topicCheck = validateTopicName(topicName);
  if (!topicCheck.ok) {
    run.step = 'error';
    run.error = `Invalid topic name: ${topicCheck.reason}`;
    return run;
  }

  const topicDir = path.join(DATA_DIR, 'users', user, 'topics', topicName);
  if (!fs.existsSync(topicDir)) {
    run.step = 'error';
    run.error = `Topic directory not found: ${topicDir}`;
    return run;
  }

  const safeTopic = shellEscape(topicName);
  const safeUser = shellEscape(user);
  const totalSteps = 2 + outputs.filter(o => o !== 'html').length;
  let completed = 0;

  // Step 1: LLM compile
  run.progress = Math.round((completed / totalSteps) * 100);
  const compileOk = await runStep(
    topicName, user, 'compile',
    `node wiki-engine/compile.js --topic ${safeTopic} --user ${safeUser}`,
    KNOWLEVER_ROOT, run,
  );
  if (!compileOk) { run.step = 'error'; return run; }
  completed++;

  // Step 2: Build HTML
  run.progress = Math.round((completed / totalSteps) * 100);
  const buildOk = await runStep(
    topicName, user, 'build',
    `node wiki-engine/build.js --topic ${safeTopic} --user ${safeUser}`,
    KNOWLEVER_ROOT, run,
  );
  if (!buildOk) { run.step = 'error'; return run; }
  completed++;
  run.outputs.push('html');

  // Step 3+: AutoOffice outputs
  for (const fmt of outputs) {
    if (fmt === 'html') continue;

    if (fmt === 'enhanced') {
      run.progress = Math.round((completed / totalSteps) * 100);
      const enhOk = await runStep(
        topicName, user, 'site:enhanced',
        `node site-enhanced/generate.js --topic ${safeTopic} --user ${safeUser}`,
        KNOWLEVER_ROOT, run,
      );
      if (enhOk) run.outputs.push('enhanced');
      completed++;
      continue;
    }

    // PPT / PDF via AutoOffice
    run.progress = Math.round((completed / totalSteps) * 100);
    const stepName = `autooffice:${fmt}` as PipelineStep;

    try {
      appendLog(run, `开始: ${stepName}`);
      run.step = stepName;

      const wikiDir = path.join(topicDir, 'wiki');
      const sections = buildSectionsFromWiki(wikiDir, topicName);

      const res = await fetch(`${_config.autoOfficeUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: fmt,
          data: { title: topicName, sections },
          locale: 'zh-CN',
        }),
      });

      if (!res.ok) throw new Error(`AutoOffice ${res.status}: ${await res.text()}`);

      const outputPath = path.join(topicDir, 'output', `${topicName}.${fmt}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outputPath, buf);
      run.outputs.push(fmt);
      appendLog(run, `完成: ${stepName} → ${outputPath}`);
    } catch (e: any) {
      appendLog(run, `失败: ${stepName} — ${e.message}`);
    }
    completed++;
  }

  run.progress = 100;
  run.step = 'done';
  run.elapsedMs = Date.now() - new Date(run.startedAt).getTime();
  appendLog(run, `流水线完成 (${Math.round(run.elapsedMs / 1000)}s)`);

  evictStalePipelines();
  return run;
}

/** Evict completed/errored pipeline runs older than retention threshold */
function evictStalePipelines(): void {
  const now = Date.now();
  const completed = [..._pipelines.entries()]
    .filter(([, r]) => r.step === 'done' || r.step === 'error');

  for (const [id, run] of completed) {
    const age = now - new Date(run.startedAt).getTime() - (run.elapsedMs ?? 0);
    if (age > PIPELINE_EVICT_AGE_MS) {
      _pipelines.delete(id);
    }
  }

  if (_pipelines.size > MAX_COMPLETED_PIPELINES) {
    const sorted = completed.sort((a, b) =>
      new Date(a[1].startedAt).getTime() - new Date(b[1].startedAt).getTime()
    );
    const excess = _pipelines.size - MAX_COMPLETED_PIPELINES;
    for (let i = 0; i < excess && i < sorted.length; i++) {
      _pipelines.delete(sorted[i]![0]);
    }
  }
}

function buildSectionsFromWiki(wikiDir: string, topicName: string): Array<{ title: string; content: string }> {
  const sections: Array<{ title: string; content: string }> = [];
  try {
    if (!fs.existsSync(wikiDir)) return [{ title: topicName, content: 'No wiki pages found.' }];

    const files = fs.readdirSync(wikiDir).filter(f => f.endsWith('.md')).slice(0, 30);
    for (const file of files) {
      const content = fs.readFileSync(path.join(wikiDir, file), 'utf-8');
      const titleMatch = content.match(/^#\s+(.+)/m);
      const title = titleMatch?.[1] || file.replace('.md', '');
      const body = content.replace(/^---[\s\S]*?---\n?/, '').replace(/^#\s+.+\n?/, '').trim();
      sections.push({ title, content: body.slice(0, 2000) });
    }
  } catch { /* return what we have */ }
  return sections.length ? sections : [{ title: topicName, content: '' }];
}

export function cancelPipeline(topicName: string, user = 'admin'): boolean {
  const topicId = `${user}/${topicName}`;
  const proc = _processes.get(topicId);
  if (proc && proc.pid) {
    try { process.kill(proc.pid, 'SIGTERM'); } catch { /* already dead */ }
    _processes.delete(topicId);
  }
  const run = _pipelines.get(topicId);
  if (run && run.step !== 'done' && run.step !== 'error') {
    run.step = 'error';
    run.error = 'Cancelled by user';
    appendLog(run, '用户取消');
    return true;
  }
  return false;
}

export function getPipelineRun(topicName: string, user = 'admin'): IPipelineRun | null {
  return _pipelines.get(`${user}/${topicName}`) ?? null;
}

// ─── Raw change monitoring ──────────────────────────────

function rawDirFingerprint(rawDir: string): string {
  try {
    if (!fs.existsSync(rawDir)) return '';
    const entries = fs.readdirSync(rawDir, { recursive: true, withFileTypes: false }) as string[];
    const stats = entries.sort().map(e => {
      try {
        const s = fs.statSync(path.join(rawDir, e));
        return `${e}:${s.size}:${s.mtimeMs}`;
      } catch { return e; }
    });
    return stats.join('|');
  } catch { return ''; }
}

function handleRawChange(topicName: string, user: string) {
  const topicId = `${user}/${topicName}`;
  const rawDir = path.join(DATA_DIR, 'users', user, 'topics', topicName, 'raw');
  const newHash = rawDirFingerprint(rawDir);

  const state = _rawWatch.get(topicId) ?? { lastChangeTs: 0, cooldownTimer: null, fileHash: '' };

  if (newHash === state.fileHash) return; // no actual change

  state.fileHash = newHash;
  state.lastChangeTs = Date.now();

  if (state.cooldownTimer) clearTimeout(state.cooldownTimer);

  if (_config.autoCompile) {
    state.cooldownTimer = setTimeout(() => {
      const now = Date.now();
      const elapsed = now - state.lastChangeTs;
      if (elapsed >= _config.cooldownMinutes * 60 * 1000 - 5000) {
        console.log(`[knowlever] auto-compile triggered for ${topicName} (${_config.cooldownMinutes}min cooldown)`);
        void runPipeline(topicName, _config.defaultOutputs, user);
      }
    }, _config.cooldownMinutes * 60 * 1000);
  }

  _rawWatch.set(topicId, state);
}

function scanRawChanges() {
  try {
    const usersDir = path.join(DATA_DIR, 'users');
    if (!fs.existsSync(usersDir)) return;

    for (const userEntry of fs.readdirSync(usersDir, { withFileTypes: true })) {
      if (!userEntry.isDirectory()) continue;
      const topicsDir = path.join(usersDir, userEntry.name, 'topics');
      if (!fs.existsSync(topicsDir)) continue;

      for (const topicEntry of fs.readdirSync(topicsDir, { withFileTypes: true })) {
        if (!topicEntry.isDirectory()) continue;
        handleRawChange(topicEntry.name, userEntry.name);
      }
    }
  } catch (e) {
    console.error('[knowlever] scan error:', e);
  }
}

// ─── Overall status ─────────────────────────────────────

export interface IKnowLeverStatus {
  available: boolean;
  topicCount: number;
  runningPipelines: number;
  autoCompile: boolean;
  cooldownMinutes: number;
  autoOfficeAvailable: boolean;
}

export async function getOverallStatus(): Promise<IKnowLeverStatus> {
  const available = fs.existsSync(KNOWLEVER_ROOT);
  const topics = available ? listAllTopics() : [];
  const running = [..._pipelines.values()].filter(
    p => p.step !== 'idle' && p.step !== 'done' && p.step !== 'error',
  ).length;

  let autoOfficeAvailable = false;
  try {
    const res = await fetch(`${_config.autoOfficeUrl}/health`, { signal: AbortSignal.timeout(2000) });
    autoOfficeAvailable = res.ok;
  } catch { /* not available */ }

  return {
    available,
    topicCount: topics.length,
    runningPipelines: running,
    autoCompile: _config.autoCompile,
    cooldownMinutes: _config.cooldownMinutes,
    autoOfficeAvailable,
  };
}

// ─── Lifecycle ──────────────────────────────────────────

/**
 * Startup catch-up: find topics with normalized content but no compile manifest,
 * and queue them for compilation sequentially.
 */
async function catchUpCompile() {
  if (!_config.autoCompile) return;

  const topics = listAllTopics();
  const needCompile = topics.filter(t => t.normalizedCount > 0 && !t.lastCompile);
  if (needCompile.length === 0) return;

  console.log(`[knowlever] catch-up: ${needCompile.length} topic(s) never compiled — queuing`);
  for (const topic of needCompile) {
    const topicId = `${topic.user}/${topic.name}`;
    const existing = _pipelines.get(topicId);
    if (existing && existing.step !== 'done' && existing.step !== 'error' && existing.step !== 'idle') {
      continue;
    }
    console.log(`[knowlever] catch-up compile: ${topicId} (${topic.normalizedCount} normalized, 0 compiled)`);
    await runPipeline(topic.name, _config.defaultOutputs, topic.user);
  }
}

export function startMonitor() {
  loadConfig();

  if (!fs.existsSync(KNOWLEVER_ROOT)) {
    console.log('[knowlever] KnowLever not found, monitor disabled');
    return;
  }

  // Periodic scan every 60s
  _scanTimer = setInterval(scanRawChanges, 60_000);
  setTimeout(scanRawChanges, 5_000);

  // Catch-up: compile topics that were never compiled (15s after startup)
  if (_config.autoCompile) {
    setTimeout(() => void catchUpCompile(), 15_000);
  }

  // Try fs.watch on raw dirs for faster detection
  try {
    const usersDir = path.join(DATA_DIR, 'users');
    if (fs.existsSync(usersDir)) {
      for (const userEntry of fs.readdirSync(usersDir, { withFileTypes: true })) {
        if (!userEntry.isDirectory()) continue;
        const topicsDir = path.join(usersDir, userEntry.name, 'topics');
        if (!fs.existsSync(topicsDir)) continue;

        for (const topicEntry of fs.readdirSync(topicsDir, { withFileTypes: true })) {
          if (!topicEntry.isDirectory()) continue;
          const rawDir = path.join(topicsDir, topicEntry.name, 'raw');
          if (fs.existsSync(rawDir)) {
            try {
              const watcher = fs.watch(rawDir, { recursive: true }, () => {
                handleRawChange(topicEntry.name, userEntry.name);
              });
              _fsWatchers.push(watcher);
            } catch { /* fs.watch not supported on this path */ }
          }
        }
      }
    }
  } catch (e) {
    console.error('[knowlever] fs.watch setup failed:', e);
  }

  console.log(`[knowlever] monitor started (auto-compile: ${_config.autoCompile}, cooldown: ${_config.cooldownMinutes}min)`);
}

export function stopMonitor() {
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
  for (const w of _fsWatchers) { try { w.close(); } catch {} }
  _fsWatchers = [];

  for (const [id, state] of _rawWatch) {
    if (state.cooldownTimer) clearTimeout(state.cooldownTimer);
  }
  _rawWatch.clear();

  for (const [id, proc] of _processes) {
    try { if (proc.pid) process.kill(proc.pid, 'SIGTERM'); } catch {}
  }
  _processes.clear();
}
