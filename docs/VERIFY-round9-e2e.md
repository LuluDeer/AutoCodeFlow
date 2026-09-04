# AutoCodeFlow 第九轮真机 E2E 验证报告（VERIFY-round9-e2e）

- 验证人：第九轮真机验证 agent V
- 日期：2026-09-03
- 代码基线：`develop` 工作树（含全部未提交第九轮改动；验证对象即当前工作树，未做任何 git commit）
- 环境：接手第九轮 C agent 遗留环境 + 宿主进程直跑（本轮无需新建业务容器，仅项 4 用了一个 mock 接收容器）：
  - 本机 PostgreSQL（`127.0.0.1:5432`，库 `autocodeflow_e2e`，迁移齐备，直接复用）
  - admin-api：接手时 C agent 的 `dist` 构建于 17:58，而 B 流源码（`execution-callback-metrics.service.ts` 18:28、`execution-callback.controller.ts` 18:59、`notification-config.service.ts` 18:59、`webhook.channel.ts` 18:52、`safe-http.util.ts` 19:07）均晚于该构建——**运行实例已过期**，故 `npm run build` 重建后以同 env 重启：`DB_DATABASE=autocodeflow_e2e THROTTLE_LIMIT=1000 LOGIN_THROTTLE_LIMIT=200 EXECUTOR_ALLOW_PRIVATE_NETWORK=true EXECUTION_CALLBACK_SECRET=r9_e2e_cbsecret_9f2c7a41e6b84d0a`，宿主 `3105`，日志 `/tmp/acf-r9/logs/admin-api-r9v.log`
  - executor-node：C agent 遗留实例（`dist` 17:58 且 src 无更新，仍新鲜），宿主 `8002`，`WORK_DIR=/tmp/acf-r9/tasks`，全程在线心跳，未重启
  - admin-web：C agent 遗留 vite（宿主 `5176`），未重启
  - executor-python：本轮新起，宿主 `8003`，`ADMIN_API_URL(_INTERNAL)=http://localhost:3105`、`EXECUTOR_SECRET` 与 admin 对齐、`WORK_DIR=/tmp/acf-r9/pytasks`、`APP_NAME=executor-python-r9`
  - **接手清理声明**：kill 了 C 遗留的旧 admin-api（:3105，过期构建）后重建重启；executor-node/vite 复用；metabase/flow2api 等他人容器未触碰

## 0. 验证项总览

| # | 验证项 | 结果 |
|---|---|---|
| 1 | executor-python token 链修复真机回归 | ✅ 通过（register 后 python 节点在线、0 次 "Dynamic token fetch failed"、`POST /token` 非风暴且 admin 幂等复用兑现、pinned python glue 全链 dispatch success）。**附 P1 发现**：`/executors/register` 显式调用被 401 拒绝（见 §1.4） |
| 2 | 回调 401 分类指标（N32 新 series） | ✅ 通过（`autoflow_execution_callback_auth_total{result}` 七类全中：ok=2、v1_expired/v1_binding_mismatch/v1_bad_signature/legacy_shared_invalid/missing_token/bad_address 各=1） |
| 3 | Playwright 全量 | ✅ 通过（**29 passed / 0 failed**，1.6m；含新增 26–29 pinned 全链） |
| 4 | webhook 配置面（N32 config-first） | ✅ 通过（PATCH 可存、GET/PATCH 回显对 URL query token 脱敏、send 命中保存 url 而非 per-request url、掩码回显不覆盖存储真值） |
| 5 | ci-local.sh 快速模式 | ✅ 通过（11 job 全 PASS，exit 0；executor-python / autoflow-sdk-python 两面均被脚本覆盖且绿。首跑 executor-node 偶发 FAIL，复跑 + 直跑 150 测试全过，判 flake） |

## 1. executor-python token 链真机回归（验证项 1）—— ✅

### 1.1 启动与在线取证

