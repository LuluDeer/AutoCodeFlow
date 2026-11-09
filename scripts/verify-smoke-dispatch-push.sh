#!/usr/bin/env bash
#
# verify-smoke-dispatch-push.sh —— 场景 9：`dispatch` 的 **push 传输分支**真机验证。
#
# ## 为什么有这个脚本（补的是台账里登记的 4 项缺口之一）
#
# 第八轮的 `verify-smoke-dispatch.sh` 把排序 / 偏好分区 / `scoredSnapshot` / 重复派发
# 抑制 / 三条失败出口都真机验了，但它的执行器**全部是 `dispatchMode='pull'`**
# （见该脚本头注「关键实现选择 1」与 `docs/VERIFY-MATRIX.md` §7.3 未验证项）——
# 因为 push 分支的三件事都发生在**传输层**，而当时没有可用的「真监听」执行器：
#
#   · HTTP POST 到 `api/execute`（真的发出去、载荷形状、鉴权头）
#   · SSRF pinning（`assertAndPinExecutorUrl` + `pinnedAxiosConfig`）
#   · 失败路径的**槽位补偿**（`compensateClaimedSlot`：减计数 + 清互斥标记）
#
# 当时失败的姿势是「从**容器内**连**宿主**的 `172.26.0.1` / `172.17.0.1`」——
# NAT 网关地址在容器里实测 `CONNECT_TIMEOUT`（不是 SSRF 拒绝，是网络不通）。
# 本脚本换的是**拓扑**而不是断言：让假执行器**也跑在同一个 compose 网络里**
# （一个容器），admin-api 用**容器名**就能连上 ⇒ push 分支第一次真的跑起来。
#
# ## 五个场景（逐条对应本轮任务书）
#
#   B1 真的发出 HTTP 请求（假执行器侧记录：次数 / 路径 / 方法 / 头 / body 关键字段），
#      且 admin 把执行器的 2xx 响应体**存进执行行 `result`** ⇒ 传输闭合
#   B2 失败路径 ①：执行器回 **500** ⇒ 占坑回滚 + 执行落 `failed` + `failureReason`
#   B3 失败路径 ②：执行器**直接关连接**（`req.socket.destroy()`）⇒ 同样回滚
#   B4 **SSRF 默认姿态**：地址 = admin-api 容器自己的**私网 IP**:8002 ⇒ 守卫在
#      **发请求之前**拒绝（监听侧收到 **0 次**请求 ⇒ 不是「连不上」而是「没发」）
#   B5 **`EXECUTOR_ALLOW_PRIVATE_NETWORK=true`** ⇒ 同一地址**放通**（收到 1 次）
#
#   ⚠️ R05（2026-11-05）语义修正：B4/B5 的取样地址从 **loopback** 改成**私网 IP**。
#      契约（`packages/executor-protocol/protocol.json`）写的是
#      `loopback.allowedUnderPrivateNetwork=false` + `switch.semantics`「开关开启 ⇒ 放行
#      privateIPv4；其余五类一律仍拒」⇒ **loopback 在两种开关状态下都拒**，用 loopback
#      根本测不出开关效果；旧实现却把 loopback 放进解锁组（`grid:loopback@on:admin`）⇒
#      旧脚本以「运行时实测」为准写成 loopback 是对的**归因**、错的**期望**。
#
# ## ⚠️ 关键实现选择 1：假执行器是**同一 compose 网络里的一个容器**
#
# `docker run -d --name acfsmoke-fakeexec --network <smoke-net> node:24-alpine
#  node /fakeexec.js`，监听 `0.0.0.0:8002`，由**内联 JS**（本脚本写进
# `/tmp/acf-smoke-dispatch-push-fakeexec.js` 再 `-v` 挂进容器）实现。
# 契约照**真实执行器源码**抄，不猜：
#   · 路由 `POST /api/execute`（`apps/executor-node/src/routes/execute.ts`
#     的 `executeRouter.post('/execute')`）
#   · 成功响应体 `{status:'accepted', executionId}`（同文件 `acceptExecution`
#     的 `return { status: 200, payload: { status: 'accepted', executionId } }`
#     ——注释原文「响应体与旧实现逐字一致——admin 对 2xx 的处理不变」）
#   · 鉴权头 `Authorization: Bearer <共享令牌>`（admin 侧 `executor.service.ts`
#     的 `if (sharedToken) headers["Authorization"] = ...`；共享令牌 = 栈的
#     `EXECUTOR_SECRET`，本脚本经 `-e EXPECTED_TOKEN` 交给假执行器**只做等值
#     比较**，不回显明文）
#   · 载荷 `{executionId, task, params, secrets}`（同处 `axios.post(url, {...})`）
#   · **没有** `Idempotency-Key` 之类的重试幂等头（全仓 `apps/admin-api/src`
#     搜 `Idempotency` 零命中）——脚本**如实打印**「无此头」，不伪造断言
#
# ## ⚠️ 关键实现选择 2：SSRF 断言按**契约 + 运行时**双重对齐（R05 起四方一致）
#
# `apps/admin-api/src/common/utils/safe-http.util.ts` 的执行器姿态**自 R05 起与契约逐格一致**：
# `allowedExecutor = public | (flag && private-lan)` —— 私网段（10/8、172.16/12、192.168/16）
# **需要开关才放行**；loopback / link-local / restricted / unspecified / multicast / reserved
# **任何开关状态都拒**。⇒ 与 `docs/api-reference.md`、契约 `switch.semantics`、node/python
# 两侧**四方一致**（R05 之前 admin 是唯一离群者）。因此：
#   · B1–B3 用容器名（解析到 172.x 私网）⇒ **必须带开关**才发得出去 ⇒ 本栈的 admin-api
#     **默认就带** `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`（根 compose 的 admin-api 服务同样如此）；
#   · B4/B5 用同一个**私网**地址、只切开关 ⇒ 默认拒 / 开关放通 = 开关的**唯一**效果 ✅
#   · loopback **不再是**开关的效果（契约 `loopback.allowedUnderPrivateNetwork=false`），
#     故不再作为取样地址。
#
# ## ⚠️ 关键实现选择 3：开关两条态靠**重建 admin-api 容器**（不改任何文件）
#
# `EXECUTOR_ALLOW_PRIVATE_NETWORK` 是进程级 env，改它必须重启进程。隔离栈的
# admin-api 是 `verify-smoke-stack.sh` 里一条 `docker run` 起的（不是 compose），
# 故本脚本：
#   ① 起手把**原始容器**的 `Config.Env` / `HostConfig.Binds` / `PortBindings` /
#      `NetworkMode` / `Config.Image` 全部 `docker inspect` 抓下来；
#   ② 需要开关时 `docker rm -f` 后**按抓下来的配置原样重建**，只追加一个 env；
#   ③ **自校验**：重建后 env 集合与原始快照的 diff **必须恰好是**
#      `> EXECUTOR_ALLOW_PRIVATE_NETWORK=true` 一行 —— 多出/少了任何一行
#      就判 FAIL（防「重建时悄悄丢了某个 env」这种最难查的假绿）；
#   ④ 末尾**恢复**：过滤掉该 env 重建一次，diff **必须为空**。
#   ⚠️ 这是「磁盘零改动」的代价：admin-api 的启动参数在这里**有第二份副本**
#   （来源是 inspect 而非手抄 ⇒ 不会与 stack.sh 漂移，因为原容器是它起的）。
#
# ## ⚠️ 关键实现选择 4：B4/B5 用**同一地址**、只改开关 ⇒ 归因不含歧义
#
# 两次都是 `<admin-api 容器私网 IP>:8002`，区别**只有**开关。B4 监听器收到 0 次请求
# （守卫在 `axios.post` 之前抛 `SSRF_HOST_DENIED_PINNED`）⇒ 不是网络不通、不是地址写错；
# B5 收到 1 次 ⇒ 放通。监听器由 `docker exec -d` 在 **admin-api 容器内**起同一份 JS，
# `FAKE_BIND` 绑到容器自己的私网 IP（R05 起不再绑 127.0.0.1）。
# 注意：私网地址**不能**用 loopback 代替 —— 契约下 loopback 两态都拒，就没有「放通」那一态。
#
# ## 可重入
#
# 步骤 0a **跑前清理**：按 `tasks.name` / `executors."appName"` /
# `applications.name` 的确定性前缀 `smoke-dpush-` 删本脚本自己造的那批数据
# （子表按本前缀任务 id 反查），并**验证清理生效**（三查计数 = 0）；
# 同时 `docker rm -f` 上一轮可能残留的假执行器容器 + 删 `/tmp` 中间文件。
# ⇒ 「上次跑到一半失败」能被下次自动修复；连跑两次都 PASS。
#
# ## 时区纪律
#
# 一切时间比较都用 **DB 侧** `now()`；本脚本把 `lastHeartbeat` 也写成 `now()`
# （DB 侧），不用宿主 `date`（宿主 CST / 容器 UTC）。
#
# ## 残留四查
#
# 容器 / 网络 / 卷 / 端口：假执行器**不发布任何宿主端口**（8002 只在网络内），
# 步骤 8 断言「`acfsmoke` 前缀的容器仍是栈自己那 3 个」「网络仍只有 1 个」
# 「宿主 8002 无监听」「`/tmp` 中间文件已删」。
#
# 用法：
#   ACF_SMOKE_ENV_FILE=/tmp/acf-smoke-env.sh ./scripts/verify-smoke-dispatch-push.sh
#   # 或经统一入口：./scripts/verify-smoke-all.sh --only=r5-dispatch-push
#
# 前置：`scripts/verify-smoke-stack.sh up`（已起栈）+ 镜像**本仓当前源码**构建。
#
# 退出码：0 = 全部断言通过；1 = 有断言失败。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ACF_SMOKE_ENV_FILE:-/tmp/acf-smoke-env.sh}"
[[ -f "$ENV_FILE" ]] || { echo "✗ $ENV_FILE not found — run scripts/verify-smoke-stack.sh up first" >&2; exit 2; }
# shellcheck disable=SC1090
source "$ENV_FILE"
# shellcheck disable=SC1091
source "$ROOT/scripts/verify-smoke-common.sh"

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step(){ printf '\n=== %s ===\n' "$*"; }

