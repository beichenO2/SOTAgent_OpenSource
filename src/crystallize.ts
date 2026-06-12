/**
 * crystallize.ts — 项目经验结晶化机制
 *
 * 从成功的项目实践中提取可复用模式（pattern），生成结晶文件（crystal-*.md），
 * 注册为技术资产，在新项目创建时自动匹配推荐。
 *
 * 支持两种模式：
 * 1. LLM 辅助：分析代码结构并由 LLM 提炼设计决策 + 语义关键词
 * 2. 纯启发式：不依赖 LLM，通过文件结构和配置文件推断模式
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SOTAgentDB } from './db.js';
import { chatCompletion } from './llm.js';

// ─── 类型定义 ─────────────────────────────────────────

export interface ICrystalMeta {
  id: string;
  type: 'pattern';
  version: number;
  source_project: string;
  match_criteria: {
    keywords: string[];
    project_type: string[];
    tags: string[];
  };
}

export interface ICrystalResult {
  crystalId: string;
  filePath: string;
  assetRegistered: boolean;
  matchCriteria: ICrystalMeta['match_criteria'];
}

export interface IMatchResult {
  crystalId: string;
  score: number;
  reasons: string[];
  filePath: string;
}

interface ILLMCrystalOutput {
  keywords: string[];
  content: string;
}

interface IProjectSnapshot {
  name: string;
  packageJson: Record<string, unknown> | null;
  fileTree: string[];
  configFiles: string[];
  hasVue: boolean;
  hasReact: boolean;
  hasHono: boolean;
  hasTailwind: boolean;
  readmeSnippet: string;
  srcStructure: string[];
}

// ─── 核心实现 ─────────────────────────────────────────

const CRYSTALS_DIR = 'knowledge/crystals';

function ensureCrystalsDir(baseDir: string): string {
  const dir = path.join(baseDir, CRYSTALS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '');
}

function scanProjectStructure(projectPath: string): IProjectSnapshot {
  const name = path.basename(projectPath);
  const fileTree: string[] = [];
  const configFiles: string[] = [];
  const srcStructure: string[] = [];

  function walk(dir: string, prefix: string, depth: number) {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          fileTree.push(`${rel}/`);
          walk(path.join(dir, entry.name), rel, depth + 1);
        } else {
          fileTree.push(rel);
          if (/\.(config|rc)\.(ts|js|json|ya?ml|mjs|cjs)$/.test(entry.name) || entry.name.endsWith('.json')) {
            configFiles.push(rel);
          }
        }
      }
    } catch { /* permission denied etc */ }
  }
  walk(projectPath, '', 0);

  const srcDir = path.join(projectPath, 'src');
  if (fs.existsSync(srcDir)) {
    function walkSrc(dir: string, prefix: string, depth: number) {
      if (depth > 2) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            srcStructure.push(`${rel}/`);
            walkSrc(path.join(dir, entry.name), rel, depth + 1);
          }
        }
      } catch { /* */ }
    }
    walkSrc(srcDir, '', 0);
  }

  let packageJson: Record<string, unknown> | null = null;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
  } catch { /* */ }

  let readmeSnippet = '';
  for (const f of ['README.md', 'readme.md', 'README.MD']) {
    const p = path.join(projectPath, f);
    if (fs.existsSync(p)) {
      readmeSnippet = fs.readFileSync(p, 'utf-8').slice(0, 1000);
      break;
    }
  }

  const deps = { ...(packageJson?.dependencies as Record<string, string> ?? {}), ...(packageJson?.devDependencies as Record<string, string> ?? {}) };

  return {
    name,
    packageJson,
    fileTree,
    configFiles,
    hasVue: 'vue' in deps,
    hasReact: 'react' in deps,
    hasHono: 'hono' in deps,
    hasTailwind: Object.keys(deps).some(k => k.includes('tailwind')),
    readmeSnippet,
    srcStructure,
  };
}

