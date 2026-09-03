#!/usr/bin/env bash
# =============================================================================
# ci-local.sh — 本地一条命令等价跑 .github/workflows/ci.yml 的全部 CI job
#
# 背景（R8）：GitHub push 暂无凭证，远端 CI 无法真跑；本脚本在本地复刻每个
# job 的步骤与 env，保证 push 解锁前主干质量门禁不失效。
#
# 与 CI 的对应关系（job → 本脚本函数）：
#   admin-api-test        → job_admin_api（typecheck/lint/coverage）+ job_admin_api_e2e
#   admin-api-migrations  → job_admin_api_e2e 内的 migration 双轮（同库复用）
#   npm-audit             → job_npm_audit（四端 --omit=dev --audit-level=high）
#   executor-node-test    → job_executor_node
#   acf-cli-test          → job_acf_cli
#   mcp-server-test       → job_mcp_server
#   autoflow-sdk-node-test        → job_autoflow_sdk_node
#   autocodeflow-node-sdk-test    → job_autocodeflow_node_sdk
#   admin-web-build       → job_admin_web（CI 只有 lint+build；本脚本按 R8 要求
#                           追加 vitest——admin-web 的 test 脚本即 vitest run）
#   executor-python-test  → job_executor_python
#   autoflow-sdk-python-test      → job_autoflow_sdk_python
#   python-packages-test  → job_python_packages（http/notify/db/ai 四包矩阵）
#   registry-pypi-test    → job_registry_pypi
#
# 与 CI 的有意差异（本地化）：
#   1. npm ci：node_modules 已存在时跳过（CI 每次全新安装；本地重装耗时）。
#   2. admin-api lint：CI 的 `npm run lint` 带 --fix 会改写工作区，本地改用
#      等价 glob 的只读 eslint（0 errors 门禁不变）。
#   3. Python 依赖：默认假设本机环境已装好（与仓库现状一致）；加 --py-deps
#      则先执行 CI 等价的 pip install 步骤。
#   4. e2e/migration 的 PG/Redis：CI 用 services（5432/6379），本地用一次性
#      docker 容器 + 高位端口（默认 15432/16379），跑完即删，不碰本机 dev 库。
#   5. admin-web vitest：仅本地跑——CI 的 admin-web-build job 只有 lint+build
#      两步，没有 test step（vitest 是 R8 本地追加的加强门禁，非 CI 等价项）。
#   6. python-packages job：依赖本机全局 pip 环境（四包矩阵直接 import 已装
#      依赖），不像 CI 那样在 job 内独立建 venv/pip install。
#   7. Python 版本未 pin：CI 矩阵固定 3.12，本地用 PATH 上的 python3（可能
#      更高版本）；版本差异导致的测试行为漂移由 CI 真跑兜底。
#
# 用法:
#   bash scripts/ci-local.sh                    # 全量（含 e2e 与 audit）
#   bash scripts/ci-local.sh --skip-e2e         # 跳过需要 docker 的 e2e/migration
#   bash scripts/ci-local.sh --skip-audit       # 跳过 npm audit（离线/内网场景）
#   bash scripts/ci-local.sh --skip-e2e --skip-audit   # 快速模式
#   bash scripts/ci-local.sh --py-deps          # Python job 前执行 pip install
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_E2E=0
SKIP_AUDIT=0
PY_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --skip-e2e)   SKIP_E2E=1 ;;
    --skip-audit) SKIP_AUDIT=1 ;;
    --py-deps)    PY_DEPS=1 ;;
    -h|--help)    sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg（支持 --skip-e2e --skip-audit --py-deps）"; exit 2 ;;
  esac
done

# ── e2e 一次性容器（对应 CI services 的 env，见 ci.yml admin-api-test 节）──
PG_PORT="${CILOCAL_PG_PORT:-15432}"
REDIS_PORT="${CILOCAL_REDIS_PORT:-16379}"
PG_CONTAINER=acf-ci-local-pg
REDIS_CONTAINER=acf-ci-local-redis
# 与 ci.yml env 块逐一对齐（测试专用值，非生产机密）
E2E_ENV=(
  "NODE_ENV=development"
  "DB_HOST=localhost" "DB_PORT=$PG_PORT"
  "DB_USERNAME=autoflow" "DB_PASSWORD=test" "DB_DATABASE=autoflow_test"
  "REDIS_HOST=localhost" "REDIS_PORT=$REDIS_PORT"
  "JWT_SECRET=test-jwt-secret-32chars-long-here"
  "JWT_REFRESH_SECRET=test-refresh-secret-32chars-long"
  "EXECUTOR_SECRET=test-executor-secret"
  "INITIAL_ADMIN_USERNAME=admin" "INITIAL_ADMIN_PASSWORD=admin123"
  "AI_PROVIDER=disabled"
)

declare -a JOB_NAMES=() JOB_STATUS=() JOB_SECS=()
FAILED=0