API="http://127.0.0.1:${SMOKE_API_PORT}/api"
# 本脚本全部持久状态都落在这个前缀下（tasks.name / applications.name /
# executors."appName"）⇒ 清理与断言都只碰自己的数据。
PREFIX="smoke-dpush-"
PAT="${PREFIX}%"

# 假执行器（push 正式场景：同一 compose 网络里的容器）
FE_NAME="${SMOKE_STACK}-fakeexec"
FE_IMG="node:24-alpine"
FE_PORT=8002
FE_ADDR="${FE_NAME}:${FE_PORT}"
# 假执行器（SSRF 场景：admin-api 容器**内部**的监听，绑容器自己的**私网 IP**；同一份 JS）
# R05：取样地址必须是**私网** —— 契约下 loopback 两态都拒，测不出开关效果。
API_PRIV_IP=""
SSRF_ADDR=""
resolve_ssrf_addr() {
  API_PRIV_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
    "$SMOKE_API_CONTAINER" 2>/dev/null | head -1)"
  [[ -n "$API_PRIV_IP" ]] || return 1
  SSRF_ADDR="${API_PRIV_IP}:${FE_PORT}"
  return 0
}

FE_JS="/tmp/acf-smoke-dispatch-push-fakeexec.js"
API_JS="/tmp/acf-smoke-dispatch-push-fakeexec-api.js"
ENV_SNAP="/tmp/acf-smoke-dispatch-push-env-before.txt"
TRIG_JSON="/tmp/acf-smoke-dispatch-push-trig.json"

API_TOUCHED=0      # 1 = 本脚本重建过 admin-api
API_FLAG_STATE=0   # 0 = 无开关  1 = 带 EXECUTOR_ALLOW_PRIVATE_NETWORK=true

psql_q() { smoke_psql_q "$1"; }
api_logs() { docker logs "$SMOKE_API_CONTAINER" 2>&1; }

# 决策日志：按 **executionId** 过滤（`docker logs` 是容器全生命周期累积输出 ⇒
# 按任务名统计会跨轮次污染；executionId 每轮新建 ⇒ 天然隔离）。
decision_log_of() {
  local eid="${1:?need executionId}"
  api_logs | grep -F 'dispatch.decision' | grep -F "${eid}" | tail -1 \
    | jq -c '.message | fromjson' 2>/dev/null || true
}
lj() {
  local js="${1:-}" expr="${2:?need jq expr}"
  [[ -n "$js" ]] || { printf ''; return 0; }
  printf '%s' "$js" | jq -r "$expr" 2>/dev/null || printf ''
}

# ── 假执行器容器 / 监听器的生命周期（退出时无论如何都收）────────────────
cleanup_fake() {
  docker rm -f "$FE_NAME" >/dev/null 2>&1 || true
  rm -f "$FE_JS" "$API_JS" "$TRIG_JSON" "${ENV_SNAP}" "${ENV_SNAP}".after "${ENV_SNAP}".restored \
    "${ENV_SNAP}".before5
}

restore_api_env() {
  # R05：栈默认**带** EXECUTOR_ALLOW_PRIVATE_NETWORK=true（B1–B3 的私网派发需要）
  # ⇒ 恢复 = 回到带开关的原始形态（不是摘掉）。
  recreate_api 1 >/dev/null 2>&1 || true
  wait_api_health >/dev/null 2>&1 || true
  API_FLAG_STATE=0
}

on_exit() {
  local rc=$?
  if [[ "${API_TOUCHED}" == "1" && "${API_FLAG_STATE}" != "1" ]]; then
    printf '  · 退出清理：把 admin-api 还原为原始 env（去掉 EXECUTOR_ALLOW_PRIVATE_NETWORK）\n'
    restore_api_env
  fi
  cleanup_fake
  return "$rc"
}
trap on_exit EXIT

# ── 0a. 跑前清理（幂等的前提）─────────────────────────────────────────────
step "0a. 跑前清理（只删本脚本自己造的 smoke-dpush-* 数据 + 上一轮的假执行器）"
clean_own_rows() {
  # 子表优先：部署行 → 应用 → 执行器（每句都带 WHERE 前缀，绝不整表删）
  psql_q "delete from app_deployments where \"applicationId\" in (select id from applications where name like '${PAT}');" >/dev/null
  psql_q "delete from applications where name like '${PAT}';" >/dev/null
  psql_q "delete from executors where \"appName\" like '${PAT}';" >/dev/null
  local apps execs
  apps="$(psql_q "select count(*) from applications where name like '${PAT}';")"
  execs="$(psql_q "select count(*) from executors where \"appName\" like '${PAT}';")"
  [[ "$apps" == "0" && "$execs" == "0" ]]
}
db_residual() {
  local t e a
  t="$(psql_q "select count(*) from tasks where name like '${PAT}';")"
  e="$(psql_q "select count(*) from executors where \"appName\" like '${PAT}';")"
  a="$(psql_q "select count(*) from applications where name like '${PAT}';")"
  printf '%s/%s/%s' "$t" "$e" "$a"
}

docker rm -f "$FE_NAME" >/dev/null 2>&1 || true
rm -f "$FE_JS" "$API_JS" "$TRIG_JSON"
if smoke_preclean_tasks "$PREFIX" "本脚本的任务：smoke-dpush-ok / -fail500 / -abort / -ssrf / -ssrf-allow"; then
  ok "tasks 跑前清理完成（本前缀残留 = 0）"
else
  bad "tasks 跑前清理失败 ⇒ 中止（不带着脏数据继续跑）"
  exit 1
fi
if clean_own_rows; then
  ok "执行器 / 应用 / 部署行跑前清理完成（两查残留 = 0）"
else
  bad "执行器 / 应用 / 部署行跑前清理失败（残留非 0）⇒ 中止"
  exit 1
fi
DB_RES_PRE="$(db_residual)"
[[ "$DB_RES_PRE" == "0/0/0" ]] \
  && ok "DB 三查残留在跑前 = ${DB_RES_PRE}（tasks/executors/applications）" \
  || bad "DB 三查残留在跑前非零：${DB_RES_PRE}"

# ── 0b. 镜像与 /app/dist 核实（否则测的是旧代码 = 假通过）────────────────
step "0b. 镜像重建核实 + /app/dist 是否为当前源码"
# 镜像是否包含当前源码：判据用 **git 内容**而不是文件 mtime。
# ⚠️ 为什么不用 mtime（`verify-smoke-dispatch.sh` 的写法）：本仓是**多 agent 共用
#    工作区**，任何一次「内容相同但重写一遍」的落盘（生成器 / 另一个会话）都会把
#    `apps/admin-api/src` 的 mtime 顶到最新 ⇒ mtime 断言**假红**（本轮实测踩到：
#    00:13 有文件被同内容重写，git status 干净，mtime 断言却红）。内容判据：
#      · 工作区对 apps/admin-api 有**未提交改动** ⇒ 镜像内容不可信 ⇒ 红；
#      · 镜像 Created 晚于「最后一次改动 apps/admin-api 的提交时间」⇒ 绿。
IMG_CREATED="$(docker image inspect -f '{{.Created}}' "$SMOKE_IMAGE" 2>/dev/null || true)"
IMG_EPOCH="$(date -d "$IMG_CREATED" +%s 2>/dev/null || echo 0)"
LAST_COMMIT_EPOCH="$(git log -1 --format=%ct -- apps/admin-api 2>/dev/null || echo 0)"
SRC_MTIME_EPOCH="$(find "$ROOT/apps/admin-api/src" -type f -name '*.ts' -printf '%T@\n' | sort -n | tail -1 | cut -d. -f1)"
SRC_DIRTY="$(git status --porcelain -- apps/admin-api 2>/dev/null | head -5)"
echo "    | 镜像 Created=${IMG_CREATED}(epoch=${IMG_EPOCH})；apps/admin-api 最后提交 epoch=${LAST_COMMIT_EPOCH}；src 最新 mtime epoch=${SRC_MTIME_EPOCH}（仅信息，不作判据）"
if [[ -n "$SRC_DIRTY" ]]; then
  bad "apps/admin-api 有未提交改动 ⇒ 镜像内容不可信（先提交/还原再跑）：$(printf '%s' "$SRC_DIRTY" | head -3 | tr '\n' ' ')"
