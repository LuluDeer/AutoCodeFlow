# AutoCodeFlow 第八轮真机 E2E 验证报告（VERIFY-round8-e2e）

- 验证人：第八轮真机验证 agent V
- 日期：2026-09-03
- 代码基线：`develop` 工作树（含全部未提交第八轮改动；验证对象即当前工作树，未做任何 git commit）
- 环境：宿主 PG/Redis 直用 + 宿主进程直跑（本轮无需新建 docker 容器）：
  - 本机已在跑的 PostgreSQL（`127.0.0.1:5432`，库 `autocodeflow_e2e`，25 条迁移齐备、schema 无冲突，直接复用）与 Redis（`6379`，密码认证）
  - admin-api：`apps/admin-api` `npm run build` 后 `node dist/main`，宿主 `3105`，env：`DB_DATABASE=autocodeflow_e2e THROTTLE_LIMIT=1000 LOGIN_THROTTLE_LIMIT=200 EXECUTOR_ALLOW_PRIVATE_NETWORK=true`（同机 loopback 派发所必需），artifact/metrics 阶段追加 `EXECUTOR_ARTIFACT_DIR=/tmp/acf-r8/artifacts`，token 全链阶段追加 `EXECUTION_CALLBACK_SECRET=<专用值>`；日志 `/tmp/acf-r8/admin*.log`
  - executor-node：`npm run build` 后 `node dist/main.js`，宿主 `8002`，`EXECUTOR_ADDRESS=localhost:8002`、`WORK_DIR=/tmp/acf-r8/tasks`，共享 token 与 admin-api 对齐（仓库 `.env` 的 `EXECUTOR_SECRET`）；注册 online、心跳正常
  - admin-web：`npm run dev`（vite，宿主 `5176`）
  - **前置清理声明**：接手时 3105/5176/8002/3199 被今日早前会话遗留的旧构建进程占用（admin-api×2、executor、vite），全部 kill 后以当前工作树重建重启；metabase/flow2api 等他人容器未触碰
- 取证任务：`r8-cbtoken-probe`（glue node，打印注入 env）与 `r8-cbtask-probe`（glue node，任务代码内直接用 `AUTOFLOW_CALLBACK_TOKEN` 回调），均 pin 到在线执行器，execution 终态 success

## 0. 验证项总览

| # | 验证项 | 结果 |
|---|---|---|
| 1 | per-execution 回调 token 全链（注入级 + 验证级 HTTP） | ✅ 通过（注入级 5 项取证全中；验证级 201/401/401/401/201 全中；任务代码内回调 201 闭环。**附 P1 发现**：默认配置（N26 per-executor tokenHash 签名路径）被既有 `/token` 轮换循环在秒级击穿，见 §1.5） |
| 2 | Playwright E2E 全量 25 例 | ✅ 通过（**25 passed / 0 failed / 0 skipped**，1.1m；#25 转正兑现） |
| 3 | install.sh artifact 通道回归 | ✅ 通过（打包→下载鉴权矩阵→解压完整性；注册 online 全链路第七轮 B 流已真机过，本轮按任务书做到下载+解压） |
| 4 | ci-local.sh 快速模式 | ✅ 通过（11 job 全 PASS，exit 0，总耗时 ~73s） |
| 5 | /api/metrics 回归（含 N31 render 串行化） | ✅ 通过（200 prom 格式 + 17 条 autoflow series；30 并发抓取全 200 零畸形、共享同一快照；JSON 端点同源自洽） |

## 1. per-execution 回调 token 全链（验证项 1）—— ✅

### 1.1 注入级取证（glue 任务执行日志）

`r8-cbtoken-probe`（`triggerType=manual`、`runtime=node`、`glueSource`/`glueLanguage=javascript`、pin 到 `executor-node-1`）执行 `c19e54ce` success，子进程 stdout（execution logs + 执行器 file-logger 双取证）：

```
R8PROBE token_present=true
R8PROBE token_full=v1.c19e54ce-7b57-417a-a074-f58c5fea8b22.1788422910.508128653554431c7d87fb75db88d15e6950ee61e1f370d3461efc4c0b57dc2d
R8PROBE EXECUTOR_SHARED_TOKEN_type=undefined
R8PROBE EXECUTOR_SECRET_type=undefined
R8PROBE EXECUTION_CALLBACK_SECRET_type=undefined
R8PROBE AUTOFLOW_ADMIN_API_URL=http://localhost:3105
R8PROBE AUTOFLOW_EXECUTOR_ADDRESS=localhost:8002
R8PROBE EXECUTION_ID=c19e54ce-7b57-417a-a074-f58c5fea8b22
```

