#!/usr/bin/env bash
# =============================================================================
# ci-local.sh — 本地一条命令复刻 ci.yml 的主要测试 job（⚠️ 非 ci.yml 全部 job）
#
# 覆盖面 = 12 个单测/e2e/audit 等价 job（映射见下表）。已知不覆盖（只在
# ci.yml 真跑）：静态守卫族（check-migrations 门禁 job 及各 guard step）、
# lockfile-integrity、secret-scan、consumer-routes、executor-protocol-drift、
# selftests（arch31/pull/control-plane-pull 等行为自检）、docs-site-build、
# api-types-drift、benchmark、desktop-bundle-drift、docker 镜像构建闸、
# windows/mac 侧 job 与桌面打包/e2e。
#
# 背景（R8）：GitHub push 暂无凭证，远端 CI 无法真跑；本脚本在本地复刻每个
# job 的步骤与 env，保证 push 解锁前主干质量门禁不失效。
#
# 与 CI 的对应关系（job → 本脚本函数）：
#   admin-api-test        → job_admin_api（typecheck + typecheck:specs + lint + coverage）+ job_admin_api_e2e
#   admin-api-migrations  → job_admin_api_e2e 内的 migration 双轮（同库复用）
#   npm-audit             → job_npm_audit（五端 --omit=dev --audit-level=moderate，豁免判定
#                           走 scripts/check-npm-audit-exemptions.mjs＝CI 同一脚本）
#   executor-node-test    → job_executor_node
#   acf-cli-test          → job_acf_cli
#   mcp-server-test       → job_mcp_server
#   autocodeflow-node-sdk-test    → job_autocodeflow_node_sdk
#   admin-web-build       → job_admin_web（lint + lint:i18n + build + `npm test -- --coverage`
#                           四步，与 CI 同序；test 即 vitest run，--coverage 才让覆盖率门生效）
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
#   5. python-packages job：依赖本机全局 pip 环境（四包矩阵直接 import 已装
#      依赖），不像 CI 那样在 job 内独立建 venv/pip install。
#   6. Python 版本未 pin：CI 矩阵固定 3.12，本地用 PATH 上的 python3（可能
#      更高版本）；版本差异导致的测试行为漂移由 CI 真跑兜底。
#
# 已消灭的「差异」（CIR-04，2026-10-29 对齐）：原先此处第 5 条写着「admin-web 的
# vitest 仅本地跑、CI 只有 lint+build」——**该描述已过期**，CI 的 admin-web-build
# 现在也跑 `npm test -- --coverage`（覆盖率门只有带 --coverage 才生效）。同批补齐的是
# 「本地曾漏跑、CI 真跑」的那些步骤：admin-api 的 `npm run typecheck:specs`
# （根 tsconfig 排除 *.spec.ts，spec 里的类型错只在 ts-jest 运行时炸）、
# executor-node / admin-web 的 `npm test -- --coverage`、acf-cli / mcp-server 的
# `npm run build`（其产物守卫执行 dist/ 产物，缺产物会显式失败）+ mcp-server 末尾的
# `scripts/mcp-tools-probe.cjs --check`。本地少跑一步 = 本地全绿而 CI 红。
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
    -h|--help)    sed -n '2,51p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: ${arg}（支持 --skip-e2e --skip-audit --py-deps）"; exit 2 ;;
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
  # CIR-04：根 tsconfig 排除了 `**/*.spec.ts` 与 `__tests__/**`，spec 里的类型错对
  # `npm run typecheck` 不可见，只在 ts-jest 运行时炸成「Test suite failed to run」
  # ——没有断言失败、没有用例名，看起来像环境问题。CI（ci.yml admin-api-test）在
  # typecheck 之后紧跟这一步，本地曾漏跑。
  echo "── typecheck:specs（CI: npm run typecheck:specs；tsconfig.spec.json 覆盖 *.spec.ts）"
  ( cd apps/admin-api && npm run typecheck:specs )
  echo "── lint（CI: npm run lint；本地去 --fix，见头部差异 2）"
  ( cd apps/admin-api && npx eslint "{src,apps,libs,test}/**/*.ts" )
  # CIR-04：阈值取自 apps/admin-api/package.json jest.coverageThreshold（实测值，
  # 2026-10-29 核对）：statements 87 / branches 76 / functions 81 / lines 88。
  # jest 的 coverageThreshold 只在 --coverage 下生效，缺了 --coverage 这道门等于不存在。
  echo "── unit + coverage（CI: npm test -- --coverage；阈值地板 stmts87/branch76/funcs81/lines88）"
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