elif [[ "$IMG_EPOCH" -ge "$LAST_COMMIT_EPOCH" && "$IMG_EPOCH" -gt 0 ]]; then
  ok "镜像 ${SMOKE_IMAGE} 晚于「最后一次改动 apps/admin-api 的提交」且工作区干净 ⇒ 镜像包含当前源码"
else
  bad "镜像 Created (epoch=${IMG_EPOCH}) 早于 apps/admin-api 最后提交 (epoch=${LAST_COMMIT_EPOCH}) ⇒ 测的是旧代码（重跑 verify-smoke-stack.sh up 且不要设 ACF_SMOKE_SKIP_BUILD=1）"
fi
# 本场景要的三处实现必须真的进镜像（否则「push 分支验过了」只是自我安慰）
DIST_SERVICE="/app/dist/modules/executor/executor.service.js"
# ⚠️ SSRF 的拒绝文案**不在** safe-http.util 里：守卫抛的是错误码，zh/en 文案在
# 错误目录 `common/errors/catalog/application.ts`（`SSRF_HOST_DENIED_PINNED` 的
# `zh` 才是「…— 已拒绝对外请求」）。第一版把标记指到 safe-http.util 上，实测
# 命中 0 ⇒ 是本脚本自己的判据写错，不是 dist 不同源（本轮已修）。
DIST_CATALOG="/app/dist/common/errors/catalog/application.js"
for pair in "${DIST_SERVICE}|compensateClaimedSlot" "${DIST_SERVICE}|assertAndPinExecutorUrl" "${DIST_CATALOG}|已拒绝对外请求"; do
  f="${pair%%|*}"; marker="${pair#*|}"
  # ⚠️ `grep -c` 命中 0 时**仍会打印 0 并 exit 1** ⇒ 不能写 `|| echo 0`
  #（那样变量会变成两行 "0\n0" ⇒ `[[ 0\n0 -gt 0 ]]` 直接语法错，本轮实测踩到）。
  n="$(docker exec "$SMOKE_API_CONTAINER" grep -c -- "$marker" "$f" 2>/dev/null || true)"
  n="${n:-0}"
  if [[ "${n}" -gt 0 ]]; then
    ok "/app/dist 含实现标记「${marker}」（$(basename "$f") 命中 ${n} 处）"
  else
    bad "/app/dist 缺实现标记「${marker}」（${f}）⇒ dist 与 src 不同源"
  fi
done
if docker image inspect "$FE_IMG" >/dev/null 2>&1; then
  ok "假执行器基础镜像 ${FE_IMG} 在本机可用"
else
  bad "假执行器基础镜像 ${FE_IMG} 不在本机 ⇒ 先 docker pull ${FE_IMG}"
fi

# ── 0c. 起假执行器容器（同一 compose 网络）───────────────────────────────
step "0c. 起假执行器容器（${FE_NAME}，${FE_IMG}，网络 ${SMOKE_NET}，监听 0.0.0.0:${FE_PORT}）"
cat >"$FE_JS" <<'FAKEEXEC_JS'
// verify-smoke-dispatch-push 的假执行器（**契约照 apps/executor-node 抄**）。
// 只实现 push 分支需要的面：POST /api/execute（+ 状态/控制端点）。
// 不执行任何用户代码 —— 它存在的意义是「证明 admin 真的把请求发出来了，
// 以及失败时 admin 会不会把占坑回滚」。
const http = require("http");
const PORT = Number(process.env.FAKE_PORT || 8002);
const BIND = process.env.FAKE_BIND || "0.0.0.0";
const EXPECTED = process.env.EXPECTED_TOKEN || "";

let mode = "ok"; // ok | 500 | abort
let records = [];

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

// 只记 **形状**，绝不记密钥值：secrets 只留键名，Authorization 只留布尔。
function summarize(bodyText) {
  const out = { bytes: bodyText.length };
  try {
    const j = JSON.parse(bodyText);
    out.bodyKeys = Object.keys(j).sort();
    out.executionId = j.executionId || null;
    out.taskName = j.task && j.task.name ? j.task.name : null;
    out.taskKeys = j.task ? Object.keys(j.task).sort() : [];
    out.codeSource = j.task && j.task.codeSource ? j.task.codeSource : null;
    out.glueSourceLength =
      j.task && typeof j.task.glueSource === "string" ? j.task.glueSource.length : 0;
    out.paramsKeys = j.params ? Object.keys(j.params).sort() : null;
    out.secretsKeys = j.secrets ? Object.keys(j.secrets).sort() : null;
  } catch (err) {
    out.parseError = String((err && err.message) || err);
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = String(req.url || "").split("?")[0];
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  };

  if (req.method === "GET" && url === "/__state") {
    send(200, { count: records.length, mode: mode, records: records });
    return;
  }
  if (req.method === "POST" && url === "/__reset") {
    records = [];
    mode = "ok";
    await readBody(req);
    send(200, { ok: true, count: 0, mode: mode });
    return;
  }
  if (req.method === "POST" && url === "/__mode") {
    const raw = await readBody(req);
    let next = "ok";
    try {
      next = String(JSON.parse(raw || "{}").mode || "ok");
    } catch (_e) {
      next = "ok";
    }
    if (["ok", "500", "abort"].indexOf(next) === -1) next = "ok";
    mode = next;
    send(200, { ok: true, mode: mode });
    return;
  }
  if (req.method === "GET" && (url === "/api/health" || url === "/health")) {
    send(200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && url === "/api/execute") {
    const bodyText = await readBody(req);
    const auth = String(req.headers["authorization"] || "");
    const rec = Object.assign(
      {
        seq: records.length + 1,
        path: url,
        method: req.method,
        mode: mode,
        contentType: req.headers["content-type"] || null,
        authorizationPresent: auth.length > 0,
        authorizationMatches: EXPECTED ? auth === "Bearer " + EXPECTED : null,
        traceparent: req.headers["traceparent"] || null,
        idempotencyKey: req.headers["idempotency-key"] || null,
        headerNames: Object.keys(req.headers).sort(),
      },
      summarize(bodyText),
    );
    records.push(rec);
    if (records.length > 50) records.shift();

    if (mode === "500") {
      send(500, { error: "smoke-injected 500" });
      return;
    }
    if (mode === "abort") {
      // 直接断连：模拟「执行器进程崩了 / 连接被中间设备切了」这一档故障。
      req.socket.destroy();
      return;
    }
    // 与真实执行器 acceptExecution 的成功响应体逐字一致。
    send(200, { status: "accepted", executionId: rec.executionId });
    return;
  }

  send(404, { error: "not found", path: url });
});

server.listen(PORT, BIND, () => {
  console.log(
    "fake-executor listening on " + BIND + ":" + PORT + " (token check: " + (EXPECTED ? "on" : "off") + ")",
  );
});
FAKEEXEC_JS

docker run -d --name "$FE_NAME" --network "$SMOKE_NET" \
  -e "EXPECTED_TOKEN=${SMOKE_EXEC_SECRET}" \
  -v "${FE_JS}:/fakeexec.js:ro" \
  "$FE_IMG" node /fakeexec.js >/dev/null
ok "假执行器容器已启动（--network ${SMOKE_NET}，不发布宿主端口）"

