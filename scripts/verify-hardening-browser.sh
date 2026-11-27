#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# Level-4 hardening verification — real Chrome + real backend.
#
# Starts one throwaway stack:
#   - fresh PG + Redis docker containers and throwaway DB (never repo .env DB)
#   - real admin-api (rebuilt from current source) + real migrations
#   - real admin-web vite on an isolated port
#   - real /usr/bin/google-chrome via PLAYWRIGHT_CHROMIUM_CHANNEL=chrome
#
# Evidence: artifacts/verification/hardening-browser-<ts>/report.json plus
# screenshots and full command exit-code log.
#
# Usage: bash scripts/verify-hardening-browser.sh
# ═════════════════════════════════════════════════════════════════════════════
set -uo pipefail

export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="$no_proxy"
export NODE_OPTIONS="--max-old-space-size=4096"
export PLAYWRIGHT_CHROMIUM_CHANNEL=chrome

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

AVAIL_KB="$(free -k | awk 'NR==2{print $7}')"
if (( AVAIL_KB < 2*1024*1024 )); then
  echo "✗ available memory <2GB (${AVAIL_KB}kB)" >&2
  exit 1
fi
echo "available memory: ${AVAIL_KB}kB"

TS="$(date +%Y%m%d-%H%M%S)"
ARTIFACT_DIR="${REPO_ROOT}/artifacts/verification/hardening-browser-${TS}"
LOG_DIR="$ARTIFACT_DIR/logs"
ARTIFACT_ROOT="$ARTIFACT_DIR/artifact-root"
mkdir -p "$LOG_DIR" "$ARTIFACT_ROOT"
echo "artifact dir: $ARTIFACT_DIR"

RESULTS_JSON="$ARTIFACT_DIR/playwright-results.json"
SPEC_EVIDENCE="$ARTIFACT_DIR/spec-evidence.json"
PW_OUTPUT_DIR="$ARTIFACT_DIR/playwright-artifacts"
COMMANDS_FILE="$ARTIFACT_DIR/commands.txt"
: > "$COMMANDS_FILE"
record_cmd() { echo "$1 :: exit=$2" >> "$COMMANDS_FILE"; }