function inferProjectType(snap: IProjectSnapshot): string[] {
  const types: string[] = [];
  if (snap.hasVue || snap.hasReact) types.push('web-app');
  if (snap.hasHono) types.push('api-server');
  if (snap.fileTree.some(f => f.includes('cli') || f.includes('bin/'))) types.push('cli-tool');
  if (snap.fileTree.some(f => f.includes('.github/workflows/'))) types.push('ci-enabled');
  if (snap.packageJson?.scripts && typeof snap.packageJson.scripts === 'object' &&
      'start' in snap.packageJson.scripts) types.push('daemon');
  if (types.length === 0) types.push('library');
  return types;
}

const EN_STOP_WORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'into', 'through', 'about',
  'which', 'when', 'where', 'what', 'have', 'been', 'will', 'would',
  'could', 'should', 'does', 'each', 'every', 'both', 'more', 'most',
  'other', 'some', 'such', 'than', 'very', 'also', 'just', 'over',
  'after', 'before', 'between', 'under', 'using', 'based', 'part',
  'features', 'without', 'only', 'then', 'here', 'there', 'your',
  'their', 'them', 'these', 'those', 'being', 'same', 'well', 'many',
]);

function extractEnglishTerms(text: string): string[] {
  const words = text.match(/[a-zA-Z][-a-zA-Z]{2,}/g) || [];
  return words
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && !EN_STOP_WORDS.has(w));
}