# 控制面纯函数：容器内用 fetch 打自己的 127.0.0.1:${FE_PORT}
fe_post() {
  # $1=容器名 $2=路径 $3=JSON body
  docker exec -e FAKE_PORT_X="$FE_PORT" "${1:?need container}" node -e '
    fetch("http://127.0.0.1:" + process.env.FAKE_PORT_X + process.argv[1], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: process.argv[2],
    })
      .then(function (r) { return r.text(); })
      .then(function (t) { process.stdout.write(t); })
      .catch(function (e) { process.stdout.write("ERR " + e.message); });
  ' "$2" "$3"
}
# 控制面端点走容器自己的 127.0.0.1（不发布宿主端口 ⇒ 零端口残留）
fake_state()  { docker exec -e FAKE_PORT_X="$FE_PORT" "$FE_NAME" node -e '
    fetch("http://127.0.0.1:" + process.env.FAKE_PORT_X + "/__state")
      .then(function (r) { return r.text(); })
      .then(function (t) { process.stdout.write(t); })
      .catch(function (e) { process.stdout.write("ERR " + e.message); });
  '; }
fake_reset()  { fe_post "$FE_NAME" "/__reset" "{}" >/dev/null; }
fake_mode()   { fe_post "$FE_NAME" "/__mode" "{\"mode\":\"${1:-ok}\"}" >/dev/null; }
loop_state()  { docker exec -e FAKE_PORT_X="$FE_PORT" "$SMOKE_API_CONTAINER" node -e '
    fetch("http://127.0.0.1:" + process.env.FAKE_PORT_X + "/__state")
      .then(function (r) { return r.text(); })
      .then(function (t) { process.stdout.write(t); })
      .catch(function (e) { process.stdout.write("ERR " + e.message); });
  '; }
loop_reset()  { fe_post "$SMOKE_API_CONTAINER" "/__reset" "{}" >/dev/null; }
loop_mode()   { fe_post "$SMOKE_API_CONTAINER" "/__mode" "{\"mode\":\"${1:-ok}\"}" >/dev/null; }

# 就绪：容器内自测 /__state 有回包
FE_READY=0
for i in $(seq 1 60); do
  if fake_state | jq -e '.count' >/dev/null 2>&1; then FE_READY=1; break; fi
  sleep 1
done
if [[ "$FE_READY" == "1" ]]; then
  ok "假执行器就绪（/__state 可读）"
else
  bad "假执行器在 60s 内没就绪：$(docker logs "$FE_NAME" 2>&1 | tail -5)"
  exit 1
fi

# 容器名 → 地址的**运行时事实**：admin-api 容器里解析这个名字拿到什么 IP
FE_IP_JSON="$(docker exec "$SMOKE_API_CONTAINER" node -e '
  const dns = require("dns").promises;
  dns.lookup(process.argv[1], { all: true })
    .then(function (a) { process.stdout.write(JSON.stringify(a)); })
    .catch(function (e) { process.stdout.write("ERR " + e.message); });
' "$FE_NAME" 2>/dev/null || echo 'ERR')"
FE_IP="$(printf '%s' "$FE_IP_JSON" | jq -r '.[0].address // empty' 2>/dev/null || true)"
echo "    | admin-api 容器内解析 ${FE_NAME} ⇒ ${FE_IP_JSON}"
if [[ "$FE_IP" =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.) ]]; then
  ok "容器名解析到**私网**地址 ${FE_IP}（RFC1918 ⇒ SSRF 分类 = private-lan）"
else
  bad "容器名解析结果不是私网地址（${FE_IP_JSON}）⇒ 本场景对 private-lan 的判读失效"
fi

# ── 1. 登录 + 注册 push 执行器 ───────────────────────────────────────────
step "1. 登录并注册 push 执行器（address=${FE_ADDR}，dispatchMode=push）"
TOKEN=""
for i in $(seq 1 30); do
  TOKEN="$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$SMOKE_ADMIN_PW\"}" | jq -r '.data.accessToken // empty')"
  [[ -n "$TOKEN" ]] && break
  sleep 1
done
[[ -n "$TOKEN" ]] || { echo "✗ login failed" >&2; exit 2; }
ok "admin 登录成功"

register_executor() {
  # $1 = appName 后缀  $2 = address  $3 = dispatchMode  $4 = fingerprint 后缀
  local suffix="${1:?need suffix}" addr="${2:?need address}" mode="${3:-push}" fp="${4:-$1}"
  curl -s -X POST "$API/executors/register" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $SMOKE_EXEC_SECRET" -d "{
      \"appName\": \"${PREFIX}${suffix}\",
      \"address\": \"${addr}\",
      \"type\": \"node\",
      \"version\": \"0.0.0-smoke\",
      \"capabilities\": [\"node\"],
      \"runtime\": [\"node\"],
      \"dispatchMode\": \"${mode}\",
      \"maxConcurrentTasks\": 10,
      \"groupName\": \"default\",
      \"tags\": [\"smoke\"],
      \"deviceFingerprint\": \"fp-${PREFIX}${fp}\"
    }" | jq -r '.data.id // empty'
}
set_exec_state() {
  # $1=appName 后缀 $2=running $3=max $4=cpu $5=mem（每句 UPDATE 都带 WHERE）
  psql_q "update executors set \"runningTaskCount\"=${2}, \"maxConcurrentTasks\"=${3}, \"cpuUsage\"=${4}, \"memUsage\"=${5}, status='online', \"lastHeartbeat\"=now(), \"offlineReason\"=null where \"appName\"='${PREFIX}${1}';" >/dev/null
}
create_glue_task() {
  # $1 = 任务名  $2 = 额外 JSON 片段（可空，形如 ,"executorId":"..."）
  local name="${1:?need name}" extra="${2:-}"
  curl -s -X POST "$API/tasks" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${TOKEN}" -d "{
      \"name\": \"${name}\",
      \"triggerType\": \"manual\",
      \"runtime\": \"node\",
      \"timeout\": 300,
      \"maxRetry\": 0,
      \"glueSource\": \"console.log('smoke-dispatch-push');\",
      \"glueLanguage\": \"javascript\",
      \"codeSource\": \"glue\"${extra}
    }" | jq -r '.data.id // .errorCode // .message'
}
trigger_task() {
  local tid="${1:?need taskId}"
  curl -s -o "$TRIG_JSON" -w '%{http_code}' \
    -X POST "$API/tasks/${tid}/trigger" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${TOKEN}" -d '{}'
}
# 等执行行稳态；输出 "status|executorAddress|failureReason|id|errorMessage"
wait_exec() {
  # $1=taskId  $2=running（等 RUNNING）| steady（等 failed/timeout/success）
  local tid="${1:?need taskId}" want="${2:-steady}" out="" i st
  for i in $(seq 1 60); do
    out="$(psql_q "select status::text || '|' || coalesce(\"executorAddress\",'') || '|' || coalesce(\"failureReason\"::text,'-') || '|' || id::text || '|' || coalesce(\"errorMessage\",'') from task_executions where \"taskId\"='${tid}' order by \"createdAt\" desc limit 1;")"
    st="${out%%|*}"
    if [[ "$want" == "running" ]]; then
      [[ "$st" == "running" ]] && break
    else
      case "$st" in failed|timeout|success) break ;; esac
    fi
    sleep 1
  done
  printf '%s' "$out"
}
# 拆 wait_exec 的输出
split_exec() {
  local out="${1:?}"; local r
  ST="${out%%|*}"; r="${out#*|}"
  ADDR="${r%%|*}"; r="${r#*|}"
  FR="${r%%|*}"; r="${r#*|}"
  EID="${r%%|*}"; ERR="${r#*|}"
}
rtc_of() { psql_q "select \"runningTaskCount\" from executors where \"appName\"='${PREFIX}${1}';"; }

EXEC_PUSH="$(register_executor push "$FE_ADDR" push push)"
[[ -n "$EXEC_PUSH" ]] || { bad "push 执行器注册失败 ⇒ 中止"; exit 1; }
ok "push 执行器已注册（id=${EXEC_PUSH}，appName=${PREFIX}push，address=${FE_ADDR}）"
set_exec_state push 0 10 0 0
ROW_PUSH="$(psql_q "select status::text || '|' || \"dispatchMode\"::text || '|' || address from executors where id='${EXEC_PUSH}';")"
[[ "$ROW_PUSH" == "online|push|${FE_ADDR}" ]] \
  && ok "DB 侧执行器行 = ${ROW_PUSH}（online + push + 容器名地址）" \
  || bad "DB 侧执行器行不符：'${ROW_PUSH}'（期望 online|push|${FE_ADDR}）"

# ── 2. B1：push 真的发出 HTTP 请求 ───────────────────────────────────────
step "2. B1 push 成功：真发 HTTP 到 ${FE_ADDR}/api/execute，且执行器 2xx 被落进执行行"
fake_reset
set_exec_state push 2 10 0 0
PRE="$(rtc_of push)"
echo "    | 占坑前 runningTaskCount = ${PRE}"
TASK_OK="$(create_glue_task "${PREFIX}ok" "")"
[[ -n "$TASK_OK" && "$TASK_OK" != *"null"* ]] || { bad "任务创建失败：${TASK_OK}"; exit 1; }
HTTP_OK="$(trigger_task "$TASK_OK")"
[[ "$HTTP_OK" == "201" ]] && ok "触发成功（HTTP ${HTTP_OK}）" || bad "触发失败（HTTP ${HTTP_OK}）：$(head -c 200 "$TRIG_JSON")"
split_exec "$(wait_exec "$TASK_OK" running)"
echo "    | 执行行：status=${ST} addr='${ADDR}' failureReason=${FR} id=${EID}"
[[ "$ST" == "running" ]] \
  && ok "B1-① 执行落 RUNNING（dispatch 返回 2xx 后 admin 才置 RUNNING —— 传输闭合）" \
  || bad "B1-① 执行状态 = ${ST}（期望 running）；errorMessage=$(head -c 300 <<<"$ERR")"
[[ "$ADDR" == "$FE_ADDR" ]] \
  && ok "B1-② 执行行 executorAddress = ${ADDR}" \
  || bad "B1-② executorAddress='${ADDR}'（期望 ${FE_ADDR}）"

