#!/usr/bin/env bash
set -euo pipefail

# verify-desktop-workbench-bridge.sh
# 桌面 Electron 真机验收入口：只做前置检查与证据目录准备，实际验收在
# apps/executor-desktop/e2e/wb-bridge.cjs 中严格串行执行。
# 本脚本不执行构建、不启动 dev server、不修改产品源码与用户主配置。

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$REPO_ROOT/apps/executor-desktop"
HARNESS="$DESKTOP/e2e/wb-bridge.cjs"

TS="$(date +%Y%m%dT%H%M%S%3N)"
EVIDENCE_DIR="$REPO_ROOT/artifacts/verification/desktop-bridge-$TS"
COMMANDS="$EVIDENCE_DIR/commands.txt"
ASSERTIONS="$EVIDENCE_DIR/assertions.json"
RESULT="$EVIDENCE_DIR/result.json"

mkdir -p "$EVIDENCE_DIR"
: > "$COMMANDS"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$COMMANDS"
}

write_initial_evidence() {
  node - "$ASSERTIONS" "$RESULT" "$TS" "$EVIDENCE_DIR" <<'NODE'
const fs = require('fs');
const [assertionsPath, resultPath, stamp, evidenceDir] = process.argv.slice(2);
fs.writeFileSync(assertionsPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  ok: false,
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  assertions: [],
}, null, 2) + '\n');
fs.writeFileSync(resultPath, JSON.stringify({
  ok: false,
  exitCode: null,
  status: 'running',
  stamp,
  evidenceDir,
  failure: null,
  assertionSummary: { total: 0, passed: 0, failed: 0, skipped: 0, ok: false },
  cleanup: { electronAppClosed: false, stubServerClosed: false, userDataRemoved: false, ok: false },
}, null, 2) + '\n');
NODE
}

write_initial_evidence

HARNESS_PID=""

cleanup_shell() {
  local code=$?
  trap - EXIT INT TERM
  if [[ -n "$HARNESS_PID" ]] && kill -0 "$HARNESS_PID" 2>/dev/null; then
    kill -TERM "$HARNESS_PID" 2>/dev/null || true
    wait "$HARNESS_PID" 2>/dev/null || true
  fi
  log "shell exit code=$code"
  exit "$code"
}

trap cleanup_shell EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

fail_early() {
  local message="$1"
  log "FAIL: $message"
  node - "$RESULT" "$message" <<'NODE'
const fs = require('fs');
const [resultPath, message] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
result.status = 'failed';
result.ok = false;
result.exitCode = 1;
result.finishedAt = new Date().toISOString();
result.failure = { message, stack: null };
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
NODE
  echo "verify-desktop-workbench-bridge: $message" >&2
  exit 1
}

log "PRECONDITION: dist/preload/workbench.js 必须由主控先重建；本脚本不执行构建。"
log "REPO_ROOT=$REPO_ROOT"
log "DESKTOP=$DESKTOP"
log "EVIDENCE_DIR=$EVIDENCE_DIR"
log "DISPLAY=${DISPLAY:-:0}"
log "XAUTHORITY=${XAUTHORITY:-/run/user/1000/.mutter-Xwaylandauth.MA3IZ3}"

run_check() {
  log "$*"
  "$@"
}

run_check test -f "$DESKTOP/package.json" || fail_early "缺少 $DESKTOP/package.json"
run_check test -f "$HARNESS" || fail_early "缺少 $HARNESS"
run_check test -f "$DESKTOP/dist/main/index.js" || fail_early "缺少 $DESKTOP/dist/main/index.js；请先重建桌面端"
run_check test -f "$DESKTOP/dist/preload/workbench.js" || fail_early "缺少 $DESKTOP/dist/preload/workbench.js；请先重建桌面端（旧桥不可验）"
run_check test -f "$DESKTOP/dist/preload/index.js" || fail_early "缺少 $DESKTOP/dist/preload/index.js；请先重建桌面端"
run_check test -f "$DESKTOP/node_modules/@playwright/test/package.json" || fail_early "缺少 @playwright/test；请在 apps/executor-desktop 安装依赖"
run_check test -f "$DESKTOP/node_modules/electron/package.json" || fail_early "缺少 electron；请在 apps/executor-desktop 安装依赖"

log "node \"$HARNESS\" --evidence-dir \"$EVIDENCE_DIR\""
node "$HARNESS" --evidence-dir "$EVIDENCE_DIR" &
HARNESS_PID=$!

set +e
wait "$HARNESS_PID"
code=$?
set -e
HARNESS_PID=""

log "harness exit code=$code"
exit "$code"
