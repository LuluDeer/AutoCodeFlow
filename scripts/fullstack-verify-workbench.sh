#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# Level-4 (real browser + real backend) verification — positioning-ux-overhaul
#
# Reuses the proven infra from scripts/e2e-full.sh (E2E_ENV, fresh PG/Redis docker,
# migration chain, admin-api + admin-web vite, health waits, trap cleanup) but
# starts NO executor: the UI/session-creation journey does not need one, and we
# deliberately do NOT assert a terminal agent success.
#
#   - throwaway DB (never the .env `autoflow` DB): autoflow_l4wb_<ts>
#   - unique ports, auto-shifted if occupied (reported into report.json)
#   - admin-api dist is rebuilt sequentially (the checked-in dist is stale and
#     lacks the new /workbench/sessions endpoints)
#   - capture: logs, playwright JSON results, spec-evidence.json, screenshot,
#     and a machine-readable report.json under artifacts/verification/
#
# Usage: bash scripts/fullstack-verify-workbench.sh
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="$no_proxy"
export NODE_OPTIONS="--max-old-space-size=4096"

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# ── memory guard ──────────────────────────────────────────────────────────────
AVAIL_KB="$(free -k | awk 'NR==2{print $7}')"   # available column (kB); locale-independent row position
if (( AVAIL_KB < 2*1024*1024 )); then
  echo "✗ available memory <2GB (${AVAIL_KB}kB) — stop per constraint" >&2
  exit 1
fi
echo "available memory: ${AVAIL_KB}kB"

TS="$(date +%Y%m%d-%H%M%S)"
ARTIFACT_DIR="${REPO_ROOT}/artifacts/verification/fullstack-workbench-${TS}"
mkdir -p "$ARTIFACT_DIR"
echo "artifact dir: $ARTIFACT_DIR"

LOG_DIR="$ARTIFACT_DIR/logs"
mkdir -p "$LOG_DIR"
RESULTS_JSON="$ARTIFACT_DIR/playwright-results.json"
SPEC_EVIDENCE="$ARTIFACT_DIR/spec-evidence.json"
PW_OUTPUT_DIR="$ARTIFACT_DIR/playwright-artifacts"
COMMANDS_FILE="$ARTIFACT_DIR/commands.txt"
: > "$COMMANDS_FILE"
record_cmd() { echo "$1 :: exit=$2" >> "$COMMANDS_FILE"; }