# 执行器**侧**的证据：真的收到了什么
STATE_OK="$(fake_state)"
N_OK="$(printf '%s' "$STATE_OK" | jq -r '.count' 2>/dev/null || echo '?')"
REC_OK="$(printf '%s' "$STATE_OK" | jq -c '.records[0] // {}' 2>/dev/null || echo '{}')"
echo "    | 假执行器收到的第 1 条：$(printf '%s' "$REC_OK" | jq -c '{path,method,contentType,authorizationPresent,authorizationMatches,traceparent,idempotencyKey,bodyKeys,executionId,taskName,codeSource,paramsKeys,secretsKeys}' 2>/dev/null || printf '%s' "$REC_OK")"
[[ "$N_OK" == "1" ]] \
  && ok "B1-③ 假执行器**真的收到 1 次** /api/execute（计数 = ${N_OK}）" \
  || bad "B1-③ 假执行器收到 ${N_OK} 次请求（期望 1）"
[[ "$(printf '%s' "$REC_OK" | jq -r '.path // empty')" == "/api/execute" ]] \
  && ok "B1-④ 路径 = /api/execute（POST）" \
  || bad "B1-④ 路径不是 /api/execute：$(printf '%s' "$REC_OK" | jq -r '.path // "?"')"
[[ "$(printf '%s' "$REC_OK" | jq -r '.executionId // empty')" == "$EID" ]] \
  && ok "B1-⑤ 载荷 executionId = 执行行 id（${EID}）" \
  || bad "B1-⑤ 载荷 executionId='$(printf '%s' "$REC_OK" | jq -r '.executionId // "?"')'，期望 ${EID}"
[[ "$(printf '%s' "$REC_OK" | jq -r '.taskName // empty')" == "${PREFIX}ok" ]] \
  && ok "B1-⑥ 载荷 task.name = ${PREFIX}ok" \
  || bad "B1-⑥ 载荷 task.name='$(printf '%s' "$REC_OK" | jq -r '.taskName // "?"')'"
BK="$(printf '%s' "$REC_OK" | jq -r '.bodyKeys // [] | join(",")')"
[[ "$BK" == "executionId,params,secrets,task" ]] \
  && ok "B1-⑦ 载荷顶层键 = {${BK}}（与 executor.service.ts 的 axios.post 字面一致）" \
  || bad "B1-⑦ 载荷顶层键 = {${BK}}（期望 executionId,params,secrets,task）"
[[ "$(printf '%s' "$REC_OK" | jq -r '.authorizationMatches')" == "true" ]] \
  && ok "B1-⑧ Authorization 头 = Bearer <栈的 EXECUTOR_SECRET>（与执行器侧共享令牌等值；只比不回显）" \
  || bad "B1-⑧ Authorization 头不匹配（present=$(printf '%s' "$REC_OK" | jq -r '.authorizationPresent') matches=$(printf '%s' "$REC_OK" | jq -r '.authorizationMatches')）"
[[ "$(printf '%s' "$REC_OK" | jq -r '.contentType // ""')" == "application/json" ]] \
  && ok "B1-⑨ Content-Type = application/json" \
  || bad "B1-⑨ Content-Type='$(printf '%s' "$REC_OK" | jq -r '.contentType // "?"')'"
# 头面**如实打印**（有就断言有，没有就如实说没有 —— 不伪造断言）
TP="$(printf '%s' "$REC_OK" | jq -r '.traceparent // "（无）"')"
IDK="$(printf '%s' "$REC_OK" | jq -r '.idempotencyKey // "（无）"')"
echo "    | 头面：traceparent=${TP}  idempotency-key=${IDK}"
echo "    | 头名清单：$(printf '%s' "$REC_OK" | jq -r '.headerNames // [] | join(",")')"

# admin 侧：执行器的 2xx 响应体被落进 result（证明 admin 读到了响应）
RES_STATUS="$(psql_q "select coalesce(result->>'status','') from task_executions where id='${EID}';")"
RES_EID="$(psql_q "select coalesce(result->>'executionId','') from task_executions where id='${EID}';")"
[[ "$RES_STATUS" == "accepted" && "$RES_EID" == "$EID" ]] \
  && ok "B1-⑩ 执行行 result = {status:accepted, executionId:${RES_EID}}（执行器响应体被 admin 收下并落库）" \
  || bad "B1-⑩ 执行行 result 不符：status='${RES_STATUS}' executionId='${RES_EID}'"

POST="$(rtc_of push)"
[[ "$POST" == "$((PRE + 1))" ]] \
  && ok "B1-⑪ 占坑保持：runningTaskCount ${PRE} → ${POST}（push 成功**不**补偿回滚）" \
  || bad "B1-⑪ runningTaskCount ${PRE} → ${POST}（期望 $((PRE + 1))）"
LOG_OK="$(decision_log_of "$EID")"
if [[ -z "$LOG_OK" ]]; then
  bad "B1-⑫ 找不到 executionId=${EID} 的 dispatch.decision 日志"
else
  SEL_RTC="$(lj "$LOG_OK" '.selected.runningTaskCount')"
  SEL_ADDR="$(lj "$LOG_OK" '.selected.address')"
  [[ "$SEL_RTC" == "$((PRE + 1))" && "$SEL_ADDR" == "$FE_ADDR" ]] \
    && ok "B1-⑫ 决策日志 selected = ${SEL_ADDR} / runningTaskCount=${SEL_RTC}（= 占坑后 +1）⇒ 占坑真的发生了" \
    || bad "B1-⑫ 决策日志 selected.address='${SEL_ADDR}' runningTaskCount='${SEL_RTC}'（期望 ${FE_ADDR} / $((PRE + 1))）"
fi

# ── 3. B2：执行器回 500 ⇒ 占坑回滚 ───────────────────────────────────────
step "3. B2 失败路径①：执行器回 500 ⇒ 占坑必须回滚（compensateClaimedSlot）"
fake_reset; fake_mode 500
set_exec_state push 4 10 0 0
PRE="$(rtc_of push)"
echo "    | 占坑前 runningTaskCount = ${PRE}"
TASK_F500="$(create_glue_task "${PREFIX}fail500" "")"
[[ -n "$TASK_F500" && "$TASK_F500" != *"null"* ]] || { bad "任务创建失败：${TASK_F500}"; exit 1; }
HTTP_F500="$(trigger_task "$TASK_F500")"
[[ "$HTTP_F500" == "201" ]] && ok "触发成功（HTTP ${HTTP_F500}）" || bad "触发失败（HTTP ${HTTP_F500}）"
split_exec "$(wait_exec "$TASK_F500" steady)"
echo "    | 执行行：status=${ST} failureReason=${FR} errorMessage=$(head -c 200 <<<"$ERR")"
[[ "$ST" == "failed" ]] && ok "B2-① 执行落 failed" || bad "B2-① 执行状态 = ${ST}（期望 failed）"
[[ "$FR" != "-" && -n "$FR" ]] \
  && ok "B2-② failureReason = ${FR}（有归因，不是空）" \
  || bad "B2-② failureReason 为空（'${FR}'）"
grep -q '500' <<<"$ERR" \
  && ok "B2-③ errorMessage 含 HTTP 500（「Request failed with status code 500」族）" \
  || bad "B2-③ errorMessage 不含 500（实测：$(head -c 160 <<<"$ERR")）"
N500="$(fake_state | jq -r '.count' 2>/dev/null || echo '?')"
[[ "$N500" == "1" ]] \
  && ok "B2-④ 假执行器仍收到 1 次请求 ⇒ 失败发生在**传输之后**（不是没派出去）" \
  || bad "B2-④ 假执行器收到 ${N500} 次请求（期望 1）"
POST="$(rtc_of push)"
[[ "$POST" == "$PRE" ]] \
  && ok "B2-⑤ **占坑回滚**：runningTaskCount ${PRE} → ${POST}（回到占坑前）" \
  || bad "B2-⑤ runningTaskCount ${PRE} → ${POST}（期望回到 ${PRE}）—— 槽位泄漏"
LOG_F500="$(decision_log_of "$EID")"
if [[ -z "$LOG_F500" ]]; then
  bad "B2-⑥ 找不到 executionId=${EID} 的 dispatch.decision 日志"
else
  SEL_RTC="$(lj "$LOG_F500" '.selected.runningTaskCount')"
  [[ "$SEL_RTC" == "$((PRE + 1))" ]] \
    && ok "B2-⑥ 决策日志 selected.runningTaskCount = ${SEL_RTC} = 占坑前 +1 ⇒ 占坑**确实发生过**，随后被补偿回滚（${POST}=${PRE}）" \
    || bad "B2-⑥ 决策日志 selected.runningTaskCount = ${SEL_RTC}（期望 $((PRE + 1))）⇒ 无法证明「先占坑后回滚」"
fi