port_free() { ! (echo >"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
pick_port() {
  local p
  for p in "$@"; do port_free "$p" && { echo "$p"; return; }; done
  for ((p=20000; p<21000; p++)); do port_free "$p" && { echo "$p"; return; }; done
  echo "no free port found" >&2; exit 1
}
PG_PORT="$(pick_port 15434 15435 15436)"
REDIS_PORT="$(pick_port 16389 16390 16391)"
PORT_API="$(pick_port 3107 3108 3109)"
PORT_WEB="$(pick_port 5178 5179 5180)"
echo "ports: PG=$PG_PORT REDIS=$REDIS_PORT API=$PORT_API WEB=$PORT_WEB"

DB_HOST="localhost"
DB_USER="autoflow"
DB_PASS="test"
DB_NAME="autoflow_h4_${TS}"
REDIS_HOST="localhost"

PG_CONTAINER="acf-h4-browser-pg-$$"
REDIS_CONTAINER="acf-h4-browser-redis-$$"
DOCKER_MODE=1
[[ "${SKIP_DOCKER:-0}" == "1" ]] && DOCKER_MODE=0

E2E_ENV=(
  "NODE_ENV=development"
  "DB_HOST=$DB_HOST" "DB_PORT=$PG_PORT"
  "DB_USERNAME=$DB_USER" "DB_PASSWORD=$DB_PASS" "DB_DATABASE=$DB_NAME"
  "REDIS_HOST=$REDIS_HOST" "REDIS_PORT=$REDIS_PORT"
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
  "LOG_ARTIFACT_DIR=$ARTIFACT_ROOT"
)

PIDS=()
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
  if [[ "$DOCKER_MODE" == "1" ]]; then
    docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  fi
  finalize_report "$rc"
  exit "$rc"
}
trap cleanup EXIT INT TERM

fail_with_log() {
  echo "✗ $2（日志尾部如下）" >&2
  tail -50 "$1" >&2 || true
  RC_FATAL=1
  exit 1
}

wait_http() {
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
      "$PG_PORT" "$REDIS_PORT" "$PORT_API" "$PORT_WEB" "$DB_NAME" \
      "$REPO_ROOT" "$PLAYWRIGHT_CHROMIUM_CHANNEL" <<'NODE' || true
const fs = require('node:fs');
const [rc, dir, resultsPath, evidencePath, pg, redis, api, web, db, repoRoot, channel] = process.argv.slice(2);
const safeRead = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
let cmdsRaw = '';
try { cmdsRaw = fs.readFileSync(`${dir}/commands.txt`, 'utf8'); } catch {}
const pw = safeRead(resultsPath, {});
const ev = safeRead(evidencePath, {});
const counts = {};
const walkSuites = (suites) => {
  for (const suite of suites || []) {
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const status = t.results?.[t.results.length - 1]?.status || 'unknown';
        counts[status] = (counts[status] || 0) + 1;
      }
    }
    walkSuites(suite.suites);
  }
};
walkSuites(pw.suites);
if (!Object.keys(counts).length && pw.stats) {
  counts.expected = pw.stats.expected || 0;
  counts.unexpected = pw.stats.unexpected || 0;
}
const shots = [];
try {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) return walk(p);
    return /\.(png|jpg|jpeg|webp)$/i.test(e.name) ? [p] : [];
  });
  shots.push(...walk(dir));
} catch {}
const assertions = Array.isArray(ev.assertions) ? ev.assertions : [];
const statusCounts = assertions.reduce((acc, a) => {
  acc[a.status] = (acc[a.status] || 0) + 1;
  return acc;
}, {});
const skips = Array.isArray(ev.skips) ? ev.skips : [];
const failures = assertions.filter((a) => a.status === 'FAIL');
const report = {
  generatedAt: new Date().toISOString(),
  level: 'L4-real-browser-real-backend',
  branch: 'hardening-browser',
  repoRoot,
  browser: { channel, env: 'PLAYWRIGHT_CHROMIUM_CHANNEL', binary: '/usr/bin/google-chrome' },
  ports: { postgres: +pg, redis: +redis, api: +api, web: +web },
  throwawayDatabase: db,
  commandsAndExitCodes: (cmdsRaw || '').split('\n').filter(Boolean),
  overallExitCode: +rc,
  result: +rc === 0 && skips.length === 0 && failures.length === 0
    ? 'PASS'
    : (failures.length || +rc !== 0) ? 'FAIL' : 'PARTIAL_SKIP',
  playwright: { counts, reportPath: resultsPath },
  assertions,
  assertionCounts: statusCounts,
  failures: failures.map((f) => ({ name: f.name, detail: f.detail })),
  skips,
  gaps: Array.isArray(ev.gaps) ? ev.gaps : [],
  steps: Array.isArray(ev.steps) ? ev.steps : [],
  screenshots: [...new Set(shots)],
  logsDir: `${dir}/logs`,
  specEvidencePath: evidencePath,
};
fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2), 'utf8');
console.log(`report.json written: ${dir}/report.json`);
console.log(`result=${report.result} assertions=${JSON.stringify(statusCounts)} skips=${skips.length}`);
NODE
}

RC_FATAL=0

google-chrome --version > "$LOG_DIR/chrome-version.log" 2>&1
RC=$?
record_cmd "google-chrome --version" "$RC"
cat "$LOG_DIR/chrome-version.log"
if [[ $RC -ne 0 ]]; then fail_with_log "$LOG_DIR/chrome-version.log" "Google Chrome 不可用"; fi

echo "══ [1/6] fresh PG + Redis docker containers ══"
if [[ "$DOCKER_MODE" == "1" ]]; then
  docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" -e POSTGRES_USER=autoflow \
    -e POSTGRES_PASSWORD=test -e POSTGRES_DB=autoflow_test \
    -p "$PG_PORT:5432" postgres:16-alpine >"$LOG_DIR/pg-run.log" 2>&1 \
    || fail_with_log "$LOG_DIR/pg-run.log" "PG 容器启动失败"
  docker run -d --name "$REDIS_CONTAINER" -p "$REDIS_PORT:6379" redis:7-alpine \
    >"$LOG_DIR/redis-run.log" 2>&1 \
    || fail_with_log "$LOG_DIR/redis-run.log" "Redis 容器启动失败"
  record_cmd "docker run postgres:16-alpine + redis:7-alpine" 0
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
  record_cmd "create throwaway database $DB_NAME" 0
  echo "PG/Redis ready; throwaway DB $DB_NAME created"
fi