# ── port selection (shift if occupied) ────────────────────────────────────────
port_free() { ! (echo >"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
pick_port() { # pick_port <preferred...> ; echo chosen
  local p
  for p in "$@"; do port_free "$p" && { echo "$p"; return; }; done
  # fallback: progressive scan from 20000
  for ((p=20000; p<21000; p++)); do port_free "$p" && { echo "$p"; return; }; done
  echo "no free port found" >&2; exit 1
}
PG_PORT="$(pick_port 15432 15433 15434)"
REDIS_PORT="$(pick_port 16379 16380 16381)"
PORT_API="$(pick_port 3105 3106 3107)"
PORT_WEB="$(pick_port 5176 5177 5178)"
echo "ports: PG=$PG_PORT REDIS=$REDIS_PORT API=$PORT_API WEB=$PORT_WEB"

DB_HOST="localhost"
DB_USER="autoflow"
DB_PASS="test"
DB_NAME="autoflow_l4wb_${TS}"
REDIS_HOST="localhost"
REDIS_PASS=""

PG_CONTAINER="acf-l4wb-pg-$$"
REDIS_CONTAINER="acf-l4wb-redis-$$"
DOCKER_MODE=1
[[ "${SKIP_DOCKER:-0}" == "1" ]] && DOCKER_MODE=0

# Same E2E_ENV shape as scripts/e2e-full.sh; overrides process env only.
E2E_ENV=(
  "NODE_ENV=development"
  "DB_HOST=$DB_HOST" "DB_PORT=$PG_PORT"
  "DB_USERNAME=$DB_USER" "DB_PASSWORD=$DB_PASS" "DB_DATABASE=$DB_NAME"
  "REDIS_HOST=$REDIS_HOST" "REDIS_PORT=$REDIS_PORT"
  ${REDIS_PASS:+"REDIS_PASSWORD=$REDIS_PASS"}
  "JWT_SECRET=test-jwt-secret-32chars-long-here"
  "JWT_REFRESH_SECRET=test-refresh-secret-32chars-long"
  "EXECUTOR_SECRET=test-executor-secret"
  "EXECUTION_CALLBACK_SECRET=test-executor-secret"
  "EXECUTOR_ALLOW_PRIVATE_NETWORK=true"
  "INITIAL_ADMIN_USERNAME=admin" "INITIAL_ADMIN_PASSWORD=admin123"
  "AI_PROVIDER=disabled"
  "LOGIN_THROTTLE_LIMIT=10000"
  "THROTTLE_LIMIT=10000"
  "CORS_ORIGINS=http://localhost:$PORT_WEB,http://127.0.0.1:$PORT_WEB"
  "LOG_LEVEL=warn"
)

PIDS=()
cleanup() {
  local rc=$?
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
  if [[ "$DOCKER_MODE" == "1" ]]; then
    docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  fi
  finalize_report "$rc"
}
trap cleanup EXIT INT TERM

fail_with_log() { # <logfile> <message>
  echo "✗ $2（日志尾部如下）" >&2
  tail -50 "$1" >&2 || true
  RC_FATAL=1
  exit 1
}

wait_http() { # <url> <timeout-s> <name> <logfile>
  local url="$1" timeout="$2" name="$3" logfile="$4"
  for _ in $(seq 1 "$timeout"); do
    curl -sf -o /dev/null "$url" && return 0
    sleep 1
  done
  fail_with_log "$logfile" "$name 在 ${timeout}s 内未就绪: $url"
}

finalize_report() {
  local rc="$1"
  node - "$rc" "$ARTIFACT_DIR" "$RESULTS_JSON" "$SPEC_EVIDENCE" \
      "$PG_PORT" "$REDIS_PORT" "$PORT_API" "$PORT_WEB" "$DB_NAME" <<'NODE' || true
const fs = require('node:fs');
const [rc, dir, resultsPath, evidencePath, pg, redis, api, web, db] = process.argv.slice(2);
let cmdsRaw = '';
try { cmdsRaw = fs.readFileSync(`${dir}/commands.txt`, 'utf8'); } catch {}
function safeRead(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
const pw = safeRead(resultsPath, {});
const spec = safeRead(evidencePath, {});
const counts = {};
if (Array.isArray(pw.suites)) {
  const walk = (s) => {
    for (const sp of s.specs || []) for (const t of sp.tests || []) {
      const s = t.results?.[t.results.length - 1]?.status || 'unknown';
      counts[s] = (counts[s] || 0) + 1;
    }
    (s.suites || []).forEach(walk);
  };
  pw.suites.forEach(walk);
}
if (!Object.keys(counts).length && pw.stats) {
  counts.expected = pw.stats.expected || 0;
  counts.unexpected = pw.stats.unexpected || 0;
}
const shots = [];
try {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) return walk(p);
    return /\.(png|jpg|jpeg|webp)$/i.test(e.name) ? [p] : [];
  });
  shots.push(...walk(dir));
} catch {}
const screenshots = [...new Set([...(spec.artifacts?.successScreenshot ? [spec.artifacts.successScreenshot] : []), ...shots])];
const report = {
  generatedAt: new Date().toISOString(),
  level: 'L4-real-browser-real-backend',
  branch: 'feat/positioning-ux-overhaul',
  ports: { postgres: +pg, redis: +redis, api: +api, web: +web },
  throwawayDatabase: db,
  commandsAndExitCodes: (cmdsRaw || '').split('\n').filter(Boolean),
  overallExitCode: +rc,
  playwright: { counts, reportPath: resultsPath },
  screenshots,
  apiAssertions: spec.apiAssertions || {},
  steps: spec.steps || [],
  gaps: spec.gaps || [],
  logsDir: `${dir}/logs`,
};
fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2), 'utf8');
console.log(`report.json written: ${dir}/report.json`);
NODE
}

RC_FATAL=0

echo "══ [1/5] fresh PG + Redis docker containers ══"
if [[ "$DOCKER_MODE" == "1" ]]; then
  docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" -e POSTGRES_USER=autoflow \
    -e POSTGRES_PASSWORD=test -e POSTGRES_DB=autoflow_test \
    -p "$PG_PORT:5432" postgres:16-alpine >"$LOG_DIR/pg-run.log" 2>&1 \
    || fail_with_log "$LOG_DIR/pg-run.log" "PG 容器启动失败"
  docker run -d --name "$REDIS_CONTAINER" -p "$REDIS_PORT:6379" redis:7-alpine \
    >"$LOG_DIR/redis-run.log" 2>&1 \
    || fail_with_log "$LOG_DIR/redis-run.log" "Redis 容器启动失败"
  for _ in $(seq 1 30); do
    docker exec "$PG_CONTAINER" pg_isready -U autoflow >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$PG_CONTAINER" pg_isready -U autoflow >/dev/null \
    || fail_with_log "$LOG_DIR/pg-run.log" "PG 30s 未就绪"
  docker exec "$PG_CONTAINER" psql -U autoflow -d postgres \
    -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" >/dev/null
  docker exec "$PG_CONTAINER" psql -U autoflow -d postgres \
    -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null
  echo "PG/Redis ready; throwaway DB $DB_NAME created"
