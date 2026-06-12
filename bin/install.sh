#!/bin/bash
# install.sh — 在当前设备安装 SOTAgent launchd 服务
#
# 架构说明：
# - ~/Polarisor/SOTAgent/ 是源码仓库（通过 GitHub 跨设备同步）
# - install.sh 将运行时复制到本地 ~/.sotagent/（因为 launchd 需要稳定路径）
# - inbox/outbox 通过 repo-sync.sh 在本地 ↔ 仓库之间同步
#
# 用法：
#   cd ~/Polarisor/SOTAgent
#   bash bin/install.sh          # 安装
#   bash bin/install.sh uninstall  # 卸载

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOCAL_DIR="$HOME/.sotagent"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
DEVICE_ID=$(hostname -s)

SENTINEL_LABEL="com.sotagent.sentinel"
MONITOR_LABEL="com.sotagent.resource-monitor"
WEB_LABEL="com.sotagent.web"
SENTINEL_PLIST="$LAUNCH_AGENTS_DIR/$SENTINEL_LABEL.plist"
MONITOR_PLIST="$LAUNCH_AGENTS_DIR/$MONITOR_LABEL.plist"
WEB_PLIST="$LAUNCH_AGENTS_DIR/$WEB_LABEL.plist"

log() { echo "[install] $*"; }

uninstall() {
  log "卸载 SOTAgent 服务..."
  launchctl bootout "gui/$(id -u)/$SENTINEL_LABEL" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/$MONITOR_LABEL" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/$WEB_LABEL" 2>/dev/null || true
  rm -f "$SENTINEL_PLIST" "$MONITOR_PLIST" "$WEB_PLIST"
  log "卸载完成（本地运行时 $LOCAL_DIR 保留，可手动删除）"
}

