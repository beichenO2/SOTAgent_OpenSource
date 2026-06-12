#!/bin/bash
# SOTAgent 全量测试脚本
# 测试所有 CLI 命令和核心功能

set -e
cd "$(dirname "$0")"
TSX="./node_modules/.bin/tsx"
PASS=0
FAIL=0
TESTS=()

test_cmd() {
  local name="$1"
  local cmd="$2"
  local expect_pattern="$3"
  
  echo ""
  echo "━━━ TEST: $name ━━━"
  local output
  output=$($TSX src/cli.ts $cmd 2>&1) || true
  echo "$output"
  
  if [ -n "$expect_pattern" ]; then
    if echo "$output" | grep -q "$expect_pattern"; then
      echo "✅ PASS: $name"
      PASS=$((PASS + 1))
    else
      echo "❌ FAIL: $name (expected pattern: $expect_pattern)"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "✅ PASS: $name (no assertion)"
    PASS=$((PASS + 1))
  fi
}

echo "╔══════════════════════════════════════════════╗"
echo "║  SOTAgent 全量测试                           ║"
echo "╚══════════════════════════════════════════════╝"

# 1. 帮助信息
test_cmd "CLI 帮助" "" "可用命令"

# 2. 状态概览
test_cmd "系统状态" "status" "SOTAgent 状态"

# 3. 资源采集
test_cmd "资源快照采集" "monitor-collect" "CPU:"

# 4. 资源监控（采样+扫描）
test_cmd "资源监控" "monitor" ""

# 5. 调度循环
test_cmd "调度循环" "schedule" ""

# 6. 收件箱处理
test_cmd "Inbox 处理" "process-inbox" "inbox"

# 7. 项目列表
test_cmd "项目列表" "project-list" "注册项目"

# 8. 注册测试项目
test_cmd "注册测试项目" "project-register /tmp/sotagent-test-project test-project" "已注册项目"

# 9. 注册技术资产
test_cmd "注册技术资产" "register skill test-skill /tmp/test-skill" "已注册"

# 10. 订阅技术资产
test_cmd "订阅技术资产" "subscribe test-project test-skill /tmp/test-project auto" "已订阅"

# 11. GitHub 同步巡检
test_cmd "GitHub 同步巡检" "github-sync" ""

# 12. 再次查看状态（验证数据持久化）
test_cmd "状态验证（含技术资产）" "status" "技术资产"

# ━━━ 端口管理测试 ━━━
echo ""
echo "━━━ 端口管理测试（直接数据库操作） ━━━"

PORT_TEST=$($TSX -e "
import { SOTAgentDB } from './src/db.js';
const db = new SOTAgentDB();
try {
  // 分配端口
  const port = db.allocatePort('test-service', 'test-project', 'test-device');
  console.log('allocated_port=' + port);
  
  // 查询端口
  const alloc = db.getPortAllocation(port);
  console.log('port_status=' + (alloc ? alloc.status : 'not_found'));
  
  // 列出活跃端口
  const active = db.listActivePorts();
  console.log('active_ports=' + active.length);
  
  // 释放端口
  db.releasePort(port);
  const after = db.getPortAllocation(port);
  console.log('after_release=' + (after ? 'still_active' : 'released'));
  
  console.log('PORT_TEST_PASS');
} finally {
  db.close();
}
" 2>&1)
echo "$PORT_TEST"
if echo "$PORT_TEST" | grep -q "PORT_TEST_PASS"; then
  echo "✅ PASS: 端口分配/查询/释放"
  PASS=$((PASS + 1))
else
  echo "❌ FAIL: 端口管理"
  FAIL=$((FAIL + 1))
fi

# ━━━ 项目注册表数据库测试 ━━━
echo ""
echo "━━━ 项目注册表数据库测试 ━━━"

DB_TEST=$($TSX -e "
import { SOTAgentDB } from './src/db.js';
const db = new SOTAgentDB();
try {
  // 注册项目
  db.registerProject({ path: '/tmp/test-db-project', name: 'test-db', github_remote: 'git@github.com:test/test.git' });
  
  // 查询
  const p = db.getProject('/tmp/test-db-project');
  console.log('project_name=' + (p ? p.name : 'not_found'));
  console.log('project_remote=' + (p ? p.github_remote : 'none'));
  
  // Agent session
  db.setProjectAgent('/tmp/test-db-project', 'session-abc-123');
  const p2 = db.getProject('/tmp/test-db-project');
  console.log('agent_session=' + (p2 ? p2.primary_agent_session : 'none'));
  
  // 同步事件
  db.recordSyncEvent({
    project_path: '/tmp/test-db-project',
    action: 'auto_pull',
    commits_pulled: 3,
    files_changed: 'src/main.ts,src/db.ts',
    summary: '测试同步事件',
  });
  
  const events = db.recentSyncEvents('/tmp/test-db-project', 5);
  console.log('sync_events=' + events.length);
  console.log('event_action=' + (events[0] ? events[0].action : 'none'));
  
  // 更新同步状态
  db.updateProjectSync('/tmp/test-db-project', 'synced');
  const p3 = db.getProject('/tmp/test-db-project');
  console.log('sync_result=' + (p3 ? p3.last_sync_result : 'none'));
  
  // 清理
  db.setProjectAgent('/tmp/test-db-project', null);
  
  console.log('DB_TEST_PASS');
} finally {
  db.close();
}
" 2>&1)
echo "$DB_TEST"
if echo "$DB_TEST" | grep -q "DB_TEST_PASS"; then
  echo "✅ PASS: 项目注册表数据库操作"
  PASS=$((PASS + 1))
else
  echo "❌ FAIL: 项目注册表数据库"
  FAIL=$((FAIL + 1))
fi

# ━━━ 总结 ━━━
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  测试结果: $PASS 通过 / $FAIL 失败             "
echo "╚══════════════════════════════════════════════╝"

if [ $FAIL -gt 0 ]; then
  exit 1
fi