- token 形状 `v1.<executionId>.<exp>.<hmac64>`，executionId 与真实执行逐字一致，exp=签发时刻+timeout(60)+grace(900) ✅
- `EXECUTOR_SHARED_TOKEN`/`EXECUTOR_SECRET` 均 `undefined`（SEC-01 白名单未破），HMAC 源密钥 `EXECUTION_CALLBACK_SECRET` 同样不下发（denylist 兑现）✅
- `AUTOFLOW_ADMIN_API_URL`/`AUTOFLOW_EXECUTOR_ADDRESS` 注入取证 ✅
- 离线复核：用两端共享的专用密钥按 `execution-callback-token.ts` 同算法重算 HMAC，与注入 token 签名逐字节相等 ✅

### 1.2 验证级（HTTP 直接打 `POST /api/executions/callback`）

配置：admin-api 与 executor-node 同设 `EXECUTION_CALLBACK_SECRET`（fleet-global 主路径，候选 #1）。取样即 §1.1 注入 token：

| # | 场景 | 结果 |
|---|---|---|
| T1 | Bearer=注入 token，body `[{executionId:<该执行>, status:"success", executorAddress:"localhost:8002"}]` | **201** `{"results":[{executionId,success:true}]}`（Nest POST 默认 201，即任务书"200"成功语义）✅ |
| T2 | 同 token，executionId 换成另一合法 UUID | **401** `Execution callback token is not valid for this execution`（execution 绑定语义，消息区别于签名失败）✅ |
| T3 | 同密钥手工构造旧 exp（now−3600）token | **401** `Invalid or expired execution callback token`（过期 fail-closed）✅ |
| T3b | 篡改签名（64 个 0） | **401** 同上 ✅（附加） |
| T4 | Bearer=共享 token 老路径回归 | **201** results success ✅（TASK-001 per-address 校验→单地址回退 `verifyExecutorToken` 未回退） |

### 1.3 任务代码内回调（最真实的全链闭环）

`r8-cbtask-probe`：glue 脚本用 `AUTOFLOW_CALLBACK_TOKEN` + `AUTOFLOW_ADMIN_API_URL` + `AUTOFLOW_EXECUTOR_ADDRESS` + `EXECUTION_ID` 直接 `fetch POST /api/executions/callback`，执行器 file-logger 记录：

```
R8PROBE2 in_task_callback HTTP=201 body={"code":201,...,"results":[{"executionId":"10cf57e2-...","success":true}]}
```

且该 execution 行 `logs` 字段被回调携带的 `logs:"callback-from-task-code"` 覆盖、终态 success——**执行器签发 → env 注入 → 任务代码持 token 回调 → admin 验签放行 → 执行记录落库**全链在真机成立 ✅（随后执行器自身的 pushCallback 到达时 execution 已终态，原子终态转移语义正确吞掉重复回调）。

### 1.4 N26 per-executor tokenHash 路径（默认配置）—— 组件各自成立，稳态被轮换击穿

默认配置（不设 `EXECUTION_CALLBACK_SECRET`）下分段取证：

- **执行器侧签发**：executor 注册时采纳 admin 返回的 `tokenHash`（main.ts:91-93），注入 token 的签名与注册时刻 DB 存储的 bcrypt tokenHash 作 HMAC 密钥逐字节吻合（race 窗口内实测 `sig==HMAC(hash-at-register): True`）✅
- **admin 侧回退验签**：用 DB 当前 tokenHash 手工铸 token 直打 → **201**（`verifyAgainstPerExecutorSecrets` per-address 回退兑现）✅
- **但稳态不可用**：见 §1.5。

### 1.5 P1 发现：`/api/executors/token` 轮换循环击穿 N26 不变量（既有缺陷 × 新依赖）

默认配置下，注入 token 在**秒级窗口外即 401**（实测：注册后 +2s 的 T1、+11s 的任务内回调均 401，且 401 时刻与一次 `Rotated token` 日志同秒）。根因链（代码+日志双重证实）：

