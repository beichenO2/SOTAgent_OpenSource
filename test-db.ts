/**
 * SOTAgent 数据库层测试
 * 测试端口管理、项目注册表、同步事件等
 */
import { SOTAgentDB } from './src/db.js';

const db = new SOTAgentDB();
let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
    pass++;
  } else {
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

try {
  console.log('\n━━━ 端口管理 ━━━');
  const port = db.allocatePort({ service_name: 'test-svc', project: 'test-proj', device_id: 'test-dev' });
  assert('端口分配', port !== null && port >= 3000 && port <= 9999, `port=${port}`);

  const alloc = db.getPortAllocation(port);
  assert('端口查询', alloc?.status === 'active');

  const active = db.listActivePorts();
  assert('活跃端口列表', active.length >= 1);

  db.releasePort(port);
  const after = db.getPortAllocation(port);
  assert('端口释放', after === undefined);

  console.log('\n━━━ 项目注册表 ━━━');
  db.registerProject({
    path: '/tmp/test-reg-project',
    name: 'test-reg',
    github_remote: 'git@github.com:test/repo.git',
  });
  const proj = db.getProject('/tmp/test-reg-project');
  assert('项目注册', proj?.name === 'test-reg');
  assert('GitHub remote', proj?.github_remote === 'git@github.com:test/repo.git');
  assert('自动同步默认开启', proj?.auto_sync === 1);

  db.setProjectAgent('/tmp/test-reg-project', 'session-xyz');
  const proj2 = db.getProject('/tmp/test-reg-project');
  assert('设置 Agent session', proj2?.primary_agent_session === 'session-xyz');

  db.setProjectAgent('/tmp/test-reg-project', null);
  const proj3 = db.getProject('/tmp/test-reg-project');
  assert('清除 Agent session', proj3?.primary_agent_session === null);

  console.log('\n━━━ 同步事件 ━━━');
  db.recordSyncEvent({
    project_path: '/tmp/test-reg-project',
    action: 'auto_pull',
    commits_pulled: 5,
    files_changed: 'a.ts,b.ts',
    summary: '测试拉取',
  });
  db.recordSyncEvent({
    project_path: '/tmp/test-reg-project',
    action: 'auto_push',
    commits_pushed: 2,
    summary: '测试推送',
  });

  const events = db.recentSyncEvents('/tmp/test-reg-project', 10);
  assert('同步事件记录', events.length >= 2);
  const pushEvent = events.find(e => e.action === 'auto_push');
  assert('存在 push 事件', pushEvent !== undefined);
  assert('push 事件有推送数', pushEvent?.commits_pushed === 2);

  db.updateProjectSync('/tmp/test-reg-project', 'synced');
  const proj4 = db.getProject('/tmp/test-reg-project');
  assert('同步状态更新', proj4?.last_sync_result === 'synced');
  assert('同步时间记录', proj4?.last_sync_at !== null);

  console.log('\n━━━ 项目列表 ━━━');
  const allProjects = db.listProjects();
  assert('项目总数 >= 8', allProjects.length >= 8, `count=${allProjects.length}`);

  console.log('\n━━━ 技术资产 ━━━');
  db.registerAsset({
    id: 'test-asset-db',
    type: 'methodology',
    canonical_path: '/tmp/test-method',
    updated_by: 'test-device',
  });
  const assets = db.listAssets();
  assert('技术资产注册', assets.some(a => a.id === 'test-asset-db'));

  db.subscribe({
    project_id: 'test-reg',
    asset_id: 'test-asset-db',
    sync_level: 'suggest',
    project_path: '/tmp/test-reg-project',
  });
  const subs = db.getSubscribers('test-asset-db');
  assert('订阅关系', subs.length >= 1);

  console.log('\n━━━ 资源快照 ━━━');
  db.recordSnapshot({
    device_id: 'test-device',
    cpu_percent: 42.5,
    mem_used_mb: 8192,
    mem_total_mb: 16384,
    mem_percent: 50.0,
    gpu_mem_used_mb: 1024,
    timestamp: new Date().toISOString(),
  });
  const snaps = db.recentSnapshots('test-device', 1);
  assert('资源快照记录', snaps.length === 1);
  assert('CPU 数据正确', snaps[0].cpu_percent === 42.5);
  assert('GPU 数据正确', snaps[0].gpu_mem_used_mb === 1024);

} finally {
  db.close();
}

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║  数据库测试: ${pass} 通过 / ${fail} 失败`);
console.log(`╚══════════════════════════════════════════════╝`);

if (fail > 0) process.exit(1);