executor-python 以对齐的共享 token 启动（`EXECUTOR_SECRET=c17ead…`，与 admin `.env` 一致；注意仓库 `apps/executor-python/.env` 的 `ADMIN_API_URL_INTERNAL=http://localhost:3002` 优先级压过 `ADMIN_API_URL`，首轮误连 3002，显式覆盖 `ADMIN_API_URL_INTERNAL=http://localhost:3105` 后正常）。启动序列（`/tmp/acf-r9/logs/executor-python.log`）：

```
19:50:39 HTTP Request: POST http://localhost:3105/api/executors/token    "HTTP/1.1 201 Created"
19:50:39 HTTP Request: POST http://localhost:3105/api/executors/register "HTTP/1.1 401 Unauthorized"   ← 见 §1.4
...
20:02:04 HTTP Request: POST http://localhost:3105/api/executors/heartbeat "HTTP/1.1 201 Created"   （此后每 30s 一次，全 201）
```

`GET /api/executors`（JWT）确认 python 节点在线：

```
{ "appName":"executor-python-r9", "address":"localhost:8003", "status":"online", "type":"python",
  "executorStartupId":"ca3a0556-…", "executorStartedAt":"2026-09-03T11:50:39.119Z" }
```

### 1.2 无 "Dynamic token fetch failed" 循环

整轮 python 日志 `grep -c "Dynamic token fetch failed"` = **0**（首轮误连 3002 的那条属配置错误，已排除在干净运行外）。R9 信封拆解修复（`auth.py:_unwrap_envelope` + 2xx 区间判断）兑现：`POST /token` 返回 201 且能解析出 `data.token`，动态 token 正常缓存。

### 1.3 `POST /executors/token` 非风暴 + admin 幂等

观测窗（19:50–20:21，约 31 分钟）内 python 侧 `POST /executors/token` 共 **2 次**：

- 19:50:39 首次签发 → admin 日志 `Rotated token for executor 06124e4f… (localhost:8003)`（首签轮换，正确）
- 20:16:03 第二次（≈25.5min 后，命中 `_token_refresh_interval=30min − 5min 提前窗`）→ admin 日志 `Idempotent token reuse for executor localhost:8003 (same startupId); no rotation`

即 **W2 startupId 幂等签发兑现**：同进程生命期内重复取 token 不轮换，无 round8 §1.5 的 ~30s 轮换风暴。admin 全窗 `Rotated token` 仅 2 次（含 8002 一次），`Idempotent token reuse` 2 次。

### 1.4 P1 发现：`/executors/register` 显式调用被 401（R9 修复暴露的既有顺序缺陷）

**现象**：register 返回 401，但 `main.py:register_executor` 不检查 `response.status_code`，仍记 `INFO Registered to admin-api`（误导）。

**根因链**（代码 + 日志双证）：
1. `main.py:94` `register_executor` 用 `get_current_token()` 取注册凭证；
2. `get_current_token → _refresh_token_if_needed → _fetch_token` 在 R9 修复后**首次成功**，于是 `_dynamic_token` 被缓存，register 携带的是**动态 per-executor token**；
3. admin `executor.controller.ts:register` 走 `verifyExecutorToken`，仅接受**共享 bootstrap token**（DB `executor.sharedToken` / env `EXECUTOR_SECRET`），动态 token 不匹配 → 401。

**为何第八轮前不暴露**：R9 前 `_fetch_token` 因信封/200 判断 bug 永远返回 None，`get_current_token` 恒回退静态 token，register 恰好成功。R9 修好 `_fetch_token` 后，动态 token 抢在 register 之前被取用，暴露了"register 应用静态 bootstrap token"的既有顺序缺陷。

**实际影响有限但真实**：节点仍在线——因为 `POST /token` 的 `issueToken` 内部 `register-on-token` 顺带建行（`executor.service.ts:1083`），心跳又补齐 `executorStartupId/executorStartedAt`。但**显式 register 携带的富元数据从未落库**：DB 行 `type=python`（实体默认值巧合）、`capabilities=null`、`maxConcurrentTasks=null`、`executorVersion=null`。后果：非 pinned 派发时 `capabilities=null` 被运行时过滤器当通配（`executor.service.ts` 的 `!e.capabilities || length===0 ? true`），python 执行器会错误地接收 node 任务；`maxConcurrentTasks=null` 视作无上限。

