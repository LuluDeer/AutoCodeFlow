# AutoCodeFlow 第十一轮真机 E2E 验证报告（VERIFY-round11-e2e）

- 验证人：第十一轮真机验证 agent V
- 日期：2026-09-04
- 代码基线：`develop` 工作树（含全部未提交第十一轮改动；验证对象即当前工作树，未做任何 git commit）
- 环境：宿主进程直跑（本轮无需业务容器）：
  - 本机 PostgreSQL（`127.0.0.1:5432`，库 `autocodeflow_e2e`，迁移齐备——`executorVersion`/`deletedAt` 等列实测在位，直接复用）
  - admin-api：工作树 `executor.controller.ts`（16:52）晚于遗留 `dist`（9/3 19:36），`npm run build` 重建后启动：`DB_DATABASE=autocodeflow_e2e THROTTLE_LIMIT=1000 LOGIN_THROTTLE_LIMIT=200 EXECUTOR_ALLOW_PRIVATE_NETWORK=true EXECUTION_CALLBACK_SECRET=r11_e2e_cbsecret_4a7c2e91b5d84f3c`，宿主 `3105`，日志 `/tmp/acf-r11/logs/admin-api.log`
  - executor-node：`npm run build` 重建后启动，宿主 `8002`，`APP_NAME=executor-node-r11`、`WORK_DIR=/tmp/acf-r11/tasks`，共享 token 与 admin `.env` 的 `EXECUTOR_SECRET` 对齐（经 `apps/executor-node/.env`），注册在线
  - admin-web：vite 宿主 `5176`（`--strictPort`），日志 `/tmp/acf-r11/logs/admin-web.log`
  - **环境注意（非仓库缺陷）**：宿主 shell 带全局 `HTTP(S)_PROXY=192.168.3.35:7897`，axios/curl 默认走代理导致对 `localhost` 的调用被代理回 502——两服务均以剥离代理变量 + `NO_PROXY='*'` 重启后正常；Playwright 同理在干净 env 下运行。

## 0. 验证项总览

| # | 验证项 | 结果 |
|---|---|---|
| 1 | reload-config 修复真机验证（R11 P1：rotateToken→issueToken 幂等复用） | ✅ 通过（连续两次推送 2xx + executor 日志逐字段确认热更 + admin 日志两次 "Idempotent token reuse; no rotation"、0 次 "Failed to reach executor"；负对照错误 token 直打 executor 401 证明守卫真实生效） |
| 2 | Playwright 29 例重跑（N48：antd 6.6.2 + playwright 1.62 升级回归证据） | ✅ 通过（**29 passed / 0 failed**，1.6m；选择器零失效。首跑 29 failed 系 1.62 升级后 chromium headless shell v1234 未安装的环境缺口，`npx playwright install chromium` 补齐后全绿） |
| 3 | 发布包安装冒烟（v1.0.0 三包干净环境消费） | ✅ 通过（`@autocodeflow/sdk@1.0.0` require + `TaskContext.fromEnv()` 纯函数跑通；`autocodeflow-mcp-server@1.0.0` bin 可执行；PyPI `autoflow-sdk==1.0.0` `from autoflow_sdk import TaskContext` + 版本断言跑通。**附观察**：mcp bin 未实现 `--help` 分支，见 §3.2） |
| 4 | `/api/metrics` 回归（agent A executor 模块改动后） | ✅ 通过（JWT 下 200，24 条 `autoflow_*` series 完整，含 N32 回调七类 result 标签） |

## 1. reload-config 修复真机验证（验证项 1）—— ✅

### 1.1 缺陷与修复对照

原缺陷：admin `reloadConfig()` 调 `rotateToken()` 铸**新** secret 推送，executor `verifyToken` 只认 `[dynamicToken, staticToken]`（`apps/executor-node/src/middleware/auth.ts:116`）→ 必然 401 → "Failed to reach executor"。修复（`apps/admin-api/src/modules/executor/executor.controller.ts:550`）：改调 `svc.issueToken({address, appName, startupId: executor.executorStartupId})`——同 (address, startupId) 返回 admin 内存缓存中 executor 当前持有的明文（`executor.service.ts:1101` 的 R9 幂等签发），不轮换；另加 401 时"重签发 + 恰好一次重试"的 legacy/冷缓存兜底（`isUnauthorizedPushError`，controller L50-64/L583-608）。

### 1.2 token 链前置状态（推送凭证与 executor 持有物同源）

executor-node 启动注册后，admin 日志：

```
18:07:33 LOG  ExecutorService  Rotated token for executor a7c2e4fc-… (localhost:8002)      ← 首签（register→/token）
18:08:04 DEBUG ExecutorService  Idempotent token reuse for executor localhost:8002 (same startupId); no rotation  ← 心跳取 token，幂等复用
```