1. `apps/executor-node/src/middleware/auth.ts:92` `fetchToken()` 读 `response.data.token`，而 admin-api 全局 ResponseInterceptor 把响应包成 `{code,message,data:{token}}` → 永远解析出 `undefined` → `dynamicToken` 永不缓存，仅 `console.warn` 后按 30s backoff 无限重试（`middleware/auth.ts` 该文件第八轮未改动，属**既有缺陷**）；
2. 每次重试即一次 `POST /api/executors/token`，而该端点（`executor.controller.ts:593` `getToken`）**每次调用都 `rotateToken()`** → DB 存储的 tokenHash 以 ~30s 节奏轮换（本轮实测 9 分钟 14 次，admin 日志 `Rotated token for executor ... (localhost:8002)`）；
3. 第八轮 N26 把"执行器注册时采纳的 tokenHash"定为 HMAC 源密钥（`execution-callback-token.ts` 头注 INVARIANT：signing secret 必须等于 admin 当前存储 tokenHash）——轮换即失配。首个触发点甚至早于 30s：执行完成时执行器自身 pushCallback 走 `getCurrentToken()` → fetchToken → rotate，实测注册后 ~2s 存储哈希已换。

**判定**：per-execution token 机制本身（签发/注入/验签/绑定/过期/老路径回归）全部兑现，验证项 1 记 PASS；但 **N26 的 per-node `--secret` 部署故事在默认配置下稳态不可用**——任务代码只有在"执行器 pushCallback 轮换之前"（即任务运行期间先于进程退出回调，§1.3 恰是该窗口）才能用注入 token 成功回调，执行完成后的回调必 401。修复方向（任选其一，建议后续轮次）：a) `fetchToken` 改读 `response.data.data?.token ?? response.data.token`（对齐 main.ts register 的双形状读取）；b) `getToken` 端点幂等化（同 startupId 不轮换，对齐 N4 register 语义）；c) N26 采纳后在心跳里同步刷新 `executorTokenHash`。

## 2. Playwright E2E 全量（验证项 2）—— ✅

按任务书环境（admin-api :3105 / admin-web :5176 / executor-node :8002 在线）运行：

```
NODE_PATH=<repo>/apps/admin-web/node_modules node apps/admin-web/node_modules/@playwright/test/cli.js test -c playwright.e2e.config.js
→ 25 passed (1.1m)   # 0 failed，0 skipped，无 fixme 残留
```

- 用例 1–16（登录/应用/任务/执行/运行机/包/部署/并发/中断/启停/通知/用户/审计/AI+Swagger/metrics）全 ✓；
- 第八轮新增 17–21（RBAC 门控、settings AI Tab 降级与 admin 正常读取）全 ✓；
- 22–24（TaskFormPage 四模式切换、pinned↔broadcast/auto 的 executorId 残留清理，服务端复核 `executorId=null`+`executeMode` 正确）全 ✓；
- **25 转正兑现**：创建向导 pinned 提交返回 201、携带完整字段与 `executorId`、UI 显示"任务已创建成功"——R8 P0（TaskFormPage `getFieldsValue(true)` 修复）真机闭环 ✓。
- 截图落 `/tmp/e2e-*.png`；无需修改任何 spec。

## 3. install.sh artifact 通道回归（验证项 3）—— ✅

1. **打包**：`bash scripts/bundle-executor-artifact.sh --out /tmp/acf-r8/artifacts` → exit 0，产物 `executor-node.tar.gz` 2.2 MB，`sha256=4704fe9985f48ccd828fdac4a7dfc45ae9ea0a59a192889a512a9ac45add24ee`
2. **下发鉴权矩阵**（admin-api 以 `EXECUTOR_ARTIFACT_DIR=/tmp/acf-r8/artifacts` 重启）：

| 请求 | 结果 |
|---|---|
| `GET /api/executors/artifact/executor-node.tar.gz` 无 token | **401** ✅ |
| Bearer=错误 token | **401** ✅ |
| Bearer=共享 token | **200** `application/gzip` 2210918B ✅ |
| `?token=<共享>` query 兜底 | **200** 同尺寸 ✅ |

   两种下载 sha256 与打包一致 ✅
3. **解压验证**：`tar -xzf` 后 `dist/main.js` 在位（39 个 js，与源构建目录一致）、`package.json`（7 个 prod 依赖）、`node_modules` 107 项，`require('express')/require('axios')` 成功——裸机 `curl|bash` 安装通道自洽 ✅
4. 执行器注册 online 完整链路第七轮 B 流已真机过，本轮按任务书止于下载+解压。

## 4. ci-local.sh 快速模式（验证项 4）—— ✅