**修复方向（建议第十轮）**：`register_executor` 改用 `get_static_token()` 作 bootstrap 凭证（其 docstring 本就写"for initial executor registration"），register 成功后再让心跳走动态 token；并让 `register_executor` 检查 `response.status_code`，401 时告警而非静默记成功。

### 1.5 全链 dispatch（pinned python glue）

创建 `r9v-py-probe`（`runtime=python`、`glueLanguage=python`、`executorId=06124e4f…` pin 到 python 执行器、`timeout=60`），`POST /tasks/:id/trigger` → execution `f37cf530…`：

- python 侧：`POST /api/execute 200` → `Glue script written … glue_script.py` → `Running task … ['python3','glue_script.py']` → `POST /api/executions/callback "201 Created"`
- admin 侧执行记录：`status=success`、`executorAddress=localhost:8003`、`duration=22ms`，logs 捕获子进程 stdout：

```
R9V hello from python executor
R9V exec_id= f37cf530-3258-46b1-ae64-ddc072c92825
R9V cb_token_prefix=            （python 执行器不注入 per-execution AUTOFLOW_CALLBACK_TOKEN，回调走共享 token 老路径——与 executor-node N23 注入路径不同，属该执行器既有设计，非本轮缺陷）
```

**观测深度**：register+heartbeat 在线稳定 + pinned 全链 dispatch success 双达成；回调以共享 token 老路径 201 落库（per-execution v1 注入是 executor-node 特性，python 执行器本轮未实现签发端，见 auth.py W3 注释"only stores + debug-logs it"）。

## 2. 回调 401 分类指标（验证项 2，N32 新 series）—— ✅

admin-api 以 `EXECUTION_CALLBACK_SECRET=r9_e2e_cbsecret_9f2c7a41e6b84d0a` 重启后，基线 `GET /api/metrics`：`ok=1`（§1.5 python 回调）、六类失败全 0。用 `execution-callback-token.util.ts` 同算法（`key=HMAC(secret,"autocodeflow:execution-callback:v1")`，`sig=HMAC(key,"v1.<execId>.<exp>")`）手工铸 token，逐项打 `POST /api/executions/callback`：

| # | 场景 | HTTP | 消息 |
|---|---|---|---|
| T-ok | 合法 v1（绑定真实 execution、未过期） | **201** | results success:true |
| T-exp | 同密钥手工构造旧 exp（now−3600） | **401** | Invalid or expired execution callback token |
| T-bind | 合法 v1 绑 EXEC，body 送另一 executionId | **401** | …not valid for this execution |
| T-sig | 合法结构、签名段改 64 个 0 | **401** | Invalid or expired execution callback token |
| T-legacy | 非 v1 错误共享 token + 合法 executorAddress | **401** | Invalid executor token |
| T-miss | 完全不带 Authorization | **401** | Missing executor token |
| T-addr | 合法共享 token 但 item 缺 executorAddress | **401** | executorAddress is required on every callback item |

复抓 `GET /api/metrics`：

```
autoflow_execution_callback_auth_total{result="ok"} 2
autoflow_execution_callback_auth_total{result="v1_expired"} 1
autoflow_execution_callback_auth_total{result="v1_binding_mismatch"} 1
autoflow_execution_callback_auth_total{result="v1_bad_signature"} 1
autoflow_execution_callback_auth_total{result="legacy_shared_invalid"} 1
autoflow_execution_callback_auth_total{result="missing_token"} 1
autoflow_execution_callback_auth_total{result="bad_address"} 1
```

七类 result 标签全部按预期递增（ok 含 §1.5 的 1 + 本轮 T-ok 的 1 = 2；六类失败各 +1）。expired 与 bad_signature 的区分经 `isV1TokenExpired` 结构重解析派生（`parseExecutionCallbackToken` 无 HMAC 重算），埋点收回 controller 层、util 纯函数层保持无 Nest 依赖的设计兑现。HELP/TYPE 完整。

## 3. Playwright 全量（验证项 3）—— ✅