即 executor 的 `dynamicToken` 与 admin `issuedTokenCache` 中明文为同一 token——reload-config 的 issueToken 复用路径条件成立。

### 1.3 负对照（证明 2xx 非"无鉴权放行"）

以错误 token 直打 executor 推送端点：

```
POST http://127.0.0.1:8002/api/config/reload   Authorization: Bearer deadbeef…
→ HTTP 401 {"error":"Invalid or missing executor token"}
```

executor 守卫真实在验 token。修复前 admin 推 rotateToken 新 token 正等价于这条 401。

### 1.4 连续两次 reload-config（幂等复用语义稳定）

JWT 下对在线 executor `a7c2e4fc-0181-4ef8-a0e1-7af326903e49` 连续两次调用：

```
#1 POST /api/executors/:id/reload-config {"maxConcurrentTasks":7}
   → HTTP 201 {"code":201,…,"data":{"success":true,"message":"Updated 1 field(s)","updatedFields":["maxConcurrentTasks"]}}
#2 POST /api/executors/:id/reload-config {"maxConcurrentTasks":8,"taskTimeoutSeconds":600}
   → HTTP 201 {"code":201,…,"data":{"success":true,"message":"Updated 2 field(s)","updatedFields":["maxConcurrentTasks","taskTimeoutSeconds"]}}
```

> 状态码说明：端点未显式 `@HttpCode(200)`，Nest POST 默认 201——语义为成功（2xx），非缺陷，如实记录。

executor 侧日志逐字段确认收到并应用：

```
10:09:49.938Z [INFO] Hot-reloaded maxConcurrentTasks=7
10:09:50.154Z [INFO] Hot-reloaded maxConcurrentTasks=8
10:09:50.154Z [INFO] Hot-reloaded taskTimeoutSeconds=600
```

`GET :8002/health` 实时反映 `maxConcurrentTasks: 8`。

### 1.5 无异常与无轮换取证

- admin 日志 `grep -c "Failed to reach executor"` = **0**；两次推送时刻各出现一条 `Idempotent token reuse … no rotation`（18:09:49 / 18:09:50），全窗 `Rotated token` 仅 18:07:33 首签一次——**推送路径零轮换**，executor 持有的 dynamicToken 未被 invalidate；
- executor 日志 `[ERROR]` 计数 **0**，推送后心跳持续 201 在线（`lastHeartbeat` 持续推进，status=online）；
- 连续两次调用均成功，幂等复用语义稳定。

## 2. Playwright 29 例重跑（验证项 2）—— ✅

按 round9 环境（admin-api 3105 + executor-node 8002 在线 + vite 5176）运行根级 29 例副本：

```
NODE_PATH=<repo>/apps/admin-web/node_modules node apps/admin-web/node_modules/@playwright/test/cli.js test -c playwright.e2e.config.js
→ 29 passed (1.6m)   # 0 failed
```

- 1–16（登录/应用/任务/执行/日志/运行机/包/部署/并发/中断/启停/通知/用户/审计/AI+Swagger/metrics）全 ✓；
- 17–25（RBAC 门控、settings 降级、TaskFormPage 四模式、executorId 残留清理、R8 P0 向导 pinned 转正）全 ✓；
- 26–29 pinned 全链（详情页绑定、离线 FAILED 分类、幽灵 executorId、UI 向导建 pinned→触发→历史行展示 `executorAddress=localhost:8002`）全 ✓。

**升级回归证据（N48）**：antd 6.6.2 + playwright 1.62.1 下 29 例选择器零失效、零源码缺陷。唯一波折为**环境缺口**：首跑 29 failed，根因 `browserType.launch: Executable doesn't exist at …/chromium_headless_shell-1234/…`——1.62 升级后浏览器 revision 未随装；`cd apps/admin-web && npx playwright install chromium` 下载 Chrome Headless Shell 151.0.7922.34 (v1234) 后重跑全绿。未修改任何 spec/源码断言。

## 3. 发布包安装冒烟（验证项 3）—— ✅

对齐 round10 方法论：全部在**干净临时目录/venv**、官方源安装，验证发布物完整性。

### 3.1 npm `@autocodeflow/sdk`

```
/tmp/acf-r11/npm-smoke: npm init -y && npm install @autocodeflow/sdk --registry=https://registry.npmjs.org
node -e "require('@autocodeflow/sdk')" →
  installed version: 1.0.0
  exports: HttpClient,TaskContext,TaskLogger
  TaskContext.fromEnv()（EXECUTION_ID/TASK_ID/TASK_NAME 注入后）→ ctx.env.executionId='r11-smoke-exec' ✓
  SDK SMOKE PASS
```

### 3.2 npm `autocodeflow-mcp-server`