echo "══ [2/6] admin-api rebuild + migration chain ══"
(
  cd "$REPO_ROOT/apps/admin-api"
  [[ -d node_modules ]] || { echo "admin-api/node_modules 缺失，npm ci"; npm ci; }
  NODE_OPTIONS="--max-old-space-size=4096" npm run build \
    >"$LOG_DIR/admin-api-build.log" 2>&1 || true
  NODE_OPTIONS="--max-old-space-size=4096" npx tsc -p tsconfig.build.json \
    >>"$LOG_DIR/admin-api-build.log" 2>&1 || true
  grep -q "sessions/:id" dist/modules/workbench/workbench.controller.js \
    || { echo "dist controller missing workbench sessions/:id endpoint" >>"$LOG_DIR/admin-api-build.log"; exit 1; }
  env "${E2E_ENV[@]}" npm run migration:run \
    >>"$LOG_DIR/admin-api-build.log" 2>&1
)
RC=$?
record_cmd "admin-api npm run build + tsc + migration:run" "$RC"
if [[ $RC -ne 0 ]]; then fail_with_log "$LOG_DIR/admin-api-build.log" "admin-api rebuild/migration failed"; fi
echo "admin-api rebuilt + migrations applied"

echo "══ [3/6] start admin-api(:$PORT_API) ══"
(
  cd "$REPO_ROOT/apps/admin-api"
  exec env "${E2E_ENV[@]}" PORT=$PORT_API node dist/main.js
) >"$LOG_DIR/admin-api.log" 2>&1 &
PIDS+=($!)
wait_http "http://localhost:$PORT_API/api/health" 90 "admin-api" "$LOG_DIR/admin-api.log"
record_cmd "admin-api health wait" 0
echo "admin-api /api/health OK"

echo "══ [4/6] start admin-web vite(:$PORT_WEB) ══"
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

echo "══ [5/6] Playwright hardening browser spec ══"
cd "$REPO_ROOT/apps/admin-web"
HARDENING_WEB_PORT="$PORT_WEB" \
HARDENING_API_BASE="http://localhost:$PORT_API" \
HARDENING_REPO_ROOT="$REPO_ROOT" \
HARDENING_RUN_DIR="$ARTIFACT_DIR" \
HARDENING_ARTIFACT_ROOT="$ARTIFACT_ROOT" \
HARDENING_DB_HOST="$DB_HOST" \
HARDENING_DB_PORT="$PG_PORT" \
HARDENING_DB_USERNAME="$DB_USER" \
HARDENING_DB_PASSWORD="$DB_PASS" \
HARDENING_DB_DATABASE="$DB_NAME" \
HARDENING_CALLBACK_SECRET="test-executor-secret" \
HARDENING_PW_JSON="$RESULTS_JSON" \
HARDENING_OUTPUT_DIR="$PW_OUTPUT_DIR" \
NODE_OPTIONS="--max-old-space-size=4096" \
PLAYWRIGHT_CHROMIUM_CHANNEL=chrome \
  npx playwright test --config=playwright.hardening.config.ts 2>&1 \
  | tee "$LOG_DIR/playwright.log"
RC=${PIPESTATUS[0]}
record_cmd "PLAYWRIGHT_CHROMIUM_CHANNEL=chrome npx playwright test --config=playwright.hardening.config.ts" "$RC"
cd "$REPO_ROOT"

echo "══ [6/6] evidence summary ══"
if [[ -f "$SPEC_EVIDENCE" ]]; then
  SKIP_COUNT="$(node -e "const f=process.argv[1];try{const e=require(f);console.log((e.skips||[]).length)}catch{console.log(0)}" "$SPEC_EVIDENCE")"
  FAIL_COUNT="$(node -e "const f=process.argv[1];try{const e=require(f);console.log((e.assertions||[]).filter(a=>a.status==='FAIL').length)}catch{console.log(0)}" "$SPEC_EVIDENCE")"
  echo "spec skips=$SKIP_COUNT failures=$FAIL_COUNT"
  if [[ "$RC" -eq 0 && "$SKIP_COUNT" -gt 0 ]]; then
    RC=2
    record_cmd "SKIP present => exit 2 (not green)" "$RC"
  fi
else
  echo "spec evidence missing: $SPEC_EVIDENCE" >&2
fi

if [[ $RC -eq 0 ]]; then
  echo "✓ hardening browser verification passed (artifacts: $ARTIFACT_DIR)"
else
  echo "✗ hardening browser verification exit=$RC (artifacts: $ARTIFACT_DIR)" >&2
  echo "── admin-api log tail ──" >&2; tail -40 "$LOG_DIR/admin-api.log" >&2 || true
  echo "── playwright log tail ──" >&2; tail -60 "$LOG_DIR/playwright.log" >&2 || true
fi
RC_FATAL=$RC
exit "$RC"