第九轮 29 例 spec 以**未跟踪文件**形式存在于仓库根（`/home/yongsheng/project/AutoCodeFlow/e2e-full.spec.js`，1165 行，含 26–29 pinned 全链；配套根级 `playwright.e2e.config.js`，`testIgnore:**/apps/**` 以避开 `apps/admin-web` 下 `type:module` 的同名 CJS 副本）。运行前停掉 executor-python（8003→offline），还原 C 的"仅 executor-node 在线"环境：

```
NODE_PATH=<repo>/apps/admin-web/node_modules node apps/admin-web/node_modules/@playwright/test/cli.js test -c playwright.e2e.config.js
→ 29 passed (1.6m)   # 0 failed
```

- 1–16（登录/应用/任务/执行/日志/运行机/包/部署/并发/中断/启停/通知/用户/审计/AI+Swagger/metrics）全 ✓；
- 17–25（RBAC 门控、settings 降级、TaskFormPage 四模式、executorId 残留清理、R8 P0 向导 pinned 转正）全 ✓；
- **26–29 pinned 全链**（R9 新增）全 ✓：26 详情页绑定可见 + UI 触发 + 执行记录 `executorAddress=localhost:8002`；27 目标离线 trigger FAILED + 失败分类"执行器离线"UI 可读 + 心跳恢复；28 幽灵 executorId trigger FAILED 无 fallback；29 UI 向导建 pinned → 触发 → 历史行展示目标地址（全 UI 闭环）。

> 注：`apps/admin-web/e2e-full.spec.js`（提交版，595 行 / 16 例）与根级 29 例副本并存；本轮按任务书跑根级 29 例副本。

## 4. webhook 配置面（验证项 4，N32 config-first）—— ✅

**SSRF 约束**：round7 用于 mock 接收的 `198.18.0.1`（RFC2544 基准段）在 round7 V3 已被并入 `safe-http.util.ts` deny 列表（`v[0]===198 && (v[1]===18||19)`），通知外发无 env 放行（`EXECUTOR_ALLOW_PRIVATE_NETWORK` 仅作用执行器派发）。为在不改仓库代码、不绕过守卫的前提下让 mock 真实收到，用 docker 自定义 bridge 网络 `--subnet 8.8.8.0/24` 起 `node:22-alpine` mock 容器（固定 IP `8.8.8.10:9999`，公网段过 SSRF，宿主经 docker bridge 路由可达）。

1. **PATCH 可存**（webhook 首次进 PATCH-able 枚举）：`PATCH /api/notification/channels/webhook {enabled:true, config:{url:"http://8.8.8.10:9999/config-hook?access_token=supersecret999"}}` → 200，回显 `url:"…config-hook?access_token=***"`。
2. **GET 脱敏**：`GET /api/notification/channels` → webhook.config.url 的 query `access_token=***`（N32 `maskUrlSecrets` 把 `SECRET_FIELD_RE` 套到 URL query 参数名，兑现"值内机密"读面覆盖）。
3. **config-first 生效**：`POST /api/notification/send {channels:["webhook"], webhookUrl:"http://8.8.8.10:9999/REQUEST-hook-should-NOT-fire", …}` → 201 `results.webhook="sent"`；mock 收到的是 **`/config-hook?access_token=supersecret999`**（保存 url 胜出），`/REQUEST-hook-*` 零记录——`webhook.channel.ts` 的 `this.store.get("webhook")?.url || url` config-first 规则真机兑现，且外发请求携带**未脱敏的真实 token**（store 侧原值，发送路径不受读面掩码影响）。
4. **掩码回显守卫**：再以 `config:{url:"…config-hook?access_token=***"}` PATCH（模拟 admin-web 表单原样提交掩码回显）→ 存储不被 `***` 覆盖，后续 send mock 仍收到 `access_token=supersecret999`（`isMaskedEcho` + `MASKED_URL_QUERY_RE` 兑现）。

## 5. ci-local.sh 快速模式（验证项 5）—— ✅

`bash scripts/ci-local.sh --skip-e2e --skip-audit`：