# ── 4. B3：执行器直接关连接 ⇒ 同样回滚 ───────────────────────────────────
step "4. B3 失败路径②：执行器直接 destroy 连接（ECONNRESET / socket hang up）⇒ 同样回滚"
fake_reset; fake_mode abort
set_exec_state push 5 10 0 0
PRE="$(rtc_of push)"
echo "    | 占坑前 runningTaskCount = ${PRE}"
TASK_AB="$(create_glue_task "${PREFIX}abort" "")"
[[ -n "$TASK_AB" && "$TASK_AB" != *"null"* ]] || { bad "任务创建失败：${TASK_AB}"; exit 1; }
trigger_task "$TASK_AB" >/dev/null
split_exec "$(wait_exec "$TASK_AB" steady)"
echo "    | 执行行：status=${ST} failureReason=${FR} errorMessage=$(head -c 200 <<<"$ERR")"
[[ "$ST" == "failed" ]] && ok "B3-① 执行落 failed（连接被对端切断 ⇒ 不是 2xx）" || bad "B3-① 执行状态 = ${ST}（期望 failed）"
[[ "$FR" != "-" && -n "$FR" ]] \
  && ok "B3-② failureReason = ${FR}" \
  || bad "B3-② failureReason 为空（'${FR}'）"
if grep -qiE 'socket hang up|ECONNRESET|aborted' <<<"$ERR"; then
  ok "B3-③ errorMessage 是断连族（socket hang up / ECONNRESET / aborted）"
else
  bad "B3-③ errorMessage 不是断连族（实测：$(head -c 160 <<<"$ERR")）"
fi
NAB="$(fake_state | jq -r '.count' 2>/dev/null || echo '?')"
[[ "$NAB" == "1" ]] \
  && ok "B3-④ 假执行器收到 1 次请求（收到了，随后主动断连）" \
  || bad "B3-④ 假执行器收到 ${NAB} 次请求（期望 1）"
POST="$(rtc_of push)"
[[ "$POST" == "$PRE" ]] \
  && ok "B3-⑤ **占坑回滚**：runningTaskCount ${PRE} → ${POST}" \
  || bad "B3-⑤ runningTaskCount ${PRE} → ${POST}（期望回到 ${PRE}）—— 槽位泄漏"
LOG_AB="$(decision_log_of "$EID")"
SEL_RTC="$(lj "$LOG_AB" '.selected.runningTaskCount')"
[[ "$SEL_RTC" == "$((PRE + 1))" ]] \
  && ok "B3-⑥ 决策日志 selected.runningTaskCount = ${SEL_RTC} = 占坑前 +1 ⇒ 先占坑后回滚" \
  || bad "B3-⑥ 决策日志 selected.runningTaskCount = '${SEL_RTC}'（期望 $((PRE + 1))）"

# ── 5. B4：SSRF 默认姿态 —— loopback 必须被**发请求之前**拒绝 ────────────
# R05：重建/健康检查三个 helper 必须定义在**首次使用之前**（bash 按执行顺序解析）。
api_env_sorted() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SMOKE_API_CONTAINER" | sed '/^$/d' | sort
}
api_env_sorted >"$ENV_SNAP"
ORIG_ENV_LINES="$(wc -l <"$ENV_SNAP" | tr -d ' ')"
ok "已抓取原始 admin-api env 快照（${ORIG_ENV_LINES} 行，${ENV_SNAP}）"

recreate_api() {
  # $1 = 1 ⇒ 追加 EXECUTOR_ALLOW_PRIVATE_NETWORK=true；0 ⇒ 明确**剔除**该 env
  local withflag="${1:-0}" img net portargs=() envs=() binds=() args=() b e
  img="$(docker inspect -f '{{.Config.Image}}' "$SMOKE_API_CONTAINER")"
  net="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$SMOKE_API_CONTAINER")"
  mapfile -t envs < <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SMOKE_API_CONTAINER" | sed '/^$/d')
  mapfile -t binds < <(docker inspect -f '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$SMOKE_API_CONTAINER" | sed '/^$/d')
  mapfile -t portargs < <(docker inspect -f '{{json .HostConfig.PortBindings}}' "$SMOKE_API_CONTAINER" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      const p = JSON.parse(s.trim() || "{}") || {};
      for (const key of Object.keys(p)) {
        for (const b of p[key] || []) {
          process.stdout.write("-p\n" + ((b.HostIp || "0.0.0.0") + ":" + b.HostPort + ":" + key.split("/")[0]) + "\n");
        }
      }
    });
  ')
  args=(-d --name "$SMOKE_API_CONTAINER" --network "$net")
  for b in "${portargs[@]:-}"; do [[ -n "$b" ]] && args+=("$b"); done
  for b in "${binds[@]:-}"; do [[ -n "$b" ]] && args+=(-v "$b"); done
  for e in "${envs[@]}"; do
    [[ "$e" == EXECUTOR_ALLOW_PRIVATE_NETWORK=* ]] && continue
    args+=(-e "$e")
  done
  [[ "$withflag" == "1" ]] && args+=(-e EXECUTOR_ALLOW_PRIVATE_NETWORK=true)
  docker rm -f "$SMOKE_API_CONTAINER" >/dev/null 2>&1 || true
  local i rc=1 runerr=""
  for i in $(seq 1 15); do
    if runerr="$(docker run "${args[@]}" "$img" 2>&1 >/dev/null)"; then rc=0; break; fi
    sleep 1
  done
  if [[ "$rc" != "0" ]]; then
    # 可调试性：此前失败只输出「重建失败」，docker 的真实报错被吞掉（排查全靠猜）。
    printf '    | recreate_api(%s) 失败；最后一次 docker run 报错：\n      %s\n' \
      "$withflag" "$(printf '%s' "$runerr" | tr '\n' ' ')"
    return 1
  fi
  API_TOUCHED=1
  [[ "$withflag" == "1" ]] && API_FLAG_STATE=1 || API_FLAG_STATE=0
  return 0
}
wait_api_health() {
  local i
  for i in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:${SMOKE_API_PORT}/api/health/live" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

step "5. B4 SSRF 默认姿态：地址 ${SSRF_ADDR:-（私网 IP 未取到）}（私网）⇒ 守卫在发请求前拒绝（监听侧 0 次）"
if ! resolve_ssrf_addr; then
  bad "取不到 admin-api 容器的私网 IP ⇒ B4/B5 无法验证（如实记未验证）"
  exit 1
fi
ok "取样地址 = ${SSRF_ADDR}（admin-api 容器私网 IP，契约下 loopback 两态都拒故不用）"
# R05：本栈的 admin-api **默认带** EXECUTOR_ALLOW_PRIVATE_NETWORK=true（私网派发需要）。
# 「默认姿态」= 把这个 env **摘掉**后重建 —— 等价于 `.env.example` 默认 false 的裸机形态。
api_env_sorted >"$ENV_SNAP"
ORIG_ENV_LINES="$(wc -l <"$ENV_SNAP" | tr -d ' ')"
ok "已抓取基线 admin-api env 快照（${ORIG_ENV_LINES} 行，${ENV_SNAP}）"
if recreate_api 0 && wait_api_health; then
  ok "admin-api 已按「默认姿态」重建（摘掉 EXECUTOR_ALLOW_PRIVATE_NETWORK）并就绪"
else
  bad "admin-api 重建失败（或未就绪）⇒ 默认姿态无法验证（如实记未验证项）"
  exit 1
fi
api_env_sorted >"${ENV_SNAP}.before5"
ENV_DIFF_B4="$(diff "$ENV_SNAP" "${ENV_SNAP}.before5" | grep -E '^[<>]' || true)"
echo "    | env diff（基线 vs B4 重建后）：${ENV_DIFF_B4:-（空）}"
[[ "$ENV_DIFF_B4" == "< EXECUTOR_ALLOW_PRIVATE_NETWORK=true" ]] \
  && ok "B4-⓪ 重建只摘掉了那一行开关（其余 env 逐行相同 ⇒ 无参数漂移）" \
  || bad "B4-⓪ env 差异不是「恰好摘掉一行」：$(printf '%s' "$ENV_DIFF_B4" | head -5)"
# 容器重建后监听与登录态都没了 ⇒ 重新下发 JS / 重新登录
docker cp "$FE_JS" "$SMOKE_API_CONTAINER":/tmp/fakeexec-loop.js >/dev/null
start_loop_listener() {
  # 监听绑 0.0.0.0（容器内不发布任何宿主端口）；**被测地址**是容器自己的私网 IP。
  # 不绑私网 IP 的原因：控制面（loop_state/loop_reset）走容器内 127.0.0.1，
  # 绑单一私网 IP 会让控制面连不上 —— 而「0 次请求」的证据来自**守卫没发出去**，与 bind 无关。
  docker exec -d -e "EXPECTED_TOKEN=${SMOKE_EXEC_SECRET}" \
    "$SMOKE_API_CONTAINER" node /tmp/fakeexec-loop.js >/dev/null
  local i
  for i in $(seq 1 30); do
    if loop_state | jq -e '.count' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
if start_loop_listener; then
  ok "admin-api 容器内已起私网监听（${SSRF_ADDR}，同一份 JS）"
else
  bad "admin-api 容器内的私网监听起不来 ⇒ SSRF 两条无法验证"
  exit 1
fi
EXEC_LOOP="$(register_executor loop "$SSRF_ADDR" push loop)"
[[ -n "$EXEC_LOOP" ]] || { bad "私网执行器注册失败 ⇒ 中止"; exit 1; }
ok "私网执行器已注册（id=${EXEC_LOOP}，address=${SSRF_ADDR}）"
# 只让 loopback 那台在线：避免候选池里另一台（容器名地址）被选中而让断言失真
psql_q "update executors set status='offline', \"offlineReason\"='manual' where \"appName\"='${PREFIX}push';" >/dev/null
set_exec_state loop 6 10 0 0
ON_N="$(psql_q "select count(*) from executors where \"appName\" like '${PAT}' and status='online';")"
[[ "$ON_N" == "1" ]] && ok "场景构造：本前缀只有 1 台在线（loopback 那台）" || bad "在线执行器数 = ${ON_N}（期望 1）"
FLAG_NOW="$(docker exec "$SMOKE_API_CONTAINER" printenv EXECUTOR_ALLOW_PRIVATE_NETWORK 2>/dev/null || true)"
echo "    | admin-api 进程的 EXECUTOR_ALLOW_PRIVATE_NETWORK = '${FLAG_NOW:-（未设置）}'"
[[ -z "$FLAG_NOW" ]] \
  && ok "默认态确认为「开关未设置」（摘掉后重建，等价 `.env.example` 默认 false）" \
  || bad "默认态下该 env 仍存在（'${FLAG_NOW}'）⇒ 本场景的「默认拒绝」判读失效"

loop_reset
PRE="$(rtc_of loop)"
echo "    | 占坑前 runningTaskCount = ${PRE}"
TASK_SSRF="$(create_glue_task "${PREFIX}ssrf" ",\"executorId\":\"${EXEC_LOOP}\"")"
[[ -n "$TASK_SSRF" && "$TASK_SSRF" != *"null"* ]] || { bad "任务创建失败：${TASK_SSRF}"; exit 1; }
HTTP_SSRF="$(trigger_task "$TASK_SSRF")"
[[ "$HTTP_SSRF" == "201" ]] && ok "触发成功（HTTP ${HTTP_SSRF}）" || bad "触发失败（HTTP ${HTTP_SSRF}）"
split_exec "$(wait_exec "$TASK_SSRF" steady)"
echo "    | 执行行：status=${ST} failureReason=${FR} errorMessage=$(head -c 240 <<<"$ERR")"
NL0="$(loop_state | jq -r '.count' 2>/dev/null || echo '?')"
[[ "$NL0" == "0" ]] \
  && ok "B4-① **决定性证据**：私网监听器收到 0 次请求 ⇒ 请求根本没离开 admin-api（不是「连不上」）" \
  || bad "B4-① 私网监听器收到 ${NL0} 次请求（期望 0）⇒ 守卫没拦住"
