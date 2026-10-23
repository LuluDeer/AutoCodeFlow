#!/usr/bin/env bash
#
# One-command demo for AutoCodeFlow.
#
# Goal: a developer with Docker can go from a clean clone to "a scheduled task
# ran successfully and I can see the logs" in a few minutes, without editing
# secrets or fighting port 80.
#
# What it does:
#   1. generates .env.demo with strong random secrets (never touches .env)
#   2. starts an isolated compose project on loopback ports (default :8088)
#   3. seeds the demo tasks/SOPs from scripts/demo-seed.mjs
#   4. triggers demo-hello-fixed and waits for a successful execution
#   5. prints the UI URL, admin credentials, and the next thing to click
#
# Usage:
#   ./scripts/demo.sh                 # start + seed + verify
#   ./scripts/demo.sh --build         # rebuild images first (after code changes)
#   ./scripts/demo.sh --down          # stop, keep data
#   ./scripts/demo.sh --reset         # stop, delete data + .env.demo
#   ./scripts/demo.sh --logs          # follow logs
#   ./scripts/demo.sh --status        # show container status
#   ./scripts/demo.sh --port 8090     # use another UI port
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="${ACF_DEMO_PROJECT:-acf-demo}"
WEB_PORT="${ACF_DEMO_WEB_PORT:-8088}"
API_PORT="${ACF_DEMO_API_PORT:-3105}"
EXECUTOR_PORT="${ACF_DEMO_EXECUTOR_PORT:-8002}"
PY_EXECUTOR_PORT="${ACF_DEMO_PY_EXECUTOR_PORT:-8001}"
ENV_FILE="$ROOT/.env.demo"
SERVICES=(postgres redis admin-api admin-web executor-node executor-python registry-npm registry-pypi)

DO_BUILD=0
DO_DOWN=0
DO_RESET=0
DO_LOGS=0
DO_STATUS=0
DO_SEED=1