```
/tmp/acf-r11/mcp-smoke: npm install autocodeflow-mcp-server --registry=https://registry.npmjs.org
npx autocodeflow-mcp --help →
  [autocodeflow-mcp] WARNING: AUTOCODEFLOW_API_TOKEN is not set.
  [autocodeflow-mcp] Server started. API: http://localhost:3105
  （stdin 关闭后 exit 0）
```

bin 可执行、启动路径完整（生产依赖 36 包解析安装正常）。**观察**：`--help` 未实现为帮助分支——进程直接以 MCP stdio server 模式启动，stdin EOF 后退出。不影响"bin 可执行"结论，但 CLI 体验上建议后续补 `--help`/`--version` 处理。

### 3.3 PyPI `autoflow-sdk`

```
/tmp/acf-r11/py-smoke: python3 -m venv … && pip install --index-url https://pypi.org/simple autoflow-sdk
  Name: autoflow-sdk  Version: 1.0.0
python -c "from autoflow_sdk import TaskContext; assert autoflow_sdk.__version__=='1.0.0'"
  → import ok; TaskContext 公开成员 from_env/callback/log/get_param… 齐全
  PY SDK SMOKE PASS
```

三包在干净环境的安装 + import/执行成功，验证 v1.0.0 发布物（npm 两包 + PyPI 一包）完整性。

## 4. /api/metrics 回归（验证项 4）—— ✅

agent A 改动 executor 模块（`executor.controller.ts`/`executor.service.ts` 及两 spec）后：

```
GET /api/metrics（JWT）→ HTTP 200，24 条 autoflow_* series
```

覆盖 `autoflow_scheduler_*`（ticks/duration/triggers/skipped/dependency）、`autoflow_queue_up`、`autoflow_queue_depth{state}`、`autoflow_execution_callback_auth_total{result}` 七类（ok/v1_expired/v1_binding_mismatch/v1_bad_signature/legacy_shared_invalid/missing_token/bad_address）——HELP/TYPE 完整，计数面与本轮热修无冲突。注：该端点现处 `JwtAuthGuard` 后（`metrics.controller.ts:22`），匿名访问 401 属既有鉴权姿态，非本轮回归。

## 5. 遗留观察（不判失败）

1. **§3.2**：`autocodeflow-mcp` bin 无 `--help` 实现，直接进 server 模式；建议后续轮次补 CLI 帮助/版本分支。
2. **reload-config 不回写 DB**：推送只改 executor 运行时（`/health` 即时反映 8），admin 侧 `executors.maxConcurrentTasks` 仍为注册值 10——DB 元数据走 `PATCH /executors/:id`，与推送通道分离，属既有设计；若期望"推送即持久化"需后续轮次明确语义。
3. **宿主代理劫持 localhost**：本轮服务与 Playwright 均需剥离 `HTTP(S)_PROXY` 运行；属验证环境注意事项，与代码无关。
4. 取证在共享 dev 库 `autocodeflow_e2e` 留下 `executor-node-r11` 执行器行、`e2e_*` 任务与探针执行记录（round7–9 惯例：不清库）；executor 运行时配置热更值（8/600）随本轮 executor 进程终止消失，未持久化。
5. 根级 `e2e-full.spec.js`（29 例）与 `playwright.e2e.config.js` 为既有未跟踪件，本轮仅复用运行；首跑失败产生的 `test-results/` 目录已在清理阶段删除。

## 6. 结论

第十一轮 4 项真机闭环全部 **PASS**。R11 P1（reload-config 必然 401）修复真机兑现：issueToken 幂等复用使 admin 推送凭证与 executor 持有 token 同源，连续两次推送 2xx 且 executor 逐字段热更（maxConcurrentTasks 7→8、taskTimeoutSeconds 600），全程零轮换、零 "Failed to reach executor"，负对照 401 证明守卫有效；Playwright 在 antd 6.6.2 + playwright 1.62 升级后 29/29 全绿（补装浏览器 revision 即恢复，无选择器失效）；v1.0.0 三包干净环境安装冒烟全通过（mcp bin 无 --help 为体验观察）；/api/metrics 200 + 24 series 无回归。

## 7. 环境清理确认

- [x] kill 本轮启动的 admin-api（:3105）、executor-node（:8002）、admin-web vite（:5176）全部进程
- [x] 本轮未创建 docker 容器/网络；metabase/flow2api 等他人容器未触碰、未停止
- [x] 删除 `/tmp/acf-r11/` 本轮临时文件（日志/冒烟目录/venv）；删除仓库根 `test-results/` 首跑残留
- [x] `ss -tln` 确认 3105/5176/8002 全部释放；宿主 PG(5432) 为既有共享服务，保持原样
- [x] 仓库除本报告 `docs/VERIFY-round11-e2e.md` 外零改动，未执行任何 git commit