install() {
  log "安装 SOTAgent 到设备: $DEVICE_ID"

  # 0. 检查依赖
  if ! command -v node >/dev/null 2>&1; then
    log "❌ 需要 Node.js >= 22"
    exit 1
  fi

  if ! command -v fswatch >/dev/null 2>&1; then
    log "安装 fswatch..."
    brew install fswatch
  fi

  # 1. 复制源码到本地（排除 .git、data 等运行时目录）
  log "同步源码到 $LOCAL_DIR ..."
  mkdir -p "$LOCAL_DIR"
  rsync -a --delete \
    --exclude 'node_modules/' \
    --exclude 'data/' \
    --exclude 'inbox/' \
    --exclude 'outbox/' \
    --exclude 'processed/' \
    --exclude 'pending-sync/' \
    --exclude 'profiles/' \
    --exclude '.git/' \
    "$REPO_DIR/" "$LOCAL_DIR/"

  # 2. 创建本地数据和通信目录
  mkdir -p "$LOCAL_DIR/data/logs"
  mkdir -p "$LOCAL_DIR/inbox/$DEVICE_ID"
  mkdir -p "$LOCAL_DIR/outbox"
  mkdir -p "$LOCAL_DIR/processed"
  mkdir -p "$LOCAL_DIR/profiles"

  mkdir -p "$REPO_DIR/inbox/$DEVICE_ID"
  mkdir -p "$REPO_DIR/outbox"
  mkdir -p "$REPO_DIR/processed"
  mkdir -p "$REPO_DIR/profiles"

  # 3. 安装 npm 依赖（包括 devDependencies 中的 tsx）
  log "安装 npm 依赖..."
  cd "$LOCAL_DIR"
  npm install 2>/dev/null || npm install

  # 4. 写入设备描述
  log "写入设备描述..."
  cat > "$LOCAL_DIR/profiles/$DEVICE_ID.json" << ENDJSON
{
  "device_id": "$DEVICE_ID",
  "hostname": "$(hostname)",
  "chip": "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'unknown')",
  "total_mem_gb": $(python3 -c "import os; print(round(os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES') / 1073741824))"),
  "os_version": "$(sw_vers -productName) $(sw_vers -productVersion)",
  "last_seen": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON

  # 5. 创建 repo-sync.sh
  cat > "$LOCAL_DIR/bin/repo-sync.sh" << SYNCEOF
#!/bin/bash
# repo-sync.sh — 双向同步本地运行时 ↔ 仓库 inbox/outbox
LOCAL="$LOCAL_DIR"
REPO="$REPO_DIR"

# 仓库 → 本地（获取其他设备/Agent 写入的 inbox 消息）
rsync -a --ignore-existing "\$REPO/inbox/" "\$LOCAL/inbox/" 2>/dev/null

# 本地 → 仓库（推送处理结果回仓库，让 git push 同步到其他设备）
rsync -a "\$LOCAL/outbox/" "\$REPO/outbox/" 2>/dev/null
rsync -a "\$LOCAL/profiles/" "\$REPO/profiles/" 2>/dev/null

# 清理仓库中已处理的 inbox 文件
if [ -d "\$LOCAL/processed" ]; then
  for f in "\$LOCAL/processed"/*/*.json; do
    [ -f "\$f" ] || continue
    basename=\$(basename "\$f")
    dirname=\$(basename "\$(dirname "\$f")")
    repo_file="\$REPO/inbox/\$dirname/\$basename"
    if [ -f "\$repo_file" ]; then
      rm -f "\$repo_file"
    fi
  done
fi
SYNCEOF
  chmod +x "$LOCAL_DIR/bin/repo-sync.sh"

  # 6. 确保脚本可执行
  chmod +x "$LOCAL_DIR/bin/"*.sh

  # 7. 先卸载旧版本
  launchctl bootout "gui/$(id -u)/$SENTINEL_LABEL" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/$MONITOR_LABEL" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/$WEB_LABEL" 2>/dev/null || true

  # 8. 生成 plist（指向本地路径）
  mkdir -p "$LAUNCH_AGENTS_DIR"

  cat > "$SENTINEL_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SENTINEL_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$LOCAL_DIR/bin/sentinel.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>/tmp/sotagent-sentinel.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/sotagent-sentinel.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>LowPriorityIO</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST

  cat > "$MONITOR_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$MONITOR_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$LOCAL_DIR/bin/resource-monitor.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/sotagent-monitor.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/sotagent-monitor.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>LowPriorityIO</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST

  # 8b. Web API plist
  cat > "$WEB_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$WEB_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$LOCAL_DIR/node_modules/.bin/tsx</string>
        <string>$LOCAL_DIR/src/web.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$LOCAL_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/sotagent-web.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/sotagent-web.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
</dict>
</plist>
PLIST

  # 9. 加载服务
  launchctl bootstrap "gui/$(id -u)" "$SENTINEL_PLIST"
  launchctl bootstrap "gui/$(id -u)" "$MONITOR_PLIST"
  launchctl bootstrap "gui/$(id -u)" "$WEB_PLIST"

  log "✅ SOTAgent 已安装并启动"
  log "  本地运行时: $LOCAL_DIR/"
  log "  源码仓库:   $REPO_DIR/"
  log "  哨兵日志:  tail -f /tmp/sotagent-sentinel.out.log"
  log "  监控日志:  tail -f /tmp/sotagent-monitor.out.log"
  log "  Web 日志:  tail -f /tmp/sotagent-web.out.log"
  log "  Web 控制台: http://localhost:\$(python3 -c \"import json; print(json.load(open('$LOCAL_DIR/config.json'))['ports']['sotagent_console'])\" 2>/dev/null || echo 4805)"
  log "  Web API:    http://127.0.0.1:\$(python3 -c \"import json; print(json.load(open('$LOCAL_DIR/config.json'))['ports']['sotagent_api'])\" 2>/dev/null || echo 4800)"
  log ""
  log "在第二台设备上也运行此脚本即可完成跨设备部署。"
}

# ─── 入口 ─────────────────────────────────────────────────

case "${1:-install}" in
  uninstall|remove|stop)
    uninstall
    ;;
  install|start|"")
    install
    ;;
  *)
    echo "用法: $0 [install|uninstall]"
    exit 1
    ;;
esac