[[ "$ST" == "failed" ]] && ok "B4-② 执行落 failed" || bad "B4-② 执行状态 = ${ST}（期望 failed）"
[[ "$FR" != "-" && -n "$FR" ]] \
  && ok "B4-③ failureReason = ${FR}" \
  || bad "B4-③ failureReason 为空"
grep -q '已拒绝对外请求' <<<"$ERR" \
  && ok "B4-④ errorMessage 是 SSRF_HOST_DENIED_PINNED 的专属尾句「已拒绝对外请求」⇒ 归因是守卫而不是网络" \
  || bad "B4-④ errorMessage 不含「已拒绝对外请求」（实测：$(head -c 200 <<<"$ERR")）"
# ⚠️ 文案只带**主机**（`URL host {{host}}`），不带端口 ⇒ 断言主机，不断言 host:port
grep -q "${API_PRIV_IP}" <<<"$ERR" \
  && ok "B4-⑤ 文案点名被拒的主机 ${API_PRIV_IP}（错误目录的 {{host}} 插值；不含端口是目录文案口径）" \
  || bad "B4-⑤ 文案未点名被拒的主机"
POST="$(rtc_of loop)"
[[ "$POST" == "$PRE" ]] \
  && ok "B4-⑥ **占坑回滚**：runningTaskCount ${PRE} → ${POST}（守卫在 axios 之前抛 ⇒ 仍走同一 catch 补偿）" \
  || bad "B4-⑥ runningTaskCount ${PRE} → ${POST}（期望回到 ${PRE}）—— 槽位泄漏"
LOG_SSRF="$(decision_log_of "$EID")"
SEL_RTC="$(lj "$LOG_SSRF" '.selected.runningTaskCount')"
[[ "$SEL_RTC" == "$((PRE + 1))" ]] \
  && ok "B4-⑦ 决策日志 selected.runningTaskCount = ${SEL_RTC} = 占坑前 +1 ⇒ 占坑在守卫之前就发生了" \
  || bad "B4-⑦ 决策日志 selected.runningTaskCount = '${SEL_RTC}'（期望 $((PRE + 1))）"

# ── 6. B5：开 EXECUTOR_ALLOW_PRIVATE_NETWORK=true ⇒ 同一地址放通 ─────────
step "6. B5 开关开启：重建 admin-api 回带开关态 ⇒ 同一私网地址 ${SSRF_ADDR} 放通"
#
# 起手先抓**原始容器**的全部运行时配置（env/binds/ports/network/image）：
# 重建时按它原样复制，只追加一个 env ⇒ 不引入「手抄参数漂移」这类假绿。

if recreate_api 1 && wait_api_health; then
  ok "admin-api 已带 EXECUTOR_ALLOW_PRIVATE_NETWORK=true 重建并就绪"
else
  bad "admin-api 重建失败（或 120s 未就绪）⇒ 开关态无法验证（如实记未验证项）"
  exit 1
fi
# 自校验：R05 起基线**本就带**该 env ⇒ 重建成「带开关」后与基线快照必须**逐行相同**
api_env_sorted >"${ENV_SNAP}.after"
ENV_DIFF="$(diff "$ENV_SNAP" "${ENV_SNAP}.after" | grep -E '^[<>]' || true)"
echo "    | env diff（基线快照 vs B5 重建后）：${ENV_DIFF:-（空）}"
[[ -z "$ENV_DIFF" ]] \
  && ok "B5-⓪ 重建回「带开关」后 env 与基线快照**逐行相同**（diff 为空 ⇒ 无参数漂移）" \
  || bad "B5-⓪ 重建后的 env 与基线快照有差异：$(printf '%s' "$ENV_DIFF" | head -5)"
FLAG_ON="$(docker exec "$SMOKE_API_CONTAINER" printenv EXECUTOR_ALLOW_PRIVATE_NETWORK 2>/dev/null || true)"
[[ "$FLAG_ON" == "true" ]] \
  && ok "B5-⓫ 进程 env 实测 EXECUTOR_ALLOW_PRIVATE_NETWORK='true'" \
  || bad "B5-⓫ 进程 env 实测为 '${FLAG_ON}'（期望 true）"

# 重建后旧容器里的 loopback 监听已随容器消失 ⇒ 重新起一份；token 也重新取
docker cp "$FE_JS" "$SMOKE_API_CONTAINER":/tmp/fakeexec-loop.js >/dev/null
if start_loop_listener; then
  ok "重建后的 admin-api 内重新起了私网监听"
else
  bad "重建后的私网监听起不来 ⇒ B5 无法验证"
  exit 1
fi
TOKEN="$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$SMOKE_ADMIN_PW\"}" | jq -r '.data.accessToken // empty')"
[[ -n "$TOKEN" ]] && ok "重建后重新登录成功" || { bad "重建后登录失败 ⇒ 中止"; exit 1; }
# 重建会重跑 sweep 的相关 cron，但执行器行在 DB 里 ⇒ 只需刷心跳/在线态
set_exec_state loop 7 10 0 0
psql_q "update executors set status='offline', \"offlineReason\"='manual' where \"appName\"='${PREFIX}push';" >/dev/null

loop_reset; loop_mode ok
PRE="$(rtc_of loop)"
echo "    | 占坑前 runningTaskCount = ${PRE}"
TASK_ALLOW="$(create_glue_task "${PREFIX}ssrf-allow" ",\"executorId\":\"${EXEC_LOOP}\"")"
[[ -n "$TASK_ALLOW" && "$TASK_ALLOW" != *"null"* ]] || { bad "任务创建失败：${TASK_ALLOW}"; exit 1; }
HTTP_ALLOW="$(trigger_task "$TASK_ALLOW")"
[[ "$HTTP_ALLOW" == "201" ]] && ok "触发成功（HTTP ${HTTP_ALLOW}）" || bad "触发失败（HTTP ${HTTP_ALLOW}）"
split_exec "$(wait_exec "$TASK_ALLOW" running)"
echo "    | 执行行：status=${ST} addr='${ADDR}' failureReason=${FR}"
ST_ALLOW="$(loop_state)"
N1="$(printf '%s' "$ST_ALLOW" | jq -r '.count' 2>/dev/null || echo '?')"
REC1="$(printf '%s' "$ST_ALLOW" | jq -c '.records[0] // {}' 2>/dev/null || echo '{}')"
[[ "$N1" == "1" ]] \
  && ok "B5-① **决定性证据**：同一私网地址 ${SSRF_ADDR} 这次收到 1 次请求 ⇒ 开关开启后放通" \
  || bad "B5-① 私网监听器收到 ${N1} 次请求（期望 1）"