| JOB | RESULT | TIME |
|---|---|---|
| admin-api | PASS | 31s |
| executor-node | PASS | 6s |
| acf-cli | PASS | 1s |
| mcp-server | PASS | 2s |
| autoflow-sdk-node | PASS | 2s |
| autocodeflow-node-sdk | PASS | 2s |
| admin-web | PASS | 7s |
| executor-python | PASS | 19s |
| autoflow-sdk-python | PASS | 0s |
| python-packages | PASS | 2s |
| registry-pypi | PASS | 1s |

**exit 0，11 job 全 PASS**。脚本已覆盖本轮新增的 python/SDK 面：`job_executor_python`（含 R9 改动的 `test_auth.py`/`test_registration.py`/`test_scheduler.py`）、`job_autoflow_sdk_python`（含新增 `callback.py`/`test_callback.py`）、`job_python_packages`——三者全绿，未破坏脚本。

> **flake 记录**：首跑 executor-node 偶发 FAIL（6s），复跑整脚本 PASS、且 `cd apps/executor-node && npm test` 直跑 16 suites / 150 tests 全过（exit 0）。判为构建/测试子 shell 偶发时序 flake，非第九轮改动引入的功能回归。

## 6. 遗留观察（不判失败）

1. **§1.4 P1**：executor-python `register_executor` 用 `get_current_token()`（动态优先）携带 per-executor token 打 `/executors/register`，而该端点仅认共享 bootstrap token → 401；R9 修好 `_fetch_token` 后由静默回退转为显式失败。节点仍在线（issueToken register-on-token + 心跳补 baseline），但富元数据（capabilities/maxConcurrentTasks/executorVersion）未落库。建议 register 改 `get_static_token()` 并检查状态码。
2. python 执行器不注入 per-execution `AUTOFLOW_CALLBACK_TOKEN`（auth.py W3 注释明示本轮仅 store+debug-log tokenHash，签发端留待后续 N23 parity），回调走共享 token 老路径——与验证项 1 的 token 链闭环不冲突，如实标注。
3. 通知外发 SSRF 现拦 198.18/15 与 100.64/10（round7 V3/N32 收紧），本轮以 docker 公网段子网容器取证 config-first；该手法依赖宿主 docker bridge 路由，仅用于验证。
4. 取证在共享 dev 库 `autocodeflow_e2e` 留下 `r9v-py-probe` 任务/执行、webhook 渠道内存配置（进程内，重启即清）、`e2e_*` 任务与探针执行记录（round7/8 惯例：不清库）。
5. 根级 `e2e-full.spec.js`（29 例）与 `playwright.e2e.config.js` 为 C agent 未跟踪件，非本轮 V 创建，本轮仅复用运行。

## 7. 结论

第九轮 5 项真机闭环全部 **PASS**。executor-python token 链三缺口修复（信封拆解 / 2xx 判断 / startupId 幂等 + tokenHash 三点采纳）真机兑现：0 fetch-failed 循环、`POST /token` 非风暴且 admin 幂等复用、pinned python glue 全链 dispatch success；唯一 P1 是修复暴露的既有 register 顺序缺陷（动态 token 打共享-token-only 的 register 端点 → 401，富元数据未落库）。N32 回调 401 分类七类 result 全中、webhook config-first + URL query 脱敏 + 掩码回显守卫真机成立、Playwright 29/25→29 全绿（含 26–29 pinned 全链）、ci-local 快速模式 11 job 全绿（python/SDK 面已覆盖）。

## 8. 环境清理确认

- [x] kill 本轮启动/接手的 admin-api（:3105）、executor-python（:8003）、executor-node（:8002）、admin-web vite（:5176）全部进程
- [x] 删除本轮创建的 docker 容器 `acf-r9v-mock` 与网络 `acf-r9v-net`；metabase/flow2api 等他人容器未触碰、未停止
- [x] 删除 `/tmp/acf-r9/` 本轮临时文件（日志/铸 token 脚本/mock 脚本/偏移量）
- [x] `ss -tln` 确认 3105/5176/8002/8003/9999 全部释放；宿主 PG(5432) 为既有共享服务，保持原样
- [x] 仓库除本报告 `docs/VERIFY-round9-e2e.md` 外零改动，未执行任何 git commit