usage() {
  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) DO_BUILD=1 ;;
    --down) DO_DOWN=1 ;;
    --reset) DO_RESET=1 ;;
    --logs) DO_LOGS=1 ;;
    --status) DO_STATUS=1 ;;
    --no-seed) DO_SEED=0 ;;
    --port)
      [[ $# -ge 2 ]] || { echo "--port needs a value" >&2; exit 2; }
      WEB_PORT="$2"; shift ;;
    --api-port)
      [[ $# -ge 2 ]] || { echo "--api-port needs a value" >&2; exit 2; }
      API_PORT="$2"; shift ;;
    --executor-port)
      [[ $# -ge 2 ]] || { echo "--executor-port needs a value" >&2; exit 2; }
      EXECUTOR_PORT="$2"; shift ;;
    --python-executor-port)
      [[ $# -ge 2 ]] || { echo "--python-executor-port needs a value" >&2; exit 2; }
      PY_EXECUTOR_PORT="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# ── docker / compose detection ────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found. Install Docker Desktop or Docker Engine first." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ cannot talk to the Docker daemon (is it running? are you in the docker group?)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js 18+ is required for the demo seed/verification scripts (no npm install needed)." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "✗ need docker compose v2 (or the legacy docker-compose binary)" >&2
  exit 1
fi

compose() {
  "${DC[@]}" --env-file "$ENV_FILE" -p "$PROJECT" \
    -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.demo.yml" "$@"
}

# Keep the override's ${...:-default} interpolation aligned with the CLI flags.
export ACF_DEMO_WEB_PORT="$WEB_PORT"
export ACF_DEMO_API_PORT="$API_PORT"
export ACF_DEMO_EXECUTOR_PORT="$EXECUTOR_PORT"
export ACF_DEMO_PY_EXECUTOR_PORT="$PY_EXECUTOR_PORT"
export ACF_DEMO_ORIGIN="http://localhost:$WEB_PORT"
# Local demo keeps NODE_ENV=production (so startup migrations and fail-fast
# behavior match production), and explicitly opts into loopback CORS via
# ALLOW_LOOPBACK_CORS=true in .env.demo. Keep both loopback spellings so the UI
# works whether the user opens localhost or 127.0.0.1.
export ACF_DEMO_CORS="${ACF_DEMO_CORS:-http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT}"

# ── helpers ───────────────────────────────────────────────────────────────
gen_hex() {
  local bytes="${1:-24}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    node -e "process.stdout.write(require('crypto').randomBytes($bytes).toString('hex'))"
  fi
}

read_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

# Backfill a key that was introduced after the file was generated (upgrade path),
# so an existing .env.demo keeps working instead of failing compose interpolation.
ensure_env_key() {
  local key="$1" value="$2"
  [[ -f "$ENV_FILE" ]] || return 0
  [[ -n "$(read_env "$key")" ]] && return 0
  printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  echo "✓ backfilled $key into $ENV_FILE"
}

# Linux uses ss; macOS has lsof; bash's /dev/tcp is the last resort.
port_busy() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      return 0
    fi
    return 1
  fi
}

require_free_port() {
  local port="$1" what="$2" flag="$3"
  if port_busy "$port"; then
    echo "✗ $what port $port is already in use." >&2
    echo "  Pick another one: ./scripts/demo.sh $flag <port>" >&2
    exit 1
  fi
}

wait_url() {
  local url="$1" name="$2" timeout="${3:-180}"
  local start=$SECONDS
  until curl -fsS --max-time 3 "$url" >/dev/null 2>&1; do
    if (( SECONDS - start > timeout )); then
      echo "✗ $name did not become ready within ${timeout}s" >&2
      compose ps >&2 || true
      compose logs --tail=80 admin-api admin-web executor-node >&2 || true
      return 1
    fi
    sleep 2
  done
  echo "✓ $name ready"
}

ensure_env() {
  if [[ -f "$ENV_FILE" ]]; then
    if [[ -z "$(read_env INITIAL_ADMIN_PASSWORD)" ]]; then
      echo "✗ $ENV_FILE exists but has no INITIAL_ADMIN_PASSWORD." >&2
      echo "  Run ./scripts/demo.sh --reset to regenerate it (this deletes demo data)." >&2
      exit 1
    fi
    echo "✓ reusing $ENV_FILE (delete it or run --reset to regenerate)"
    # 2026-10-22 起 compose 要求每副本对外地址必填（EXECUTOR_*_PUBLIC_ADDRESS，
    # 见 docker-compose.yml 的 P1-1 注释）。旧 .env.demo 没有这两键，会直接
    # 插值失败、demo 第一步就炸——就地补齐，别让用户重来一遍。
    ensure_env_key EXECUTOR_NODE_PUBLIC_ADDRESS executor-node:8002
    ensure_env_key EXECUTOR_PYTHON_PUBLIC_ADDRESS executor-python:8001
    return 0
  fi

  echo "→ generating $ENV_FILE with random secrets"
  local pg_pw jwt_refresh jwt exec admin_pw
  pg_pw="$(gen_hex 24)"
  jwt="$(gen_hex 48)"
  jwt_refresh="$(gen_hex 48)"
  exec="$(gen_hex 24)"
  admin_pw="Acf-$(gen_hex 8)"

  umask 077
  cat >"$ENV_FILE" <<EOF
# Generated by scripts/demo.sh — DO NOT COMMIT.
# This file is for the local demo compose project only.
NODE_ENV=production
# Demo-only: allow http://localhost:<port> / 127.0.0.1:<port> in the CORS
# allow-list. The production guard rejects loopback unless this is explicit.
ALLOW_LOOPBACK_CORS=true
POSTGRES_USER=autoflow
POSTGRES_PASSWORD=$pg_pw
DB_DATABASE=autoflow
DB_USERNAME=autoflow
DB_PASSWORD=$pg_pw
REDIS_PASSWORD=$(gen_hex 24)
JWT_SECRET=$jwt
JWT_REFRESH_SECRET=$jwt_refresh
EXECUTOR_SECRET=$exec
# P1-1（生产报告 2026-10-22）：compose 要求每个执行器上报**各自的**对外地址，
# 不再给会碰撞的字面缺省值。demo 每个执行器只有一个副本，服务名即可。
EXECUTOR_NODE_PUBLIC_ADDRESS=executor-node:8002
EXECUTOR_PYTHON_PUBLIC_ADDRESS=executor-python:8001
# registry-pypi is part of the base compose graph even when not started;
# compose still interpolates its required REGISTRY_PASS guard.
REGISTRY_PASS=$(gen_hex 24)
# Optional profiles are still interpolated by compose; give them values so a
# plain status command does not fail on unrelated services.
GRAFANA_ADMIN_PASSWORD=$(gen_hex 24)
MINIO_ROOT_PASSWORD=$(gen_hex 24)
INITIAL_ADMIN_PASSWORD=$admin_pw
INITIAL_ADMIN_EMAIL=admin@autoflow.local
API_BASE_URL=http://admin-api:3105
APP_PROTOCOL=http
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"
  echo "✓ wrote $ENV_FILE (mode 600)"

  # Optional real AI provider. Kept opt-in: the demo stays API-key-free unless
  # the caller explicitly provides one. The endpoint must be OpenAI-compatible;
  # the qwen code path is the OpenAI-compatible multimodal one.
  if [[ -n "${ACF_LLM_API_KEY:-}" ]]; then
    {
      echo "AI_PROVIDER=qwen"
      echo "QWEN_API_KEY=$ACF_LLM_API_KEY"
      echo "QWEN_BASE_URL=${ACF_LLM_BASE_URL:-https://api.openai.com/v1}"
      echo "QWEN_MODEL=${ACF_LLM_MODEL:-gpt-4o-mini}"
    } >> "$ENV_FILE"
    echo "✓ AI provider wired (${ACF_LLM_MODEL:-gpt-4o-mini} via ${ACF_LLM_BASE_URL:-https://api.openai.com/v1})"
  fi
}

admin_password() {
  local pw
  pw="$(read_env INITIAL_ADMIN_PASSWORD)"
  if [[ -z "$pw" ]]; then
    echo "✗ INITIAL_ADMIN_PASSWORD missing from $ENV_FILE" >&2
    exit 1
  fi
  printf '%s' "$pw"
}

cleanup_on_error() {
  echo "" >&2
  echo "✗ demo did not finish. Recent logs:" >&2
  compose logs --tail=100 admin-api admin-web executor-node 2>/dev/null || true
}
trap cleanup_on_error ERR

# ── control commands ─────────────────────────────────────────────────────
# .env.demo is needed even for `--down`/`--status`: compose interpolates the
# same required variables. Generating it on a control command is harmless.
ensure_env

if (( DO_DOWN )); then
  compose down
  echo "✓ stopped (data volumes kept; use --reset to delete them)"
  exit 0
fi

if (( DO_RESET )); then
  compose down -v 2>/dev/null || true
  rm -f "$ENV_FILE"
  echo "✓ stopped and deleted demo data + $ENV_FILE"
  exit 0
fi

if (( DO_STATUS )); then
  compose ps
  exit 0
fi

if (( DO_LOGS )); then
  compose logs -f --tail=100
  exit 0
fi

# ── preflight ────────────────────────────────────────────────────────────
DEMO_RUNNING=0
if [[ -n "$(compose ps --status running -q admin-web 2>/dev/null || true)" ]]; then
  DEMO_RUNNING=1
  echo "✓ demo stack is already running — reusing it"
fi
if (( ! DEMO_RUNNING )); then
  require_free_port "$WEB_PORT" "UI" "--port"
  require_free_port "$API_PORT" "API" "--api-port"
  require_free_port "$EXECUTOR_PORT" "executor" "--executor-port"
  require_free_port "$PY_EXECUTOR_PORT" "python executor" "--python-executor-port"
fi

ADMIN_PW="$(admin_password)"

# ── start ────────────────────────────────────────────────────────────────
if (( DO_BUILD )); then
  echo "→ building images (this can take a few minutes the first time)"
  compose build admin-api admin-web executor-node
fi

echo "→ starting demo stack (project: $PROJECT)"
compose up -d "${SERVICES[@]}"

echo "→ waiting for services (first boot runs DB migrations, ~30-90s)"
wait_url "http://127.0.0.1:$API_PORT/api/health/ready" "admin-api" 240
wait_url "http://127.0.0.1:$WEB_PORT/health" "admin-web" 120
wait_url "http://127.0.0.1:$EXECUTOR_PORT/health" "executor-node" 120
wait_url "http://127.0.0.1:$PY_EXECUTOR_PORT/health" "executor-python" 120

# The executor registers on its first heartbeat; give it a moment before seeding.
sleep 3

# ── seed ─────────────────────────────────────────────────────────────────
if (( DO_SEED )); then
  echo "→ seeding demo tasks + SOPs"
  node "$ROOT/scripts/demo-seed.mjs" \
    --base-url "http://127.0.0.1:$API_PORT" \
    --username admin \
    --password "$ADMIN_PW"
fi

# ── verify: trigger one task end-to-end ──────────────────────────────────
echo "→ triggering demo-hello-fixed and waiting for a terminal state"
ACF_DEMO_BASE="http://127.0.0.1:$API_PORT" \
ACF_DEMO_PASSWORD="$ADMIN_PW" \
node --input-type=module <<'NODE'
const base = process.env.ACF_DEMO_BASE;
const password = process.env.ACF_DEMO_PASSWORD;

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let raw;
  try { raw = JSON.parse(text); } catch { raw = text; }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${String(text).slice(0, 300)}`);
  }
  return raw && typeof raw === "object" && "data" in raw ? raw.data : raw;
}

const login = await api("/api/auth/login", {
  method: "POST",
  body: { username: "admin", password },
});
const token = login?.accessToken;
if (!token) throw new Error("login returned no accessToken");

// Wait for the seeded executor to be online (it may take one heartbeat).
let online = false;
for (let i = 0; i < 30; i += 1) {
  const page = await api("/api/executors?page=1&pageSize=20", { token });
  // GET /executors returns a bare array (the UI filters client-side); other
  // list endpoints use { list, items }. Accept both so this stays robust.
  const rows = Array.isArray(page) ? page : (page?.list ?? page?.items ?? []);
  if (rows.some((e) => e.status === "online")) { online = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!online) throw new Error("no online executor after 60s — check `docker compose logs executor-node`");

const tasksPage = await api("/api/tasks?page=1&pageSize=100", { token });
const tasks = tasksPage?.list ?? tasksPage?.items ?? [];
const task = tasks.find((t) => t.name === "demo-hello-fixed");
if (!task) throw new Error("demo-hello-fixed not found — did scripts/demo-seed.mjs run?");

const exec = await api(`/api/tasks/${task.id}/trigger`, {
  method: "POST",
  token,
  body: {},
});
const executionId = exec?.id;
if (!executionId) throw new Error("trigger returned no execution id");

const terminal = new Set(["success", "failed", "timeout", "killed", "cancelled"]);
let last = "pending";
for (let i = 0; i < 45; i += 1) {
  const page = await api(`/api/tasks/${task.id}/executions?page=1&pageSize=10`, { token });
  const rows = page?.list ?? page?.items ?? [];
  const row = rows.find((r) => r.id === executionId) ?? rows[0];
  if (row) {
    last = row.status;
    if (terminal.has(last)) {
      const duration = row.durationMs ?? row.duration ?? null;
      console.log(`  execution ${executionId}: ${last}${duration == null ? "" : ` in ${duration}ms`}`);
      process.exit(last === "success" ? 0 : 1);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
}
throw new Error(`execution ${executionId} did not finish (last status: ${last})`);
NODE

# ── summary ──────────────────────────────────────────────────────────────
cat <<EOF

────────────────────────────────────────────────────────────
  AutoCodeFlow demo is ready
────────────────────────────────────────────────────────────
  UI        http://localhost:$WEB_PORT
  API docs  http://127.0.0.1:$API_PORT/api/docs
  User      admin
  Password  $ADMIN_PW

  What just happened:
    - 3 demo tasks + 3 demo SOPs were seeded
    - demo-hello-fixed ran once and reached SUCCESS
    - Node + Python executors registered and pulled the job (no inbound port)

  Try next:
    1. Tasks → demo-hello-fixed → Executions → open the latest run
    2. Tasks → demo-fragile → Trigger (a deliberate failure, for the
       failure-reason + AI-analysis flow)
    3. Task templates → "use template" → run it (no code needed)

  Logs   ./scripts/demo.sh --logs
  Stop   ./scripts/demo.sh --down
  Reset  ./scripts/demo.sh --reset
────────────────────────────────────────────────────────────
EOF
