#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || node -p "require('$PROJECT_DIR/package.json').version"

