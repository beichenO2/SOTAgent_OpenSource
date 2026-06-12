/**
 * Planning Scanner — scans .planning/ directories across all projects
 * and writes cursor rules with relevant experience context.
 *
 * Triggered on SOTAgent startup and periodically.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const POLARISOR_ROOT = process.env['POLARISOR_ROOT'] || path.join(os.homedir(), 'Polarisor');
const CURSOR_RULES_DIR = path.join(POLARISOR_ROOT, '.cursor', 'rules');

export interface PlanningArtifact {
  project: string;
  type: 'roadmap' | 'plan' | 'verification' | 'review' | 'project';
  path: string;
  summary: string;
  phase?: string;
}

/**
 * Scan all .planning/ directories under POLARISOR_ROOT.
 */
export function scanAllPlanning(): PlanningArtifact[] {
  const artifacts: PlanningArtifact[] = [];

  try {
    const entries = fs.readdirSync(POLARISOR_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

      const planningDir = path.join(POLARISOR_ROOT, entry.name, '.planning');
      if (!fs.existsSync(planningDir)) continue;

      const projectArtifacts = scanProjectPlanning(entry.name, planningDir);
      artifacts.push(...projectArtifacts);
    }
  } catch {
    // Root scan failed — non-fatal
  }

  return artifacts;
}

function scanProjectPlanning(project: string, planningDir: string): PlanningArtifact[] {
  const artifacts: PlanningArtifact[] = [];

  const roadmapPath = path.join(planningDir, 'ROADMAP.md');
  if (fs.existsSync(roadmapPath)) {
    const content = fs.readFileSync(roadmapPath, 'utf-8');
    const donePhases = (content.match(/\[done\]/gi) || []).length;
    const pendingPhases = (content.match(/\[pending\]/gi) || []).length;
    artifacts.push({
      project,
      type: 'roadmap',
      path: roadmapPath,
      summary: `${donePhases} done, ${pendingPhases} pending phases`,
    });
  }

  const projectPath = path.join(planningDir, 'PROJECT.md');
  if (fs.existsSync(projectPath)) {
    const content = fs.readFileSync(projectPath, 'utf-8').slice(0, 500);
    const firstLine = content.split('\n').find(l => l.startsWith('#'))?.replace(/^#+\s*/, '') || project;
    artifacts.push({
      project,
      type: 'project',
      path: projectPath,
      summary: firstLine,
    });
  }

  const phasesDir = path.join(planningDir, 'phases');
  if (fs.existsSync(phasesDir)) {
    try {
      const phases = fs.readdirSync(phasesDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const phase of phases) {
        for (const file of ['PLAN.md', 'VERIFICATION.md', 'REVIEW.md']) {
          const filePath = path.join(phasesDir, phase.name, file);
          if (fs.existsSync(filePath)) {
            const type = file === 'PLAN.md' ? 'plan'
              : file === 'VERIFICATION.md' ? 'verification'
              : 'review';
            artifacts.push({
              project,
              type,
              path: filePath,
              summary: `${phase.name}/${file}`,
              phase: phase.name,
            });
          }
        }
      }
    } catch {
      // phases scan failed — non-fatal
    }
  }

  return artifacts;
}

/**
 * Write a project-memory cursor rule file with experience context.
 * Written to .cursor/rules/{project}-memory.md
 */
export function writeProjectMemoryRule(project: string, artifacts: PlanningArtifact[]): void {
  const projectArtifacts = artifacts.filter(a => a.project === project);
  if (projectArtifacts.length === 0) return;

  fs.mkdirSync(CURSOR_RULES_DIR, { recursive: true });

  const roadmap = projectArtifacts.find(a => a.type === 'roadmap');
  const projectInfo = projectArtifacts.find(a => a.type === 'project');
  const plans = projectArtifacts.filter(a => a.type === 'plan');
  const reviews = projectArtifacts.filter(a => a.type === 'review');

  let content = `---\nalwaysApply: false\nglobs:\n  - "${project}/**"\ndescription: "Auto-generated experience context for ${project}"\n---\n\n`;
  content += `# ${project} — Experience Context\n\n`;

  if (projectInfo) {
    content += `## Project\n${projectInfo.summary}\n\n`;
  }
  if (roadmap) {
    content += `## Progress\n${roadmap.summary}\n\n`;
  }
  if (plans.length > 0) {
    content += `## Recent Plans\n`;
    for (const p of plans.slice(-5)) {
      content += `- ${p.summary}\n`;
    }
    content += '\n';
  }
  if (reviews.length > 0) {
    content += `## Reviews\n`;
    for (const r of reviews.slice(-3)) {
      content += `- ${r.summary}\n`;
    }
    content += '\n';
  }

  const rulePath = path.join(CURSOR_RULES_DIR, `${project}-memory.md`);
  fs.writeFileSync(rulePath, content);
}

/**
 * Full scan + write cycle.
 */
export function refreshAllProjectMemory(): { projects: number; artifacts: number } {
  const artifacts = scanAllPlanning();
  const projects = new Set(artifacts.map(a => a.project));

  for (const project of projects) {
    writeProjectMemoryRule(project, artifacts);
  }

  return { projects: projects.size, artifacts: artifacts.length };
}
