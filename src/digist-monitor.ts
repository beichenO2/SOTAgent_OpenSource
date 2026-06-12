/**
 * digist-monitor.ts — DiGist SQLite + HTTP API bridge for SOTAgent console.
 *
 * Reads ~/Polarisor/digist/data/digist.sqlite when present; optional DiGist API
 * at DIGIST_API_URL (default http://127.0.0.1:3800) for /health + crawl trigger.
 *
 * TODO: When DiGist adds native `interests` / `sources` tables, migrate off
 * SOTAgent-created sidecar tables (same names) or align schema with DiGist D3.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { validateTopicName } from './command-guard.js';

const execFileP = promisify(execFile);

const POLARISOR = path.join(process.env.HOME || '~', 'Polarisor');
const DIGIST_ROOT = path.join(POLARISOR, 'digist');
const DEFAULT_DB_PATH = path.join(DIGIST_ROOT, 'data', 'digist.sqlite');
const KNOWLEVER_ROOT = path.join(POLARISOR, 'KnowLever');

const DIGIST_API_URL = (process.env.DIGIST_API_URL || 'http://127.0.0.1:3800').replace(/\/$/, '');
const DEFAULT_INTEREST_SCHEDULE = '0 8,11,14,17,20,23 * * *';

const DEFAULT_SOURCES: Array<{ id: string; platform: string; config: Record<string, unknown>; enabled?: boolean }> = [
  { id: 'src-hackernews', platform: 'hackernews', config: { query: '' } },
  { id: 'src-arxiv', platform: 'arxiv', config: { query: 'large language model agent' } },
  { id: 'src-github', platform: 'github', config: { query: 'trending' } },
  { id: 'src-reddit', platform: 'reddit', config: { query: 'artificial intelligence' } },
  { id: 'src-bloomberg', platform: 'bloomberg', config: { query: 'economics markets' } },
  { id: 'src-twitter', platform: 'twitter', config: { query: 'cryptocurrency trading' } },
];

const DEFAULT_INTERESTS: Array<{
  id: string;
  user: string;
  name: string;
  sources: string[];
  linkedTopic: string;
}> = [
  { id: 'admin-quant-finance', user: 'admin', name: '量化金融', sources: ['src-reddit', 'src-github', 'src-bloomberg'], linkedTopic: 'digist-quant' },
  { id: 'admin-crypto', user: 'admin', name: '加密货币', sources: ['src-reddit', 'src-twitter', 'src-hackernews'], linkedTopic: 'digist-crypto' },
  { id: 'admin-llm-algorithms', user: 'admin', name: 'LLM基础算法', sources: ['src-arxiv', 'src-github', 'src-hackernews'], linkedTopic: 'digist-ai-research' },
  { id: 'admin-agent', user: 'admin', name: 'Agent', sources: ['src-github', 'src-hackernews', 'src-reddit'], linkedTopic: 'digist-ai-app' },
  { id: 'admin-cv', user: 'admin', name: 'CV（机器视觉）', sources: ['src-arxiv', 'src-github'], linkedTopic: 'digist-ai-research' },
  { id: 'admin-major-finance-events', user: 'admin', name: '重大金融事件', sources: ['src-bloomberg', 'src-hackernews'], linkedTopic: 'digist-finance' },
  { id: 'user-biochemistry', user: 'useR', name: '生物化学', sources: ['src-arxiv', 'src-github'], linkedTopic: 'pharm-study' },
];

export interface IDigistInterest {
  id: string;
  user: string;
  name: string;
  sources: string[];
  schedule: string;
  linkedTopic: string | null;
  lastSync: string | null;
}

export interface IDigistSource {
  id: string;
  platform: string;
  config: Record<string, unknown>;
  enabled: boolean;
  lastCrawl: string | null;
  itemCount: number;
}

export interface IDigistStatus {
  available: boolean;
  openCliAvailable: boolean;
  chromeRunning: boolean;
  dbPath: string;
  totalItems: number;
  lastCrawlAt: string | null;
  schedulerRunning: boolean;
  totalInterests: number;
  totalSources: number;
  digistApiReachable: boolean;
  /** Human-readable note when list data is stubbed or degraded */
  note?: string;
}