# run_job <名称> <函数>：执行 job 函数（函数内 set -e，任一 step 失败即 FAIL），
# 记录耗时与结果；不中断其余 job（对应 CI 各 job 相互独立）。
run_job() {
  local name="$1" fn="$2"
  echo ""
  echo "══════════════════════════════════════════════════════════"
  echo "▶ JOB: $name"
  echo "══════════════════════════════════════════════════════════"
  local start=$SECONDS status
  if ( set -e; "$fn" ); then
    status="PASS"
  else
    status="FAIL"
    FAILED=1
  fi
  JOB_NAMES+=("$name"); JOB_STATUS+=("$status"); JOB_SECS+=("$(( SECONDS - start ))s")
  echo "◀ JOB $name → $status ($(( SECONDS - start ))s)"
}

# npm ci 等价步骤：node_modules 存在则跳过（见头部「有意差异」1）。
npm_ci_if_needed() {
  local dir="$1"
  if [[ -d "$dir/node_modules" ]]; then
    echo "[ci-local] $dir/node_modules 已存在，跳过 npm ci"
  else
    ( cd "$dir" && npm ci )
  fi
}

# pip 安装步骤（仅 --py-deps 时执行，对应 CI 的 pip install 行）。
py_install() {
  if [[ "$PY_DEPS" == "1" ]]; then
    python3 -m pip install -q "$@"
  fi
}

# ── CI job: admin-api-test（非 e2e 部分）───────────────────────────────────
job_admin_api() {
  npm_ci_if_needed apps/admin-api
  echo "── typecheck（CI: npm run typecheck）"
  ( cd apps/admin-api && npm run typecheck )
  echo "── lint（CI: npm run lint；本地去 --fix，见头部差异 2）"
  ( cd apps/admin-api && npx eslint "{src,apps,libs,test}/**/*.ts" )
  echo "── unit + coverage（CI: npm test -- --coverage；阈值地板 stmts68/branch58/funcs56/lines69）"
  ( cd apps/admin-api && npm test -- --coverage )
}

# ── CI job: admin-api-test 的 e2e 步骤 + admin-api-migrations ──────────────
# 一次性 docker PG16/Redis7（高位端口），migration 双轮 + e2e --runInBand，
# 跑完清理。对应 ci.yml 的 services + "Apply migrations for e2e" +
# "E2E (auth / executors / tasks)" + 迁移链幂等守卫。
start_infra() {
  command -v docker >/dev/null || { echo "docker 不可用，无法跑 e2e"; return 1; }
  docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" -p "$PG_PORT":5432 \
    -e POSTGRES_USER=autoflow -e POSTGRES_PASSWORD=test -e POSTGRES_DB=autoflow_test \
    postgres:16-alpine >/dev/null
  docker run -d --name "$REDIS_CONTAINER" -p "$REDIS_PORT":6379 redis:7-alpine >/dev/null
  local i
  for i in $(seq 1 60); do
    if docker exec "$PG_CONTAINER" pg_isready -U autoflow >/dev/null 2>&1; then break; fi
    if [[ $i == 60 ]]; then echo "PG 未在 60s 内就绪"; return 1; fi
    sleep 1
  done
  for i in $(seq 1 30); do
    if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then break; fi
    if [[ $i == 30 ]]; then echo "Redis 未在 30s 内就绪"; return 1; fi
    sleep 1
  done
}
stop_infra() {
  docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
}

job_admin_api_e2e() {
  # EXIT trap 在 run_job 的子 shell 内生效：即使 set -e 中途失败退出也会清理。
  trap stop_infra EXIT
  start_infra
  npm_ci_if_needed apps/admin-api
  echo "── migration:run 第一轮（空库全链建表；CI: Apply migrations for e2e）"
  ( cd apps/admin-api && env "${E2E_ENV[@]}" npm run migration:run )
  echo "── e2e（CI: npm run test:e2e -- --runInBand；串行消除 admin seed 竞态）"
  ( cd apps/admin-api && env "${E2E_ENV[@]}" npm run test:e2e -- --runInBand )
  echo "── migration:run 第二轮（CI admin-api-migrations 幂等守卫：必须 no-op）"
  local out
  out=$( cd apps/admin-api && env "${E2E_ENV[@]}" npm run migration:run 2>&1 )
  echo "$out" | tail -3
  echo "$out" | grep -q "No migrations are pending" \
    || { echo "second migration:run was not a no-op"; return 1; }
}