`bash scripts/ci-local.sh --skip-e2e --skip-audit` → **exit 0，11 job 全 PASS**：

| JOB | RESULT | TIME |
|---|---|---|
| admin-api | PASS | 34s |
| executor-node | PASS | 6s |
| acf-cli | PASS | 1s |
| mcp-server | PASS | 2s |
| autoflow-sdk-node | PASS | 2s |
| autocodeflow-node-sdk | PASS | 2s |
| admin-web | PASS | 8s |
| executor-python | PASS | 16s |
| autoflow-sdk-python | PASS | 1s |
| python-packages | PASS | 1s |
| registry-pypi | PASS | 1s |

admin-api 53 suites 全过（含本轮新增 `execution-callback-token.util.spec.ts`）、executor-node 16 suites 全过（含 `execution-callback-token.spec.ts`）、两 SDK 48/52 tests 全过、admin-web lint+build+vitest 过（含 `task-form-page.test.tsx`）。

## 5. /api/metrics 回归（验证项 5，N31 render 串行化）—— ✅

- `GET /api/metrics`（JWT）→ **200** `text/plain; version=0.0.4; charset=utf-8`；`autoflow_*` 17 条 series 齐全（scheduler ticks/tick_duration/last_tick/triggers{result}×2/triggers_skipped{reason}×4/dependency_triggers×2 + queue_up + queue_depth{state}×5），HELP/TYPE 完整；无 JWT → 401 ✅
- **N31 并发回归**：30 路并发 GET → 30×200、0 畸形（每条都含完整 `autoflow_scheduler_ticks_total` 与 `autoflow_queue_up`），且 30 份输出 ticks 值全等于同一快照（=7）——`renderInFlight` 共享重建语义兑现，无 reset/inc 交错破坏 ✅
- `GET /api/metrics/scheduler` → 200，五段结构完整，`counters.ticks=7` 与 prom 端点同源自洽 ✅

## 6. 遗留观察（不判失败）

1. **§1.5 P1**：`fetchToken` 信封解析缺陷 + `getToken` 非幂等轮换 → N26 稳态击穿，建议按 §1.5 三选一修复（根因在既有代码，第八轮 N26 使其首次产生功能后果）。
2. 任务书 T1/T4 写"→200"，实现为 Nest POST 默认 **201**（成功语义一致，鉴权/结果体均正确），按 2xx 记 PASS。
3. 同机部署需 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true` 才能 loopback 派发（本轮全程开启，仅作用于 `assertSafeExecutorUrl`，与 round7 §1.4 结论一致）。
4. E2E 与本轮取证在共享 dev 库 `autocodeflow_e2e` 留下探针任务/执行记录与 `e2e_*` 任务、`e2e_user` 用户（round7 惯例：不清库，库本身即 e2e 专用）。
5. 执行器 `WORK_DIR` 下 `callbacks/` 空目录残留（失败回调持久化通道未触发，属正常）。

## 7. 结论

第八轮 5 项真机闭环全部 **PASS**。本轮最大功能 per-execution 回调 token 三端贯通：注入级（token 形状/绑定/TTL、SEC-01 密钥不下发、路由 env 注入）与验证级（有效 201、错 executionId 401、过期 401、篡改 401、共享 token 老路径 201）全中，任务代码持注入 token 直接回调 201 完成最真实的全链闭环；Playwright E2E 25/25 全绿且 #25（R8 P0 TaskFormPage 修复）转正；artifact 通道打包→鉴权→解压完整自洽；ci-local 快速模式 11 job 全绿；N31 render 串行化并发抓取零畸形。唯一 P1 发现是既有 `fetchToken` 信封解析缺陷叠加 N26 新依赖导致 per-executor tokenHash 签名路径稳态不可用（~30s 轮换循环），已给出三条修复方向，建议第九轮优先处理。

## 8. 环境清理确认

- [x] kill 本轮启动的 admin-api（:3105）、executor-node（:8002）、admin-web vite（:5176）全部进程（含早前会话遗留的 :3199 旧 admin-api）
- [x] 本轮未创建任何 docker 容器；metabase/flow2api 等他人容器未触碰、未停止
- [x] 删除 `/tmp/acf-r8/` 全部临时文件（日志/env/产物/解压目录/脚本）
- [x] `ss -tln` 确认 3105/5176/8002/3199 全部释放；宿主 PG(5432)/Redis(6379) 为既有共享服务，保持原样
- [x] 仓库除本报告外零改动，未执行任何 git commit