function digistDbPath(): string {
  return process.env.DIGIST_DB_PATH || DEFAULT_DB_PATH;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 as x FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
  ).get(name) as { x: number } | undefined;
  return !!row;
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name));
}

function detectOpenCliSync(): boolean {
  try {
    const r = spawnSync('opencli', ['--version'], { encoding: 'utf-8', timeout: 5_000 });
    return r.status === 0 && !!r.stdout?.trim();
  } catch {
    return false;
  }
}

function detectChromeSync(): boolean {
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('pgrep', ['-x', 'Google Chrome'], { encoding: 'utf-8', timeout: 3_000 });
      return r.status === 0;
    }
    const r = spawnSync('pgrep', ['-f', 'chrome'], { encoding: 'utf-8', timeout: 3_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function fetchDigistHealth(): Promise<{
  orchestration?: {
    opencli?: { binaryReachable?: boolean; bridgeOk?: boolean };
    chrome?: { reachable?: boolean };
  };
} | null> {
  try {
    const res = await fetch(`${DIGIST_API_URL}/health`, { signal: AbortSignal.timeout(2_500) });
    if (!res.ok) return null;
    return (await res.json()) as {
      orchestration?: {
        opencli?: { binaryReachable?: boolean; bridgeOk?: boolean };
        chrome?: { reachable?: boolean };
      };
    };
  } catch {
    return null;
  }
}

function openDbReadonly(): Database.Database | null {
  const p = digistDbPath();
  if (!fs.existsSync(p)) return null;
  try {
    return new Database(p, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function openDbRw(): Database.Database | null {
  const p = digistDbPath();
  const dir = path.dirname(p);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  try {
    return new Database(p);
  } catch {
    return null;
  }
}

/** Sidecar schema (CROSS-PROJECT-INTEGRATION D3). Idempotent. */
function ensureInterestSourceSchema(db: Database.Database): void {
  if (!tableExists(db, 'interests')) {
    db.exec(`
      CREATE TABLE interests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'admin',
        name TEXT NOT NULL UNIQUE,
        schedule TEXT NOT NULL DEFAULT '${DEFAULT_INTEREST_SCHEDULE}',
        linked_topic TEXT,
        last_sync TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  if (!tableExists(db, 'sources')) {
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS interest_sources (
      interest_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (interest_id, source_id)
    );
  `);

  addColumnIfMissing(db, 'interests', 'user_id', "TEXT NOT NULL DEFAULT 'admin'");
  addColumnIfMissing(db, 'interests', 'name', 'TEXT');
  addColumnIfMissing(db, 'interests', 'schedule', `TEXT DEFAULT '${DEFAULT_INTEREST_SCHEDULE}'`);
  addColumnIfMissing(db, 'interests', 'linked_topic', 'TEXT');
  addColumnIfMissing(db, 'interests', 'last_sync', 'TEXT');
  addColumnIfMissing(db, 'interests', 'updated_at', 'TEXT');
  addColumnIfMissing(db, 'sources', 'platform', 'TEXT');
  addColumnIfMissing(db, 'sources', 'config', "TEXT DEFAULT '{}'");
  addColumnIfMissing(db, 'sources', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
}

function ensureDefaultInterestData(): void {
  const db = openDbRw();
  if (!db) return;
  try {
    ensureInterestSourceSchema(db);
    const sourceColumns = tableColumns(db, 'sources');
    for (const source of DEFAULT_SOURCES) {
      const columns = ['id'];
      const values: unknown[] = [source.id];
      const addValue = (column: string, value: unknown) => {
        if (sourceColumns.has(column)) {
          columns.push(column);
          values.push(value);
        }
      };
      addValue('name', source.platform);
      addValue('kind', source.platform);
      addValue('endpoint', typeof source.config.query === 'string' ? source.config.query : '');
      addValue('metadata', JSON.stringify(source.config));
      addValue('platform', source.platform);
      addValue('config', JSON.stringify(source.config));
      addValue('enabled', source.enabled === false ? 0 : 1);
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(`INSERT OR REPLACE INTO sources (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
    }

    const interestColumns = tableColumns(db, 'interests');
    const linkSource = db.prepare('INSERT OR IGNORE INTO interest_sources (interest_id, source_id) VALUES (?, ?)');
    for (const interest of DEFAULT_INTERESTS) {
      const columns = ['id'];
      const values: unknown[] = [interest.id];
      const addValue = (column: string, value: unknown) => {
        if (interestColumns.has(column)) {
          columns.push(column);
          values.push(value);
        }
      };
      addValue('label', interest.name);
      addValue('query', interest.name);
      addValue('platforms', JSON.stringify(['hackernews', 'arxiv', 'github', 'reddit']));
      addValue('enabled', 1);
      addValue('user_id', interest.user);
      addValue('name', interest.name);
      addValue('schedule', DEFAULT_INTEREST_SCHEDULE);
      addValue('linked_topic', interest.linkedTopic);
      addValue('auto_sync', 1);
      addValue('updated_at', new Date().toISOString());
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(`INSERT OR REPLACE INTO interests (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
      for (const sourceId of interest.sources) linkSource.run(interest.id, sourceId);
    }
  } finally {
    db.close();
  }
}

export async function getDigistStatus(): Promise<IDigistStatus> {
  const dbPath = digistDbPath();
  const healthJson = await fetchDigistHealth();
  const digistApiReachable = !!healthJson;

  let openCli =
    !!(healthJson?.orchestration?.opencli?.binaryReachable && healthJson?.orchestration?.opencli?.bridgeOk);
  let chrome = !!healthJson?.orchestration?.chrome?.reachable;
  if (!digistApiReachable) {
    openCli = detectOpenCliSync();
    chrome = detectChromeSync();
  }

  let totalItems = 0;
  let lastCrawlAt: string | null = null;
  let schedulerRunning = false;
  let available = fs.existsSync(dbPath);

  const db = openDbReadonly();
  if (db) {
    try {
      available = true;
      if (tableExists(db, 'content_items')) {
        const row = db.prepare('SELECT COUNT(*) AS c FROM content_items').get() as { c: number };
        totalItems = row.c;
        const m = db.prepare('SELECT MAX(scraped_at) AS m FROM content_items').get() as { m: string | null };
        lastCrawlAt = m.m;
      }
      if (tableExists(db, 'scrape_jobs')) {
        const en = db.prepare(
          'SELECT COUNT(*) AS c FROM scrape_jobs WHERE enabled = 1',
        ).get() as { c: number };
        schedulerRunning = en.c > 0;
        const lr = db.prepare('SELECT MAX(last_run_at) AS m FROM scrape_jobs').get() as { m: string | null };
        if (lr.m && (!lastCrawlAt || lr.m > lastCrawlAt)) lastCrawlAt = lr.m;
      }
    } finally {
      db.close();
    }
  }

  const interests = listInterests();
  const sources = listSources();
  let note: string | undefined;
  if (!tableExistsInPath(dbPath, 'interests')) {
    note = 'interests/sources tables absent — list endpoints return [] until first POST creates sidecar schema (see digist-monitor TODO).';
  }

  return {
    available,
    openCliAvailable: openCli,
    chromeRunning: chrome,
    dbPath,
    totalItems,
    lastCrawlAt,
    schedulerRunning,
    totalInterests: interests.length,
    totalSources: sources.length,
    digistApiReachable,
    ...(note ? { note } : {}),
  };
}

function tableExistsInPath(dbPath: string, name: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return tableExists(db, name);
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch { /* ignore */ }
  }
}

export function listInterests(): IDigistInterest[] {
  ensureDefaultInterestData();
  const db = openDbReadonly();
  if (!db) return [];
  try {
    if (!tableExists(db, 'interests')) return [];
    const cols = tableColumns(db, 'interests');
    const nameExpr = cols.has('label') ? 'COALESCE(i.name, i.label)' : 'i.name';
    const rows = db.prepare(`
      SELECT i.id, i.user_id AS user, ${nameExpr} AS name, i.schedule, i.linked_topic AS linkedTopic, i.last_sync AS lastSync,
             GROUP_CONCAT(isrc.source_id) AS sourceIds
      FROM interests i
      LEFT JOIN interest_sources isrc ON isrc.interest_id = i.id
      GROUP BY i.id
      ORDER BY i.user_id, i.name
    `).all() as Array<{
      id: string;
      user: string;
      name: string;
      schedule: string;
      linkedTopic: string | null;
      lastSync: string | null;
      sourceIds: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      user: r.user,
      name: r.name,
      sources: r.sourceIds ? r.sourceIds.split(',').filter(Boolean) : [],
      schedule: r.schedule,
      linkedTopic: r.linkedTopic,
      lastSync: r.lastSync,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function sourceItemCount(db: Database.Database, platform: string): number {
  if (!tableExists(db, 'content_items')) return 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM content_items WHERE platform = ?').get(platform) as {
      c: number;
    };
    return row.c;
  } catch {
    return 0;
  }
}

export function listSources(): IDigistSource[] {
  ensureDefaultInterestData();
  const db = openDbReadonly();
  if (!db) return [];
  try {
    if (!tableExists(db, 'sources')) return [];
    const cols = tableColumns(db, 'sources');
    const platformExpr = cols.has('kind') ? 'COALESCE(platform, kind, name)' : 'platform';
    const configExpr = cols.has('metadata') ? 'COALESCE(config, metadata)' : 'config';
    const rows = db.prepare(
      `SELECT id, ${platformExpr} AS platform, ${configExpr} AS config, enabled, created_at FROM sources ORDER BY platform, id`,
    ).all() as Array<{ id: string; platform: string | null; config: string | null; enabled: number; created_at: string }>;

    return rows.map((r) => {
      const platform = r.platform || 'custom';
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(r.config || '{}') as Record<string, unknown>;
      } catch { /* keep {} */ }
      let lastCrawl: string | null = null;
      try {
        if (tableExists(db, 'scrape_jobs')) {
          const j = db.prepare(
            'SELECT MAX(last_run_at) AS m FROM scrape_jobs WHERE platform = ?',
          ).get(platform) as { m: string | null };
          lastCrawl = j.m;
        }
      } catch { /* ignore */ }

      return {
        id: r.id,
        platform,
        config,
        enabled: !!r.enabled,
        lastCrawl,
        itemCount: sourceItemCount(db, platform),
      };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function createInterest(body: {
  user?: string;
  name: string;
  sources?: string[];
  schedule?: string;
  linkedTopic?: string | null;
}): { ok: true; interest: IDigistInterest } | { ok: false; message: string } {
  const v = validateTopicName(body.name);
  if (!v.ok) return { ok: false, message: v.reason || 'invalid name' };
  const db = openDbRw();
  if (!db) return { ok: false, message: 'digist database not available' };
  try {
    ensureInterestSourceSchema(db);
    const id = nanoid(12);
    const schedule = body.schedule ?? DEFAULT_INTEREST_SCHEDULE;
    const user = body.user?.trim() || 'admin';
    db.prepare(
      `INSERT INTO interests (id, user_id, name, schedule, linked_topic) VALUES (?,?,?,?,?)`,
    ).run(id, user, body.name, schedule, body.linkedTopic ?? null);
    const src = body.sources ?? [];
    const ins = db.prepare('INSERT OR IGNORE INTO interest_sources (interest_id, source_id) VALUES (?,?)');
    for (const sid of src) ins.run(id, sid);
    return { ok: true, interest: listInterests().find((i) => i.id === id)! };
  } catch (e) {
    return { ok: false, message: String(e) };
  } finally {
    db.close();
  }
}

export function updateInterest(
  id: string,
  body: Partial<{ name: string; sources: string[]; schedule: string; linkedTopic: string | null }>,
): { ok: true; interest: IDigistInterest } | { ok: false; message: string } {
  const db = openDbRw();
  if (!db) return { ok: false, message: 'digist database not available' };
  try {
    if (!tableExists(db, 'interests')) return { ok: false, message: 'interests table missing' };
    const row = db.prepare('SELECT id FROM interests WHERE id = ?').get(id);
    if (!row) return { ok: false, message: 'not found' };
    if (body.name != null) {
      const v = validateTopicName(body.name);
      if (!v.ok) return { ok: false, message: v.reason || 'invalid name' };
      db.prepare('UPDATE interests SET name = ?, updated_at = datetime(\'now\') WHERE id = ?').run(body.name, id);
    }
    if (body.schedule != null) {
      db.prepare('UPDATE interests SET schedule = ?, updated_at = datetime(\'now\') WHERE id = ?').run(body.schedule, id);
    }
    if (body.linkedTopic !== undefined) {
      db.prepare('UPDATE interests SET linked_topic = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
        body.linkedTopic,
        id,
      );
    }
    if (body.sources != null) {
      db.prepare('DELETE FROM interest_sources WHERE interest_id = ?').run(id);
      const ins = db.prepare('INSERT INTO interest_sources (interest_id, source_id) VALUES (?,?)');
      for (const sid of body.sources) ins.run(id, sid);
    }
    return { ok: true, interest: listInterests().find((i) => i.id === id)! };
  } catch (e) {
    return { ok: false, message: String(e) };
  } finally {
    db.close();
  }
}

export function deleteInterest(id: string): { ok: boolean; message?: string } {
  const db = openDbRw();
  if (!db) return { ok: false, message: 'digist database not available' };
  try {
    if (!tableExists(db, 'interests')) return { ok: false, message: 'interests table missing' };
    db.prepare('DELETE FROM interest_sources WHERE interest_id = ?').run(id);
    const r = db.prepare('DELETE FROM interests WHERE id = ?').run(id);
    return { ok: r.changes > 0 };
  } catch (e) {
    return { ok: false, message: String(e) };
  } finally {
    db.close();
  }
}

export function addSource(body: {
  platform: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}): { ok: true; source: IDigistSource } | { ok: false; message: string } {
  if (!body.platform?.trim()) return { ok: false, message: 'platform required' };
  const db = openDbRw();
  if (!db) return { ok: false, message: 'digist database not available' };
  try {
    ensureInterestSourceSchema(db);
    const id = nanoid(12);
    const cfg = JSON.stringify(body.config ?? {});
    db.prepare(
      'INSERT INTO sources (id, platform, config, enabled) VALUES (?,?,?,?)',
    ).run(id, body.platform.trim(), cfg, body.enabled === false ? 0 : 1);
    return { ok: true, source: listSources().find((s) => s.id === id)! };
  } catch (e) {
    return { ok: false, message: String(e) };
  } finally {
    db.close();
  }
}

export function removeSource(id: string): { ok: boolean; message?: string } {
  const db = openDbRw();
  if (!db) return { ok: false, message: 'digist database not available' };
  try {
    if (!tableExists(db, 'sources')) return { ok: false, message: 'sources table missing' };
    db.prepare('DELETE FROM interest_sources WHERE source_id = ?').run(id);
    const r = db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    return { ok: r.changes > 0 };
  } catch (e) {
    return { ok: false, message: String(e) };
  } finally {
    db.close();
  }
}

async function resolveCrawlFromInterest(interestId: string): Promise<
  | { ok: true; platform: string; query: string }
  | { ok: false; message: string }
> {
  const db = openDbReadonly();
  if (!db) return { ok: false, message: 'database unavailable' };
  try {
    if (!tableExists(db, 'interests') || !tableExists(db, 'sources')) {
      return { ok: false, message: 'interests/sources schema not initialized' };
    }
    const sid = db.prepare('SELECT source_id FROM interest_sources WHERE interest_id = ? LIMIT 1').get(
      interestId,
    ) as { source_id: string } | undefined;
    if (!sid) return { ok: false, message: 'interest has no sources' };
    const src = db.prepare('SELECT platform, config FROM sources WHERE id = ?').get(sid.source_id) as
      | { platform: string; config: string }
      | undefined;
    if (!src) return { ok: false, message: 'source not found' };
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(src.config) as Record<string, unknown>;
    } catch { /* */ }
    const query = (cfg.query as string) || (cfg.username as string) || (cfg.url as string) || '';
    if (!query && !['glass', 'hackernews', 'bloomberg'].includes(src.platform)) {
      return { ok: false, message: 'source config missing query/username/url' };
    }
    return { ok: true, platform: src.platform, query: typeof query === 'string' ? query : String(query) };
  } finally {
    db.close();
  }
}

export async function triggerCrawl(body: {
  interestId?: string;
  platform?: string;
  query?: string;
}): Promise<{ ok: boolean; message?: string; result?: unknown }> {
  let platform = body.platform;
  let query = body.query ?? '';
  if (body.interestId && (!platform || query === '')) {
    const r = await resolveCrawlFromInterest(body.interestId);
    if (!r.ok) return { ok: false, message: r.message };
    platform = r.platform;
    query = r.query;
  }
  if (!platform) return { ok: false, message: 'platform required (or interestId with resolvable source)' };

  try {
    const res = await fetch(`${DIGIST_API_URL}/api/crawl/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, query }),
      signal: AbortSignal.timeout(120_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: (json as { message?: string }).message || JSON.stringify(json) };
    }
    return { ok: true, result: json };
  } catch (e) {
    return { ok: false, message: `DiGist API unreachable (${DIGIST_API_URL}): ${String(e)}` };
  }
}

export function getCrawlHistory(limit = 50): Array<{
  id: string;
  type: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}> {
  const db = openDbReadonly();
  if (!db) return [];
  try {
    if (!tableExists(db, 'tasks')) return [];
    const lim = Math.min(500, Math.max(1, limit));
    return db.prepare(`
      SELECT id, type, status, created_at, completed_at, error
      FROM tasks ORDER BY datetime(created_at) DESC LIMIT ?
    `).all(lim) as Array<{
      id: string;
      type: string;
      status: string;
      created_at: string;
      completed_at: string | null;
      error: string | null;
    }>;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function syncToKnowLever(body: {
  interestId?: string;
  topicName?: string;
  user?: string;
}): Promise<{ ok: boolean; message?: string; stdout?: string }> {
  let topic = body.topicName ?? null;
  const user = body.user ?? 'admin';
  if (!topic && body.interestId) {
    const db = openDbReadonly();
    if (db) {
      try {
        if (tableExists(db, 'interests')) {
          const row = db.prepare('SELECT linked_topic FROM interests WHERE id = ?').get(body.interestId) as
            | { linked_topic: string | null }
            | undefined;
          topic = row?.linked_topic ?? null;
        }
      } finally {
        db.close();
      }
    }
  }
  if (!topic) return { ok: false, message: 'topicName or interestId with linked_topic required' };
  const tv = validateTopicName(topic);
  if (!tv.ok) return { ok: false, message: tv.reason || 'invalid topic' };

  const script = path.join(KNOWLEVER_ROOT, 'scripts', 'digest-sync.js');
  if (!fs.existsSync(script)) {
    return { ok: false, message: 'KnowLever scripts/digest-sync.js not found' };
  }

  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [script, '--topic', topic, '--user', user, '--db', digistDbPath()],
      { cwd: KNOWLEVER_ROOT, timeout: 600_000, maxBuffer: 20 * 1024 * 1024 },
    );
    const out = [stdout, stderr].filter(Boolean).join('\n');
    return { ok: true, stdout: out.slice(0, 8000) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      message: err.message || String(e),
      stdout: [err.stdout, err.stderr].filter(Boolean).join('\n').slice(0, 4000),
    };
  }
}
