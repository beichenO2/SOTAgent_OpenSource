/**
 * ssot-audit-aggregator.ts — SSoT 定时审计结果聚合器
 *
 * 使用 fs.watch 监听 outbox 目录，当审计脚本输出新文件时：
 * 1. 解析 JSON 审计结果
 * 2. 分类问题严重度（clean/minor/major/critical）
 * 3. 生成 Inbox 标记或 Hub 告警
 * 4. 非工作时间（23:00-07:00）只记录日志，不生成标记
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeInboxFlag } from './inbox-flag.js';

const SOTAGENT_DIR = path.join(process.env.HOME ?? os.homedir(), 'Polarisor', 'SOTAgent');
const OUTBOX_DIR = path.join(SOTAGENT_DIR, '.sotagent-outbox', 'ssot-audit');
const LOG_FILE = path.join(process.env.HOME ?? os.homedir(), '.sotagent', 'logs', 'ssot-audit-aggregator.jsonl');

let watcher: fs.FSWatcher | null = null;
const processedFiles = new Set<string>();

// ─── 公开 API ──────────────────────────────────────────────

export function startAuditAggregator(): void {
  if (watcher) {
    console.log('[ssot-audit-aggregator] 已在运行中，跳过重复启动');
    return;
  }

  // 确保 outbox 目录存在
  try {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  } catch {
    // 可能已存在
  }

  // 启动时扫描已有文件
  scanExistingFiles();

  // 设置文件监听
  watcher = fs.watch(OUTBOX_DIR, { persistent: true }, (eventType, filename) => {
    if (eventType === 'rename' && filename) {
      handleNewFile(filename);
    }
  });

  console.log('[ssot-audit-aggregator] started — 监听 outbox 目录:', OUTBOX_DIR);
}

export function stopAuditAggregator(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
    console.log('[ssot-audit-aggregator] stopped');
  }
}

// ─── 内部实现 ──────────────────────────────────────────────

function scanExistingFiles(): void {
  try {
    const files = fs.readdirSync(OUTBOX_DIR);
    for (const f of files) {
      if (f.endsWith('.json')) {
        const fullPath = path.join(OUTBOX_DIR, f);
        processAuditFile(fullPath);
      }
    }
  } catch {
    // 目录不存在或无法读取
  }
}

function handleNewFile(filename: string): void {
  const fullPath = path.join(OUTBOX_DIR, filename);
  const stat = fs.statSync(fullPath);
  if (stat.isFile() && filename.endsWith('.json')) {
    // 延迟一点让文件写完
    setTimeout(() => processAuditFile(fullPath), 500);
  }
}

function processAuditFile(filePath: string): void {
  if (processedFiles.has(filePath)) return;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    // 根据文件名判断是 audit 还是 drift 结果
    const basename = path.basename(filePath);
    if (basename.startsWith('audit-')) {
      processAuditResult(data, filePath);
    } else if (basename.startsWith('drift-')) {
      processDriftResult(data, filePath);
    }

    processedFiles.add(filePath);
  } catch (e) {
    console.error('[ssot-audit-aggregator] 处理审计文件失败:', e);
    logToFile('error', { file: filePath, error: String(e) });
  }
}

function processAuditResult(data: any, filePath: string): void {
  if (!isWorkHours()) {
    logToFile('skipped_non_work_hours', { file: filePath, data });
    return;
  }

  const findings = data.findings ?? [];
  const projects = data.projects ?? [];

  // 按项目聚合问题
  const projectFindings = new Map<string, Array<{ severity: string; type: string; target: string; count?: number }>>();
  for (const finding of findings) {
    // 从 target 路径推断项目名称
    const project = extractProjectName(finding.target);
    if (project) {
      const arr = projectFindings.get(project) ?? [];
      arr.push(finding);
      projectFindings.set(project, arr);
    }
  }

  if (findings.length === 0 && projects.every((p: any) => !p.missingEvidence && !p.weakBehavior && !p.missingContacts)) {
    // 零问题 → clean
    logToFile('clean', { file: filePath, timestamp: data.generatedAt });
    return;
  }

  // 对每个项目分类并生成标记
  for (const [project, pFindings] of projectFindings) {
    const severity = classifySeverity(pFindings);
    if (severity === 'clean') continue;

    generateInboxFlag(severity, project, pFindings, filePath);
    logToFile(severity, { project, findings: pFindings.length, file: filePath });
  }
}

function processDriftResult(data: any, filePath: string): void {
  if (!isWorkHours()) {
    logToFile('skipped_non_work_hours', { file: filePath });
    return;
  }

  const summary = data.summary ?? {};
  const totalIssues = (summary.missing ?? 0) + (summary.extra ?? 0) + (summary.evidence ?? 0) + (summary.interfaces ?? 0);

  if (totalIssues === 0) {
    logToFile('clean', { file: filePath, type: 'drift' });
    return;
  }

  const driftFindings: Array<{ severity: string; type: string; detail: string }> = [];

  if (summary.missing > 0 || summary.extra > 0) {
    driftFindings.push({
      severity: summary.missing > 2 || summary.extra > 2 ? 'major' : 'minor',
      type: 'ssot_drift',
      detail: `${summary.missing} 个未列出, ${summary.extra} 个多余`,
    });
  }

  if (summary.evidence > 0) {
    driftFindings.push({
      severity: summary.evidence > 3 ? 'major' : 'minor',
      type: 'evidence_missing',
      detail: `${summary.evidence} 个证据缺失或无效`,
    });
  }

  if (summary.interfaces > 0) {
    driftFindings.push({
      severity: summary.interfaces > 3 ? 'critical' : 'major',
      type: 'interface_drift',
      detail: `${summary.interfaces} 个接口在代码中找不到`,
    });
  }

  // 按最严重级别生成标记
  const worstSeverity = classifySeverity(driftFindings);
  generateInboxFlag(worstSeverity, 'ssot-drift', driftFindings, filePath);
  logToFile(worstSeverity, { file: filePath, type: 'drift', issues: totalIssues });
}

// ─── 严重度分类 ────────────────────────────────────────────

export type Severity = 'clean' | 'minor' | 'major' | 'critical';

export function classifySeverity(findings: Array<{ severity?: string; type?: string }>): Severity {
  if (!findings || findings.length === 0) return 'clean';

  let hasCritical = false;
  let hasMajor = false;

  for (const f of findings) {
    const s = (f.severity ?? '').toLowerCase();
    const t = (f.type ?? '').toLowerCase();

    // critical: 证据 commit 不存在 / 接口代码中找不到
    if (s === 'high' && (t.includes('interface') || t.includes('evidence'))) {
      hasCritical = true;
    } else if (s === 'critical') {
      hasCritical = true;
    }

    // major: status=done 但 test_status≠passed, 或大量证据缺失
    if (s === 'high' && !t.includes('interface')) {
      hasMajor = true;
    } else if (s === 'major') {
      hasMajor = true;
    }

    // minor: 格式问题/缺失字段
    if (s === 'medium' || t.includes('weak_behavior') || t.includes('missing_contacts')) {
      if (!hasMajor && !hasCritical) {
        // 继续检查是否有更高级别
      }
    }
  }

  if (hasCritical) return 'critical';
  if (hasMajor) return 'major';
  if (findings.length > 0) return 'minor';
  return 'clean';
}

// ─── Inbox 标记生成 ────────────────────────────────────────

function generateInboxFlag(severity: Severity, project: string, findings: any[], auditFile: string): void {
  if (severity === 'clean') return;

  const flagContent = {
    severity,
    project,
    findings,
    timestamp: new Date().toISOString(),
    audit_file: auditFile,
  };

  // 写入 inbox flag（复用现有 writeInboxFlag 函数）
  const reasonMap: Record<Severity, string> = {
    clean: 'inbox_processed',
    minor: 'sync_suggestion',
    major: 'peer_notification',
    critical: 'peer_notification',
  };

  writeInboxFlag(reasonMap[severity] as any, {
    project,
    detail: `SSoT 审计发现 ${severity} 级别问题 (${findings.length} 项)`,
  });

  // 同时写入详细 flag 文件到 inbox 目录
  const inboxDir = path.join(process.env.HOME ?? os.homedir(), '.sotagent', 'inbox');
  try {
    fs.mkdirSync(inboxDir, { recursive: true });
  } catch { /* ignore */ }

  const flagPath = path.join(inboxDir, `ssot-${severity}-${project.toLowerCase().replace(/[^a-z0-9]/g, '-')}.flag`);
  try {
    fs.writeFileSync(flagPath, JSON.stringify(flagContent, null, 2));
  } catch {
    // 非关键错误
  }

  console.log(`[ssot-audit-aggregator] 生成 Inbox 标记: ${severity} - ${project} → ${flagPath}`);
}

