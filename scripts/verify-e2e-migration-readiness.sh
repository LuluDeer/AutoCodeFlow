#!/usr/bin/env bash
#
# verify-e2e-migration-readiness.sh —— e2e 目标库的「迁移就绪」守卫（零依赖：bash + node + pg）。
#
# 背景（真 PG e2e 实证）：commit 成功后 capability_activation_log 0 条，报
# toHaveLength(1) Received []，看起来像代码回归。真因是本地 autoflow_test 库
# 迁移落后（停在 105 / 代码有 107），缺列 → record() 的 save 报 PG
# column does not exist → 被 commit 的 fail-open try/catch 吞掉 → 日志 0 条。
# 补跑 migration:run 后 e2e 即绿（E2E_EXIT=0）。CI 有固定前置（ci.yml:350），本地没有。
#
# 判据：库 migrations 台账行数 == 代码迁移文件数 ⇒ exit 0；否则 exit 1，
# 打印两个数 + 处置命令（npm run migration:run）。DB 连不上/判据不可信 ⇒ exit 2
# 并给可读报错（非栈）。让开发者一眼看到「库落后」而不是 e2e 的假断言。
#
# 口令纪律：只按 key 从 .env 抽取（整文件 source 会被 OIDC_SCOPES=openid profile email
# 炸成 command not found），值只经环境变量传给 node，全程不 echo、不落临时文件。
#
# 用法：
#   bash scripts/verify-e2e-migration-readiness.sh
#   DB_DATABASE=autoflow bash scripts/verify-e2e-migration-readiness.sh   # 反证（库落后）
#
# selftest 注入缝（生产不设）：
#   ACF_E2E_MIG_PG_STUB=<假 pg 模块路径>   ACF_E2E_MIG_CODE_COUNT=<数>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# ── 1. 按 key 抽 .env（范式照抄 verify-capability-migration.sh，不整文件 source）──
load_env_var() {
  local key="$1" line val
  line="$(grep -m1 "^${key}=" "${ROOT}/.env" 2>/dev/null || true)"
  [[ -n "${line}" ]] || return 0
  val="${line#*=}"
  val="${val%$'\r'}"
  if [[ "${val}" == \"*\" || "${val}" == \'*\' ]]; then
    val="${val:1:${#val}-2}"
  fi
  printf '%s' "${val}"
}

DB_HOST="$(load_env_var DB_HOST)"; DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="$(load_env_var DB_PORT)"; DB_PORT="${DB_PORT:-5432}"
DB_USERNAME="$(load_env_var DB_USERNAME)"; DB_USERNAME="${DB_USERNAME:-autoflow}"
DB_PASSWORD="$(load_env_var DB_PASSWORD)"
# e2e 目标库由环境变量决定（e2e-local.sh 会 export DB_DATABASE=autoflow_test）；
# 刻意不读 .env 的 DB_DATABASE（那是业务库 autoflow），缺省 autoflow_test。
DB_DATABASE="${DB_DATABASE:-autoflow_test}"

# ── 2. 代码迁移数：只数真迁移文件 ───────────────────────────────────────────
# TypeORM glob = migrations/*{.ts,.js}，但 migrations.spec.ts / *.d.ts / index.ts
# 不是迁移（无 @Migration class，不进台账）。用「13 位时间戳-类名.ts」精确匹配：
# 真库台账 151 行 == 151 个此类文件；若把 spec 算进来会变成 152 ⇒ 假红。
shopt -s nullglob
MIG_FILES=(apps/admin-api/src/migrations/*.ts)
CODE_COUNT=0
for f in "${MIG_FILES[@]}"; do
  b="$(basename "${f}")"
  [[ "${b}" =~ ^[0-9]{13}-.+\.ts$ ]] && CODE_COUNT=$((CODE_COUNT + 1))
done
# 下界：0 个 = glob/目录改名导致分母塌方，是判据塌方而非「库已就绪」的全绿。
if [[ "${CODE_COUNT}" -eq 0 ]]; then
  printf '✗ 代码迁移数为 0 ⇒ 迁移目录/glob 可能改名（分母塌了，不是就绪）\n' >&2
  exit 2
fi
# selftest 可控夹具：仅在注入时覆盖；生产不设。
if [[ -n "${ACF_E2E_MIG_CODE_COUNT:-}" ]]; then
  CODE_COUNT="${ACF_E2E_MIG_CODE_COUNT}"
fi

# ── 3. 查库台账行数：node + pg（驱动在 apps/admin-api/node_modules）──────────
PG_MODULE="${ROOT}/apps/admin-api/node_modules/pg"
if [[ -n "${ACF_E2E_MIG_PG_STUB:-}" ]]; then
  PG_MODULE="${ACF_E2E_MIG_PG_STUB}"
fi

DB_ERR=""
if DB_COUNT="$(
  ACF_MIG_PG_MODULE="${PG_MODULE}" \
  ACF_MIG_DB_HOST="${DB_HOST}" \
  ACF_MIG_DB_PORT="${DB_PORT}" \
  ACF_MIG_DB_USER="${DB_USERNAME}" \
  ACF_MIG_DB_PASSWORD="${DB_PASSWORD}" \
  ACF_MIG_DB_NAME="${DB_DATABASE}" \
  node - 2>&1 <<'NODE'
let c;
(async () => {
  try {
    const { Client } = require(process.env.ACF_MIG_PG_MODULE);
    c = new Client({
      host: process.env.ACF_MIG_DB_HOST,
      port: Number(process.env.ACF_MIG_DB_PORT || 5432),
      user: process.env.ACF_MIG_DB_USER,
      password: process.env.ACF_MIG_DB_PASSWORD,
      database: process.env.ACF_MIG_DB_NAME,
      connectionTimeoutMillis: 5000,
    });
    await c.connect();
    const r = await c.query("SELECT COUNT(*)::int AS n FROM migrations");
    process.stdout.write(String(r.rows[0].n));
  } catch (e) {
    // 只打一行可读错误；不打 e.stack / console.error(e)，否则栈帧淹没根因。
    const msg = e && e.message ? e.message : String(e);
    process.stderr.write("DB_QUERY_ERROR: " + msg + "\n");
    process.exitCode = 2;
  } finally {
    if (c) await c.end().catch(() => {});
  }
})();
NODE
)"; then
  :
else
  DB_ERR="${DB_COUNT}"
  DB_COUNT=""
fi

if [[ -n "${DB_ERR}" ]]; then
  printf '✗ 读取 e2e 目标库 %s 的迁移台账出错：%s\n' "${DB_DATABASE}" "${DB_ERR}" >&2
  printf '  处置：确认 PG 可达（DB_HOST=%s，DB_PORT=%s）且账号口令正确；口令来自 .env，未打印。\n' \
    "${DB_HOST}" "${DB_PORT}" >&2
  exit 2
fi
if ! [[ "${DB_COUNT}" =~ ^[0-9]+$ ]]; then
  printf '✗ 迁移台账返回非数字（判据不可信）：%s\n' "${DB_COUNT}" >&2
  exit 2
fi

printf 'e2e 迁移就绪守卫：库=%s，库内台账=%s 行，代码迁移=%s 个\n' \
  "${DB_DATABASE}" "${DB_COUNT}" "${CODE_COUNT}"

if [[ "${DB_COUNT}" -eq "${CODE_COUNT}" ]]; then
  printf '✓ e2e 迁移就绪：两数一致，可安全跑 e2e。\n'
  exit 0
fi

printf '✗ e2e 迁移未就绪：库 %s 的 migrations 台账 %s 行 ≠ 代码迁移 %s 个（差 %s）。\n' \
  "${DB_DATABASE}" "${DB_COUNT}" "${CODE_COUNT}" "$((CODE_COUNT - DB_COUNT))" >&2
printf '  这是「读不到 ≠ 没有」的典型：缺列让 record() 的 save 报 column does not exist，\n' >&2
printf '  再被 commit 的 fail-open try/catch 吞掉 ⇒ e2e 报 toHaveLength(1) Received [] 假回归。\n' >&2
printf '  处置：先到 apps/admin-api 目录跑 npm run migration:run，再重跑 e2e。\n' >&2
exit 1