[[ "$ST" == "running" ]] && ok "B5-② 执行落 RUNNING（dispatch 成功）" || bad "B5-② 执行状态 = ${ST}（期望 running）；errorMessage=$(head -c 200 <<<"$ERR")"
[[ "$ADDR" == "$SSRF_ADDR" ]] && ok "B5-③ 执行行 executorAddress = ${SSRF_ADDR}" || bad "B5-③ executorAddress='${ADDR}'"
[[ "$(printf '%s' "$REC1" | jq -r '.authorizationMatches')" == "true" ]] \
  && ok "B5-④ 收到的请求带正确 Bearer 共享令牌 + 路径 $(printf '%s' "$REC1" | jq -r '.path')" \
  || bad "B5-④ 请求的 Authorization 不匹配"
[[ "$(printf '%s' "$REC1" | jq -r '.taskName // empty')" == "${PREFIX}ssrf-allow" ]] \
  && ok "B5-⑤ 载荷 task.name = ${PREFIX}ssrf-allow" \
  || bad "B5-⑤ 载荷 task.name='$(printf '%s' "$REC1" | jq -r '.taskName // "?"')'"
POST="$(rtc_of loop)"
[[ "$POST" == "$((PRE + 1))" ]] \
  && ok "B5-⑥ 占坑保持：runningTaskCount ${PRE} → ${POST}（与 B4 的 ${PRE}←回滚形成对照）" \
  || bad "B5-⑥ runningTaskCount ${PRE} → ${POST}（期望 $((PRE + 1))）"

# ── 7. 恢复 admin-api 的原始 env（把开关摘掉）─────────────────────────────
step "7. 恢复 admin-api 原始 env（R05 起原始=带 EXECUTOR_ALLOW_PRIVATE_NETWORK=true）+ 自校验"
if recreate_api 1 && wait_api_health; then
  ok "admin-api 已按原始 env（带开关）重建并就绪"
else
  bad "admin-api 恢复失败 ⇒ 栈状态可能被本脚本改动（后续场景会受影响）"
fi
api_env_sorted >"${ENV_SNAP}.restored"
ENV_DIFF2="$(diff "$ENV_SNAP" "${ENV_SNAP}.restored" | grep -E '^[<>]' || true)"
[[ -z "$ENV_DIFF2" ]] \
  && ok "恢复后的 env 与原始快照**逐行相同**（diff 为空）" \
  || bad "恢复后的 env 与原始快照仍有差异：$(printf '%s' "$ENV_DIFF2" | head -5)"
FLAG_BACK="$(docker exec "$SMOKE_API_CONTAINER" printenv EXECUTOR_ALLOW_PRIVATE_NETWORK 2>/dev/null || true)"
[[ "$FLAG_BACK" == "true" ]] \
  && ok "恢复后进程里 EXECUTOR_ALLOW_PRIVATE_NETWORK='true'（与基线一致）" \
  || bad "恢复后该 env = '${FLAG_BACK}'（期望 true，与基线一致）"
# 容器基本形态也核对（镜像 / 网络 / 端口 / 卷未被重建改掉）
IMG_NOW="$(docker inspect -f '{{.Config.Image}}' "$SMOKE_API_CONTAINER")"
NET_NOW="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$SMOKE_API_CONTAINER")"
BIND_NOW="$(docker inspect -f '{{json .HostConfig.Binds}}' "$SMOKE_API_CONTAINER")"
PORTS_NOW="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$SMOKE_API_CONTAINER")"
echo "    | 重建后形态：image=${IMG_NOW} network=${NET_NOW} binds=${BIND_NOW} ports=${PORTS_NOW}"
[[ "$IMG_NOW" == "$SMOKE_IMAGE" && "$NET_NOW" == "$SMOKE_NET" ]] \
  && ok "重建后仍是同一镜像 + 同一网络（镜像/网络未漂移）" \
  || bad "重建后镜像/网络漂移（image=${IMG_NOW} network=${NET_NOW}）"
TOKEN="$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$SMOKE_ADMIN_PW\"}" | jq -r '.data.accessToken // empty')"
[[ -n "$TOKEN" ]] && ok "恢复后 API 可用（重新登录成功）" || bad "恢复后登录失败（admin-api 不健康）"

# ── 8. 跑后清理 + 残留四查 ───────────────────────────────────────────────
step "8. 跑后清理（只删本脚本自己造的 smoke-dpush-* 数据）+ 残留四查"
psql_q "update executors set status='online', \"runningTaskCount\"=0 where \"appName\" like '${PAT}';" >/dev/null
if smoke_clean_tasks "$PREFIX" "本脚本全部任务及其执行行 / 日志行 / 审计行" && clean_own_rows; then
  ok "跑后清理完成（tasks / executors / applications 本前缀残留 = 0）"
else
  bad "跑后清理失败（不影响可重入：下一次跑的步骤 0a 会再清一次）"
fi
DB_RES_POST="$(db_residual)"
[[ "$DB_RES_POST" == "0/0/0" ]] \
  && ok "DB 三查残留在跑后 = ${DB_RES_POST}" \
  || bad "DB 三查残留在跑后非零：${DB_RES_POST}"

# ── 残留四查：容器 / 网络 / 卷 / 端口 ────────────────────────────────────
cleanup_fake
FE_LEFT="$(docker ps -a --filter "name=${FE_NAME}" --format '{{.Names}}')"
[[ -z "$FE_LEFT" ]] \
  && ok "残留①容器：假执行器 ${FE_NAME} 已删除（无残留）" \
  || bad "残留①容器：${FE_LEFT} 仍在"
STACK_CONTAINERS="$(docker ps -a --filter "name=${SMOKE_STACK}" --format '{{.Names}}' | sort | tr '\n' ' ')"
echo "    | acfsmoke 前缀容器（应为栈自己那 3 个）：${STACK_CONTAINERS}"
N_STACK="$(printf '%s' "$STACK_CONTAINERS" | tr ' ' '\n' | grep -c . || true)"
[[ "$N_STACK" == "3" ]] \
  && ok "残留①容器：${SMOKE_STACK} 前缀容器恰 3 个（pg / redis / admin-api，无额外）" \
  || bad "残留①容器：${SMOKE_STACK} 前缀容器 ${N_STACK} 个（期望 3）"

NETS="$(docker network ls --filter "name=${SMOKE_STACK}" --format '{{.Name}}' | sort | tr '\n' ' ')"
[[ "$NETS" == "${SMOKE_NET} " ]] \
  && ok "残留②网络：只有 ${SMOKE_NET}（本脚本没有新建网络）" \
  || bad "残留②网络：实测 '${NETS}'（期望只有 ${SMOKE_NET}）"
VOLS="$(docker volume ls --filter "name=${SMOKE_STACK}" --format '{{.Name}}' | sort | tr '\n' ' ')"
echo "    | 卷：${VOLS:-（空）}"
[[ "$VOLS" == *"${SMOKE_STACK}-uploads"* || -z "${VOLS// /}" ]] \
  && ok "残留③卷：只有栈自己的 uploads 卷（无本脚本新建的卷）" \
  || bad "残留③卷：出现意外卷 '${VOLS}'"
PUB_8002="$(docker ps -a --format '{{.Ports}}' | grep -c '8002->' || true)"
[[ "$PUB_8002" == "0" ]] \
  && ok "残留④端口：没有任何容器发布宿主 8002（假执行器只在该网络上监听）" \
  || bad "残留④端口：有 ${PUB_8002} 个容器发布了 8002"
if (exec 3<>"/dev/tcp/127.0.0.1/${FE_PORT}") 2>/dev/null; then
  bad "残留④端口：宿主 127.0.0.1:${FE_PORT} 仍有监听"
else
  ok "残留④端口：宿主 127.0.0.1:${FE_PORT} 无监听（已随容器销毁）"
fi
TMP_LEFT="$(ls /tmp/acf-smoke-dispatch-push-* 2>/dev/null | tr '\n' ' ' || true)"
[[ -z "$TMP_LEFT" ]] \
  && ok "残留：/tmp 中间文件（假执行器 JS / env 快照 / 触发回包）已全部删除" \
  || bad "残留：/tmp 还有 ${TMP_LEFT}"
IN_CONTAINER_JS="$(docker exec "$SMOKE_API_CONTAINER" sh -c 'ls /tmp/fakeexec-loop.js 2>/dev/null || true')"
[[ -z "$IN_CONTAINER_JS" ]] \
  && ok "残留：admin-api 容器内无假执行器 JS 残留" \
  || bad "残留：admin-api 容器内还有 ${IN_CONTAINER_JS}"

printf '\n=== 场景 9（dispatch push 传输分支）小结：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
exit 0