fi

echo "══ [2/5] admin-api rebuild (sequential) + migration chain ══"
(
  cd "$REPO_ROOT/apps/admin-api"
  [[ -d node_modules ]] || { echo "admin-api/node_modules 缺失，npm ci"; npm ci; }
  NODE_OPTIONS="--max-old-space-size=4096" npm run build \
    >"$LOG_DIR/admin-api-build.log" 2>&1 || true
  NODE_OPTIONS="--max-old-space-size=4096" npx tsc -p tsconfig.build.json \
    >>"$LOG_DIR/admin-api-build.log" 2>&1 || true
  # Hard assertion: dist must now contain the new session endpoint.
  grep -q "createSession\|workbench/sessions\|sessions/:id" dist/modules/workbench/workbench.controller.js \
    || { echo "dist controller missing createSession after rebuild" >>"$LOG_DIR/admin-api-build.log"; exit 1; }
  env "${E2E_ENV[@]}" npm run migration:run \
    >>"$LOG_DIR/admin-api-build.log" 2>&1
)
RC=$?; record_cmd "admin-api build+tsc+migration:run" "$RC"
if [[ $RC -ne 0 ]]; then fail_with_log "$LOG_DIR/admin-api-build.log" "admin-api rebuild/migration failed"; fi
echo "admin-api rebuilt + migrations applied"

echo "══ [3/5] start admin-api(:$PORT_API) ══"
(
  cd "$REPO_ROOT/apps/admin-api"
  exec env "${E2E_ENV[@]}" PORT=$PORT_API node dist/main.js
) >"$LOG_DIR/admin-api.log" 2>&1 &
PIDS+=($!)
wait_http "http://localhost:$PORT_API/api/health" 90 "admin-api" "$LOG_DIR/admin-api.log"
record_cmd "admin-api health wait" 0
echo "admin-api /api/health OK"

echo "══ [4/5] start admin-web vite(:$PORT_WEB) ══"
(
  cd "$REPO_ROOT/apps/admin-web"
  [[ -d node_modules ]] || { echo "admin-web/node_modules 缺失，npm ci"; npm ci; }
  exec env VITE_PORT=$PORT_WEB \
    VITE_API_URL_INTERNAL=/api VITE_API_URL_EXTERNAL= \
    VITE_API_PROXY_TARGET=http://localhost:$PORT_API \
    VITE_API_PROXY_ORIGIN_REWRITE=http://localhost:$PORT_WEB \
    node_modules/.bin/vite --port "$PORT_WEB" --strictPort
) >"$LOG_DIR/admin-web.log" 2>&1 &
PIDS+=($!)
wait_http "http://localhost:$PORT_WEB/" 90 "admin-web" "$LOG_DIR/admin-web.log"
record_cmd "admin-web vite health wait" 0
echo "vite OK"

echo "══ [5/5] Playwright Level-4 spec ══"
cd "$REPO_ROOT/apps/admin-web"
WORKBENCH_WEB_PORT="$PORT_WEB" \
WORKBENCH_API_BASE="http://localhost:$PORT_API" \
WORKBENCH_ARTIFACT_DIR="$ARTIFACT_DIR" \
WORKBENCH_PW_JSON="$RESULTS_JSON" \
WORKBENCH_OUTPUT_DIR="$PW_OUTPUT_DIR" \
NODE_OPTIONS="--max-old-space-size=4096" \
  npx playwright test --config=playwright.workbench.config.ts 2>&1 \
  | tee "$LOG_DIR/playwright.log"
RC=${PIPESTATUS[0]}
record_cmd "npx playwright test --config=playwright.workbench.config.ts" "$RC"
cd "$REPO_ROOT"

echo ""
if [[ $RC -eq 0 ]]; then
  echo "✓ Level-4 spec passed (artifacts: $ARTIFACT_DIR)"
else
  echo "✗ Level-4 spec failed exit=$RC (artifacts: $ARTIFACT_DIR)" >&2
  echo "── admin-api log tail ──" >&2; tail -40 "$LOG_DIR/admin-api.log" >&2 || true
  echo "── playwright log tail ──" >&2; tail -40 "$LOG_DIR/playwright.log" >&2 || true
fi
exit $RC