# ── CI job: npm-audit（四端 prod 依赖链 high+ 红灯）────────────────────────
job_npm_audit() {
  local p
  for p in apps/admin-api apps/executor-node packages/acf-cli packages/mcp-server; do
    echo "── npm audit（CI matrix: $p）"
    ( cd "$p" && npm audit --registry=https://registry.npmjs.org --omit=dev --audit-level=high )
  done
}

# ── CI job: executor-node-test（build 即 tsc 全量类型检查）─────────────────
job_executor_node() {
  npm_ci_if_needed apps/executor-node
  ( cd apps/executor-node && npm run build )
  ( cd apps/executor-node && npm test )
}

# ── CI job: acf-cli-test / mcp-server-test ─────────────────────────────────
job_acf_cli() {
  npm_ci_if_needed packages/acf-cli
  ( cd packages/acf-cli && npm run typecheck )
  ( cd packages/acf-cli && npm test )
}
job_mcp_server() {
  npm_ci_if_needed packages/mcp-server
  ( cd packages/mcp-server && npm run typecheck )
  ( cd packages/mcp-server && npm test )
}

# ── CI job: autoflow-sdk-node-test / autocodeflow-node-sdk-test ────────────
job_autoflow_sdk_node() {
  npm_ci_if_needed packages/autoflow-sdk-node
  ( cd packages/autoflow-sdk-node && npm test -- --coverage )
}
job_autocodeflow_node_sdk() {
  npm_ci_if_needed packages/autocodeflow-node-sdk
  ( cd packages/autocodeflow-node-sdk && npm test -- --coverage )
}

# ── CI job: admin-web-build（+ R8 要求的 vitest）───────────────────────────
job_admin_web() {
  npm_ci_if_needed apps/admin-web
  echo "── lint（CI 基线：0 errors / 5 warnings，warnings 不阻塞）"
  ( cd apps/admin-web && npm run lint )
  echo "── build（CI env: VITE_API_URL=http://localhost:3105）"
  ( cd apps/admin-web && VITE_API_URL=http://localhost:3105 npm run build )
  echo "── vitest（R8 追加：test 脚本即 vitest run）"
  ( cd apps/admin-web && npm test )
}

# ── Python jobs（默认复用本机已装依赖；--py-deps 走 CI 的 pip install）────
job_executor_python() {
  py_install -r apps/executor-python/requirements.txt pytest pytest-cov httpx pytest-asyncio
  ( cd apps/executor-python && python3 -m pytest --tb=short )
}
job_autoflow_sdk_python() {
  py_install -e "packages/autoflow-sdk[dev]"
  ( cd packages/autoflow-sdk && python3 -m pytest --tb=short )
}
job_python_packages() {
  local pkg
  py_install pytest pytest-asyncio httpx
  for pkg in autocodeflow-http autocodeflow-notify autocodeflow-db autocodeflow-ai; do
    echo "── pytest（CI matrix: $pkg）"
    ( cd "packages/$pkg" && python3 -m pytest tests/ --tb=short )
  done
}
job_registry_pypi() {
  py_install -r apps/registry-pypi/requirements.txt pytest pytest-asyncio httpx
  ( cd apps/registry-pypi && python3 -m pytest tests/ --tb=short )
}

# ── 调度（顺序与 ci.yml job 声明顺序一致）─────────────────────────────────
echo "AutoCodeFlow ci-local — 本地等价 CI（root: $ROOT）"
[[ "$SKIP_E2E" == "1" ]]   && echo "[模式] 跳过 e2e/migration（--skip-e2e）"
[[ "$SKIP_AUDIT" == "1" ]] && echo "[模式] 跳过 npm audit（--skip-audit）"

run_job "admin-api"            job_admin_api
if [[ "$SKIP_E2E" == "0" ]]; then
  run_job "admin-api-e2e"      job_admin_api_e2e
else
  echo ""; echo "⏭  跳过 admin-api-e2e（--skip-e2e）"
fi
if [[ "$SKIP_AUDIT" == "0" ]]; then
  run_job "npm-audit"          job_npm_audit
else
  echo ""; echo "⏭  跳过 npm-audit（--skip-audit）"
fi
run_job "executor-node"        job_executor_node
run_job "acf-cli"              job_acf_cli
run_job "mcp-server"           job_mcp_server
run_job "autoflow-sdk-node"    job_autoflow_sdk_node
run_job "autocodeflow-node-sdk" job_autocodeflow_node_sdk
run_job "admin-web"            job_admin_web
run_job "executor-python"      job_executor_python
run_job "autoflow-sdk-python"  job_autoflow_sdk_python
run_job "python-packages"      job_python_packages
run_job "registry-pypi"        job_registry_pypi

# ── 汇总表 ──────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════ JOB SUMMARY ════════════════════════"
printf "%-24s %-6s %8s\n" "JOB" "RESULT" "TIME"
printf -- "------------------------------------------------------------\n"
i=0
while [[ $i -lt ${#JOB_NAMES[@]} ]]; do
  printf "%-24s %-6s %8s\n" "${JOB_NAMES[$i]}" "${JOB_STATUS[$i]}" "${JOB_SECS[$i]}"
  i=$(( i + 1 ))
done
printf "════════════════════════════════════════════════════════════\n"
if [[ "$FAILED" == "1" ]]; then
  echo "❌ 存在 FAIL job"
  exit 1
fi
echo "✅ 全部 job PASS"