// ─── 自动更新时间戳 ────────────────────────────────────────

export function updateLastVerifiedAt(projectDir: string, timestamp: string): void {
  const polarisPath = path.join(projectDir, 'polaris.json');
  try {
    if (!fs.existsSync(polarisPath)) return;
    const data = JSON.parse(fs.readFileSync(polarisPath, 'utf-8'));
    if (data.contacts) {
      data.contacts.last_verified_at = timestamp;
      fs.writeFileSync(polarisPath, JSON.stringify(data, null, 2));
    }
  } catch {
    // 不修改语义字段，仅记录日志
    console.error('[ssot-audit-aggregator] 更新 last_verified_at 失败:', polarisPath);
  }
}

// ─── 工作时间检查 ──────────────────────────────────────────

export function isWorkHours(): boolean {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 23;
}

// ─── 辅助函数 ──────────────────────────────────────────────

function extractProjectName(targetPath: string): string | null {
  // 从形如 "Clock/polaris.json" 或 "SOTAgent/polaris.json" 的路径中提取项目名
  const parts = targetPath.split('/');
  if (parts.length > 0 && parts[0] && parts[0].includes('Polarisor')) {
    const polarisorIdx = parts.findIndex(p => p === 'Polarisor');
    if (polarisorIdx >= 0 && parts.length > polarisorIdx + 1) {
      return parts[polarisorIdx + 1] ?? null;
    }
  }
  if (parts.length > 0 && parts[0] && parts[0].includes('polaris.json')) {
    return null;
  }
  // 直接返回第一层目录名
  if (parts.length > 0 && /^[A-Za-z]/.test(parts[0] ?? '')) {
    return parts[0] ?? null;
  }
  return null;
}

function logToFile(level: string, data: any): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    ...data,
  };
  try {
    const dir = path.dirname(LOG_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // 日志写入失败不影响主流程
  }
}