function extractChineseTerms(text: string): string[] {
  const terms: string[] = [];
  const segments = text
    .replace(/[^\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(s => s.length >= 2);
  for (const seg of segments) {
    if (seg.length >= 2 && seg.length <= 6) {
      terms.push(seg);
    }
  }
  return terms;
}

function inferKeywords(snap: IProjectSnapshot): string[] {
  const kw = new Set<string>();

  kw.add(snap.name.toLowerCase());

  if (snap.packageJson?.name && typeof snap.packageJson.name === 'string') {
    for (const part of snap.packageJson.name.split(/[-_/]/)) {
      if (part.length >= 2) kw.add(part.toLowerCase());
    }
  }

  if (snap.packageJson?.description && typeof snap.packageJson.description === 'string') {
    const desc = snap.packageJson.description;
    for (const t of extractEnglishTerms(desc)) kw.add(t);
    for (const t of extractChineseTerms(desc)) kw.add(t);
  }

  if (snap.readmeSnippet) {
    const firstLine = snap.readmeSnippet.split('\n').find(l => l.replace(/^#+\s*/, '').trim().length > 0) || '';
    const tagline = snap.readmeSnippet.split('\n').slice(0, 5).join(' ');
    for (const t of extractEnglishTerms(firstLine + ' ' + tagline)) kw.add(t);
    for (const t of extractChineseTerms(firstLine + ' ' + tagline)) kw.add(t);
  }

  for (const dir of snap.srcStructure.slice(0, 15)) {
    const name = dir.replace(/\/$/, '');
    if (name.length >= 3 && !['src', 'lib', 'utils', 'types', 'common'].includes(name)) {
      kw.add(name.toLowerCase());
    }
  }

  const deps = {
    ...(snap.packageJson?.dependencies as Record<string, string> ?? {}),
    ...(snap.packageJson?.devDependencies as Record<string, string> ?? {}),
  };
  const sigDeps = Object.keys(deps)
    .filter(k => !k.startsWith('@types/') && !['typescript', 'vitest', 'prettier', 'eslint'].includes(k))
    .slice(0, 5);
  for (const d of sigDeps) {
    const short = d.replace(/^@[^/]+\//, '');
    if (short.length >= 3) kw.add(short.toLowerCase());
  }

  kw.delete('');
  return Array.from(kw).slice(0, 20);
}

function inferTags(snap: IProjectSnapshot): string[] {
  const tags: string[] = [];
  if (snap.hasVue) tags.push('vue');
  if (snap.hasReact) tags.push('react');
  if (snap.hasHono) tags.push('hono');
  if (snap.hasTailwind) tags.push('tailwind');
  if (snap.fileTree.some(f => f.includes('test') || f.includes('spec'))) tags.push('tested');
  if (snap.fileTree.some(f => f.includes('Dockerfile'))) tags.push('docker');
  if (snap.configFiles.some(f => f.includes('vitest') || f.includes('jest'))) tags.push('unit-tests');
  return tags;
}

function generateHeuristicCrystal(snap: IProjectSnapshot, description: string): string {
  const projectTypes = inferProjectType(snap);
  const keywords = inferKeywords(snap);
  const tags = inferTags(snap);

  const sections: string[] = [];
  sections.push(`# ${snap.name} 项目模式结晶`);
  sections.push('');
  sections.push('## 适用场景');
  sections.push(description || `适用于与 ${snap.name} 类似的 ${projectTypes.join('/')} 项目。`);
  sections.push('');

  if (snap.srcStructure.length > 0) {
    sections.push('## 目录结构');
    sections.push('```');
    sections.push('src/');
    for (const s of snap.srcStructure.slice(0, 20)) {
      sections.push(`  ${s}`);
    }
    sections.push('```');
    sections.push('');
  }

  if (snap.configFiles.length > 0) {
    sections.push('## 关键配置文件');
    for (const f of snap.configFiles.slice(0, 10)) {
      sections.push(`- \`${f}\``);
    }
    sections.push('');
  }

  const deps = snap.packageJson?.dependencies as Record<string, string> | undefined;
  if (deps) {
    sections.push('## 核心依赖');
    const important = Object.entries(deps).filter(([k]) => !k.startsWith('@types/')).slice(0, 15);
    for (const [k, v] of important) {
      sections.push(`- \`${k}\`: ${v}`);
    }
    sections.push('');
  }

  sections.push('## 设计决策');
  sections.push('（由结晶化提取，请补充具体决策和原因）');
  sections.push('');

  return sections.join('\n');
}

async function generateLLMCrystal(snap: IProjectSnapshot, description: string): Promise<ILLMCrystalOutput> {
  const depsList = Object.keys(snap.packageJson?.dependencies as Record<string, string> ?? {}).join(', ');
  const prompt = `分析以下项目结构，提取可复用的设计模式。返回严格 JSON。

项目: ${snap.name}
描述: ${description || (snap.packageJson?.description || '无')}
项目类型: ${inferProjectType(snap).join(', ')}
技术栈依赖: ${depsList || '无'}
技术标签: ${inferTags(snap).join(', ')}

src/ 目录结构:
${snap.srcStructure.slice(0, 30).join('\n') || '（无 src 目录）'}

顶层文件:
${snap.fileTree.filter(f => !f.includes('/')).slice(0, 20).join('\n')}

README 前 500 字:
${snap.readmeSnippet.slice(0, 500) || '（无 README）'}

返回 JSON 格式（不要 markdown code fence）：
{
  "keywords": ["关键词1", "关键词2", ...],
  "content": "Markdown 正文"
}

keywords 要求（极其重要）：
- 8-15 个词，每个 2-4 字（中文）或 1-2 个英文单词
- 必须是具体的、能区分此项目和其他项目的词
- 包含：核心功能（如"文档转换"）、架构模式（如"Hub-Worker"）、领域（如"知识管理"）
- 禁止泛化词如"系统"、"工具"、"模块"、"功能"、"based"、"using"
- 禁止从 README 原文截取整句

content 是 Markdown 正文（不含 frontmatter），包含：
1. ## 适用场景 — 什么类型的新项目应参考此模式（2-3 行，要具体到业务场景）
2. ## 设计决策 — 此项目为什么这样设计，核心权衡是什么（3-5 行）
3. ## 目录结构模板 — 代码结构 + 用途注释（代码块）
4. ## 核心代码模式 — 此项目独特的设计模式（不要只列通用模式名，要描述具体怎么用的）
5. ## 配置建议 — 推荐的配置项

每节简洁，避免泛泛而谈。用中文。`;

  try {
    const raw = await chatCompletion([
      { role: 'system', content: '你是架构师，擅长提炼项目模式。只输出纯 JSON，不要 markdown fence。' },
      { role: 'user', content: prompt },
    ]);

    const jsonStr = raw.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(jsonStr) as { keywords?: string[]; content?: string };

    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter((k): k is string => typeof k === 'string' && k.length >= 2).slice(0, 20)
      : [];
    const content = typeof parsed.content === 'string' ? parsed.content : '';

    if (!content || content.length < 50) {
      throw new Error('LLM 返回的 content 过短或为空');
    }

    return {
      keywords,
      content: `# ${snap.name} 项目模式结晶\n\n${content}`,
    };
  } catch (e) {
    console.warn('[crystallize] LLM 调用/解析失败，回退到启发式模式:', e);
    return {
      keywords: [],
      content: generateHeuristicCrystal(snap, description),
    };
  }
}

function cleanDuplicateCrystals(crystalsDir: string, sourceProject: string, canonicalFileName: string): void {
  try {
    const files = fs.readdirSync(crystalsDir).filter(f => f.startsWith('crystal-') && f.endsWith('.md'));
    for (const file of files) {
      if (file === canonicalFileName) continue;
      const content = fs.readFileSync(path.join(crystalsDir, file), 'utf-8').slice(0, 500);
      const spMatch = content.match(/source_project:\s*"([^"]+)"/);
      if (spMatch && spMatch[1] === sourceProject) {
        const oldPath = path.join(crystalsDir, file);
        console.log(`[crystallize] 清理重复结晶: ${file} (同一 source_project: ${sourceProject})`);
        fs.unlinkSync(oldPath);
      }
    }
  } catch { /* best effort */ }
}

// ─── 公开 API ─────────────────────────────────────────

export async function crystallize(
  db: SOTAgentDB,
  projectPath: string,
  options: {
    name?: string;
    description?: string;
    useLLM?: boolean;
    force?: boolean;
    sotAgentRoot?: string;
  } = {},
): Promise<ICrystalResult> {
  const snap = scanProjectStructure(projectPath);
  const crystalName = options.name || snap.name;
  const description = options.description || '';
  const sotAgentRoot = options.sotAgentRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  const crystalsDir = ensureCrystalsDir(sotAgentRoot);
  const fileName = `crystal-${slugify(crystalName)}.md`;
  const filePath = path.join(crystalsDir, fileName);

  cleanDuplicateCrystals(crystalsDir, snap.name, fileName);

  if (!options.force && fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    const fm = existing.match(/^---\n([\s\S]*?)\n---/);
    const existingVersion = fm?.[1]?.match(/version:\s*(\d+)/)?.[1];
    console.log(`[crystallize] ${crystalName} 已存在 (v${existingVersion || '?'})，跳过（用 force=true 强制重新结晶）`);
  }

  let content: string;
  let llmKeywords: string[] = [];

  if (options.useLLM !== false) {
    const llmResult = await generateLLMCrystal(snap, description);
    content = llmResult.content;
    llmKeywords = llmResult.keywords;
  } else {
    content = generateHeuristicCrystal(snap, description);
  }

  const heuristicKeywords = inferKeywords(snap);
  const mergedKeywords = mergeKeywords(llmKeywords, heuristicKeywords);

  const matchCriteria: ICrystalMeta['match_criteria'] = {
    keywords: mergedKeywords,
    project_type: inferProjectType(snap),
    tags: inferTags(snap),
  };

  const existingFm = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8').match(/version:\s*(\d+)/)
    : null;
  const version = existingFm?.[1] ? parseInt(existingFm[1], 10) + 1 : 1;

  const frontmatter = [
    '---',
    `id: "pattern:${slugify(crystalName)}"`,
    'type: pattern',
    `version: ${version}`,
    `source_project: "${snap.name}"`,
    `crystallized_at: "${new Date().toISOString().slice(0, 10)}"`,
    'match_criteria:',
    `  keywords: [${matchCriteria.keywords.map(k => `"${k}"`).join(', ')}]`,
    `  project_type: [${matchCriteria.project_type.map(t => `"${t}"`).join(', ')}]`,
    `  tags: [${matchCriteria.tags.map(t => `"${t}"`).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  const fullContent = frontmatter + content;
  fs.writeFileSync(filePath, fullContent, 'utf-8');

  const contentHash = crypto.createHash('sha256').update(fullContent).digest('hex').slice(0, 16);
  const assetId = `pattern:${slugify(crystalName)}`;
  db.registerAsset({
    id: assetId,
    type: 'pattern',
    canonical_path: filePath,
    content_hash: contentHash,
    updated_by: snap.name,
  });

  console.log(`[crystallize] 结晶完成 (v${version}): ${assetId} → ${filePath}`);

  return {
    crystalId: assetId,
    filePath,
    assetRegistered: true,
    matchCriteria,
  };
}

function mergeKeywords(llmKw: string[], heuristicKw: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const k of llmKw) {
    const norm = k.toLowerCase().trim();
    if (norm.length >= 2 && !seen.has(norm)) {
      seen.add(norm);
      result.push(norm);
    }
  }
  for (const k of heuristicKw) {
    const norm = k.toLowerCase().trim();
    if (norm.length >= 2 && !seen.has(norm)) {
      seen.add(norm);
      result.push(norm);
    }
  }
  return result.slice(0, 20);
}

export function matchCrystals(
  sotAgentRoot: string,
  projectKeywords: string[],
  projectType: string[],
  projectTags: string[],
): IMatchResult[] {
  const crystalsDir = path.join(sotAgentRoot, CRYSTALS_DIR);
  if (!fs.existsSync(crystalsDir)) return [];

  const results: IMatchResult[] = [];
  const files = fs.readdirSync(crystalsDir).filter(f => f.startsWith('crystal-') && f.endsWith('.md'));

  for (const file of files) {
    const filePath = path.join(crystalsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) continue;

    const fm = frontmatterMatch[1]!;
    const idMatch = fm.match(/id:\s*"([^"]+)"/);
    if (!idMatch?.[1]) continue;

    const crystalId = idMatch[1]!;

    const kwMatch = fm.match(/keywords:\s*\[(.*?)\]/);
    const typeMatch = fm.match(/project_type:\s*\[(.*?)\]/);
    const tagMatch = fm.match(/tags:\s*\[(.*?)\]/);

    const crystalKw = kwMatch?.[1] ? kwMatch[1].replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean) : [];
    const crystalTypes = typeMatch?.[1] ? typeMatch[1].replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean) : [];
    const crystalTags = tagMatch?.[1] ? tagMatch[1].replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean) : [];

    const reasons: string[] = [];
    const hasKw = projectKeywords.length > 0;
    const hasType = projectType.length > 0;
    const hasTags = projectTags.length > 0;
    if (!hasKw && !hasType && !hasTags) continue;

    // Dynamic weight allocation: unused dimensions redistribute to active ones
    const dimCount = (hasKw ? 1 : 0) + (hasType ? 1 : 0) + (hasTags ? 1 : 0);
    const baseWeights = { kw: 60, type: 25, tag: 15 };
    let unusedWeight = 0;
    if (!hasKw) unusedWeight += baseWeights.kw;
    if (!hasType) unusedWeight += baseWeights.type;
    if (!hasTags) unusedWeight += baseWeights.tag;
    const redistribution = dimCount > 0 ? unusedWeight / dimCount : 0;
    const wKw = hasKw ? baseWeights.kw + redistribution : 0;
    const wType = hasType ? baseWeights.type + redistribution : 0;
    const wTag = hasTags ? baseWeights.tag + redistribution : 0;

    let rawScore = 0;

    if (hasKw) {
      const exactKw: string[] = [];
      const fuzzyKw: string[] = [];
      for (const queryKw of projectKeywords) {
        const q = queryKw.toLowerCase();
        if (crystalKw.includes(q)) {
          exactKw.push(queryKw);
        } else if (crystalKw.some(ck => ck.includes(q) || q.includes(ck))) {
          fuzzyKw.push(queryKw);
        }
      }
      const kwCoverage = (exactKw.length + fuzzyKw.length * 0.85) / projectKeywords.length;
      rawScore += kwCoverage * wKw;
      const totalMatched = exactKw.length + fuzzyKw.length;
      if (totalMatched >= 3) rawScore += 10;
      if (exactKw.length > 0) reasons.push(`关键词匹配: ${exactKw.join(', ')}`);
      if (fuzzyKw.length > 0) reasons.push(`关键词模糊匹配: ${fuzzyKw.join(', ')}`);
    }

    if (hasType) {
      const typeOverlap = projectType.filter(t => crystalTypes.includes(t));
      const typeCoverage = typeOverlap.length / projectType.length;
      rawScore += typeCoverage * wType;
      if (typeOverlap.length > 0) reasons.push(`项目类型匹配: ${typeOverlap.join(', ')}`);
    }

    if (hasTags) {
      const tagOverlap = projectTags.filter(t => crystalTags.includes(t));
      const tagCoverage = tagOverlap.length / projectTags.length;
      rawScore += tagCoverage * wTag;
      if (tagOverlap.length > 0) reasons.push(`标签匹配: ${tagOverlap.join(', ')}`);
    }

    const score = Math.min(100, Math.round(rawScore));
    if (score >= 10) {
      results.push({ crystalId, score, reasons, filePath });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ─── crystallize_arrow — 重大发现上报 ─────────────────

export interface ICrystallizeArrowInput {
  source_project: string;
  discovery_type: string;
  title: string;
  detail: string;
  severity?: 'info' | 'warn' | 'critical';
  evidence?: string[];
}

export interface ICrystallizeArrowResult {
  id: string;
  filePath: string;
  eventId?: string;
}

export function crystallize_arrow(
  sotAgentRoot: string,
  input: ICrystallizeArrowInput,
): ICrystallizeArrowResult {
  const arrowsDir = path.join(sotAgentRoot, 'data', 'arrows');
  fs.mkdirSync(arrowsDir, { recursive: true });

  const id = `arrow-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const fileName = `${id}.json`;
  const filePath = path.join(arrowsDir, fileName);

  const record = {
    id,
    ts: new Date().toISOString(),
    source_project: input.source_project,
    discovery_type: input.discovery_type,
    title: input.title,
    detail: input.detail,
    severity: input.severity ?? 'info',
    evidence: input.evidence ?? [],
  };
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));

  let eventId: string | undefined;
  const eventsPath = path.join(sotAgentRoot, 'data', 'lobster-events.jsonl');
  try {
    const event = {
      id: crypto.randomUUID(),
      ts: record.ts,
      type: 'bug' as const,
      source_project: input.source_project,
      severity: input.severity ?? 'info',
      payload: { arrow_id: id, title: input.title, discovery_type: input.discovery_type },
      dedup_key: `arrow:${id}`,
    };
    fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n');
    eventId = event.id;
  } catch { /* best effort event emit */ }

  return { id, filePath, eventId };
}

export function listCrystals(sotAgentRoot: string): Array<{ id: string; sourceProject: string; filePath: string; crystallizedAt: string }> {
  const crystalsDir = path.join(sotAgentRoot, CRYSTALS_DIR);
  if (!fs.existsSync(crystalsDir)) return [];

  const results: Array<{ id: string; sourceProject: string; filePath: string; crystallizedAt: string }> = [];
  const files = fs.readdirSync(crystalsDir).filter(f => f.startsWith('crystal-') && f.endsWith('.md'));

  for (const file of files) {
    const filePath = path.join(crystalsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8').slice(0, 500);
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;

    const id = fm[1]?.match(/id:\s*"([^"]+)"/)?.[1] || file;
    const sourceProject = fm[1]?.match(/source_project:\s*"([^"]+)"/)?.[1] || 'unknown';
    const crystallizedAt = fm[1]?.match(/crystallized_at:\s*"([^"]+)"/)?.[1] || '';

    results.push({ id, sourceProject, filePath, crystallizedAt });
  }

  return results;
}