# ── CI job: npm-audit（五端 prod 依赖链 moderate+ 红灯；阈值与豁免面均对齐（单一事实源脚本））──
# E-32（DEEP_REVIEW 0ef3bbe）：阈值从 high 升到 moderate，与 .github/workflows/ci.yml
# npm-audit job 的 --audit-level=moderate 逐字对齐——此前本地 high 全绿、CI moderate 才红，
# 开发者本地无法提前发现 moderate 级漏洞。矩阵同步补 executor-desktop（CI 矩阵含，本地漏）。
#
# CIR-03（2026-10-29）：阈值对齐了，**判据却没对齐**。本 job 此前直接跑裸 `npm audit`，
# 非零退出即 FAIL；而 CI 的 npm-audit job 对「命中项全部在豁免清单内」是放行的（known=
# 清单 + comm -23 比对）。于是在干净树（命中项全是已裁决豁免）上本地必红、CI 绿，而唯一
# 的应对手段是永远加 --skip-audit —— 整条 audit 面从本地彻底消失。
# 现在豁免判定抽到 scripts/check-npm-audit-exemptions.mjs（**单一事实源**，CI 侧同一
# 脚本），本 job 只负责调用；判据（全豁免=绿 / 未登记=红 / npm 自身失败=红）与 CI 逐字相同。
job_npm_audit() {
  # 一次传入全部 5 个 audit 面（脚本按目录逐个审，任一不过即 exit 1）。
  # 不传 --retries：本地要的是快速失败（CI 传 --retries 3 吸收 registry 偶发 503），
  # 抖一次重跑一遍的成本远低于每次等 30s 退避。
  node scripts/check-npm-audit-exemptions.mjs
}

# ── CI job: executor-node-test（build 即 tsc 全量类型检查）─────────────────
job_executor_node() {
  npm_ci_if_needed apps/executor-node
  ( cd apps/executor-node && npm run build )
  # CIR-04：jest 的 coverageThreshold（apps/executor-node/package.json）只在 --coverage
  # 下生效；CI（ci.yml executor-node-test）传了 --coverage，本地曾裸跑 npm test ⇒
  # 覆盖率门在本地是一道不存在的闸。
  ( cd apps/executor-node && npm test -- --coverage )
}

# ── CI job: acf-cli-test / mcp-server-test ─────────────────────────────────
# CIR-04：两包的测试里都有**读构建产物**的守卫（release-metadata.test.ts 执行
# `node dist/index.js --version`；mcp 的 tools-probe 直接驱动 dist/index.js 走 stdio）。
# 产物缺失时守卫要么显式失败要么静默空转——所以必须先 build，顺序与 CI 一致。
job_acf_cli() {
  npm_ci_if_needed packages/acf-cli
  ( cd packages/acf-cli && npm run typecheck )
  ( cd packages/acf-cli && npm run build )
  ( cd packages/acf-cli && npm test )
}
job_mcp_server() {
  npm_ci_if_needed packages/mcp-server
  ( cd packages/mcp-server && npm run typecheck )
  ( cd packages/mcp-server && npm run build )
  ( cd packages/mcp-server && npm test )
  echo "── mcp tool-surface 守卫（CI: node scripts/mcp-tools-probe.cjs --check；驱动真实 dist/ 走 stdio）"
  node scripts/mcp-tools-probe.cjs --check
}

# ── CI job: autocodeflow-node-sdk-test ──────────────────────────────────────
job_autocodeflow_node_sdk() {
  npm_ci_if_needed packages/autocodeflow-node-sdk
  ( cd packages/autocodeflow-node-sdk && npm test -- --coverage )
}

# ── CI job: admin-web-build（lint + lint:i18n + build + vitest --coverage）──
job_admin_web() {
  npm_ci_if_needed apps/admin-web
  echo "── lint（CI 基线：0 errors / 5 warnings，warnings 不阻塞）"
  ( cd apps/admin-web && npm run lint )
  echo "── lint:i18n（CI: npm run lint:i18n；JSX 里写死中文会让英文界面中英混排）"
  ( cd apps/admin-web && npm run lint:i18n )
  # build 必须先于 test：PERF-01 的 monaco-first-paint 守卫读的是 dist/index.html，
  # 产物缺失时它 skip 而非 fail（本地未构建不该阻塞单测）——顺序反了就是永远绿的空转。
  echo "── build（CI env: VITE_API_URL=http://localhost:3105）"
  ( cd apps/admin-web && VITE_API_URL=http://localhost:3105 npm run build )
  # CIR-04：CI 已加 --coverage（vite.config.ts test.coverage 阈值只有带 --coverage 才生效）；
  # 原先此处裸跑 npm test ⇒ 覆盖率门本地不生效，且头注还写着「CI 没有 test step」。
  echo "── vitest --coverage（CI: npm test -- --coverage）"
  ( cd apps/admin-web && npm test -- --coverage )
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
    echo "── pytest（CI matrix: ${pkg}）"
    ( cd "packages/$pkg" && python3 -m pytest tests/ --tb=short )
  done
}
job_registry_pypi() {
  py_install -r apps/registry-pypi/requirements.txt pytest pytest-asyncio httpx
  ( cd apps/registry-pypi && python3 -m pytest tests/ --tb=short )
}

# ── 调度（顺序与 ci.yml job 声明顺序一致）─────────────────────────────────
echo "AutoCodeFlow ci-local — 本地等价 CI（root: ${ROOT}）"
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
