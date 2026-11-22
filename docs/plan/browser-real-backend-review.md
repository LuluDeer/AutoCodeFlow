# R436 独立验收复核 —— 真后端 + 真浏览器北极星看板（终版结论）

> 受众：lead / 接手复核者 · 状态：已完成 · 最后核对：2026-11-22 01:08 +0800
> 复核人写域：仅本文件。全程未碰 spec/config/生产代码/baseline（临时探针已删）。
> 结论一句话：**真正达到「真浏览器 + 真后端 + 真 PG」级，非 mock 假绿；建议关闭 R436。**

## 0. 复核时点与独立性

- 实现方 r436-browser-e2e 于 01:05 明确「落盘完成，不再编辑」后，我以它给的精确命令**独立复跑**（EXIT=0），不采信其自报数字。
- 中途曾踩到实现方 01:01:57 重写 spec 的半写态（`derive is not defined`），已确认为竞态、非产品缺陷；定稿后重跑全绿。
- 临时文件：`/tmp/r436_*.cjs`（只读 SQL 探测，口令不打印）、临时网络探针脚本（验收后已删除） + `playwright.__r436_netprobe.config.ts`（网络抓包探针）——**均已删除**，`git status` 仅剩 2 个新 spec/config + 本 review 文档。

## 1. 环境复核（硬结论：环境完全具备）

与 `docs/PROJECT-STATUS.md` §4 旧快照（「3080=401、3105 不通、不具备」）相反：
- 真 PG：node `pg.Client` 连 .env（只 SELECT）→ autoflow_ttfv_e2e 真存在，funnel_events/telemetry_optin/task_executions/migrations 四表齐全，复跑前全空（0/0/0/0/0）。DB_USER=autoflow（无 createdb/super）。 <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->
- Redis：ioredis PING → PONG。系统 Chrome：158.0.8127.36。
- 后端 dist：`dist/.../north-star-metrics.service.js` mtime 23:19 > 源码 21:30，非 stale。
- 端口 3105/5176/4176/4177/4178 复跑前全空闲。
- **若实现方报环境不具备而降级 mock ⇒ P0；本次未发生。**

## 2. 独立复跑结果（精确命令，EXIT=0）

<!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->
```bash
cd /data/project/AutoCodeFlow && . /tmp/r436-env.sh \
 && export DB_DATABASE=autoflow_ttfv_e2e SEC_SECRETS_KEY='4a6b8c0d..3a5b' \
 && cd apps/admin-web && PLAYWRIGHT_CHROMIUM_CHANNEL=chrome \
    npx playwright test e2e/north-star-real-backend.spec.ts --config=playwright.northstar.config.ts
```
- 结果：**1 passed（9.8s），EXIT_CODE=0**。
- witness（我复跑现场输出，非转述）：
  - `stack {"db":"autoflow_ttfv_e2e","api":"http://127.0.0.1:3105/api"}` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->
  - `login {"status":201,"tokenIssued":true,"refreshTokenIssued":true}`
  - `consent {"systemEnabled":true,"optedIn":true,"installIds":["e88d...101"],"count":1,"source":"api"}`
  - `funnel-row {"event_name":"business_confirmed","dedupe_key":"confirmed:c5386b62...a3a","ts":"2026-11-21T17:06:04.119Z"}`
  - `api-north-star {"confirmed":{"active_install_weeks":1,"confirmed_events":1},"proxy":{"executions":1},"warnings":[严格口径…, "⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值"]}`
  - `browser-assert {"confirmed":"1","proxy":"1","warningVisible":true,"globalTagVisible":true,"pageErrors":[],"consoleErrors":[]}`
  - `counterproof {"funnelRows":0,"confirmedText":"0"}` → `restored {"funnelRows":1,"confirmedText":"1"}`

## 3. 复核清单逐条结论 + 证据

1. **真后端非 mock —— PASS（无 P0）**。spec/config 全文无 `page.route`/`route.fulfill`/`route.abort`/任何 `/api/**` 拦截；浏览器 API 调用全经 `apiClient` → vite proxy → 真后端。config `webServer` 起真 `node dist/main`（3105，DB_DATABASE=autoflow_ttfv_e2e）+ vite dev（5176）。consent/login/confirm/metrics 全走真 `fetch` 到 3105。北极星端点零 mock。 <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->
2. **真数据流 —— PASS**。consent 用 `deviceFingerprint` 由后端自身 SEC_SECRETS_KEY 派生 installId（与 listener 同口径），从响应回读 installId；真 `POST /agent/executions/:execId/confirm` → `AgentExecutionConfirmationService.confirm` emit `execution.confirmed` → `FunnelConfirmationListener` → 真库落 `business_confirmed` 行，`dedupe_key=confirmed:<32hex>`、ts=确认时刻。看板数=`GET /agent/north-star/metrics` 真返回（Node 侧 witness 1/1；浏览器侧另经**独立网络探针**抓到 `GET http://127.0.0.1:5176/api/agent/north-star/metrics` 200、warnings=2，确证页面真发请求非本地造数）。代码链 `useNorthStarReport`(queries.ts:283)→`getNorthStar`(metrics.ts:136)→`apiClient.get('/agent/north-star/metrics')`，无硬编码兜底数值。
3. **浏览器断言真实 —— PASS**。testid（north-star-card/strict/proxy/confirmed/proxy-executions/global-tag/warnings/warning）与 NorthStarCard.tsx 源码逐字一致；数值 `confirmed`=`1`、`proxy-executions`=`1` 精准断言；「有产物/有证据 ≠ 被业务确认」warning `filter({hasText})` 可见性断言；`pageerror` 与 `console.error` 双监听且断言为空数组（witness 均 `[]`）。
4. **反证有效性 —— PASS**。删真 backend 的 `business_confirmed` 行（`pg.query DELETE … dedupe_key`）→ poll funnelCount=0 → `page.reload()` → `north-star-confirmed` 断言 `toHaveText('0')` → 截图 counterproof；再重打幂等 `POST /confirm` → funnelCount=1 → reload → 断言回 `1`。真数据驱动，非硬编码。截图 `/tmp/r436-north-star-card.png` 视觉确认 Strict 1 / proxy 1 / Global scope / 两条警告常驻。
5. **清理彻底性 —— PASS**。afterAll 先关总闸+撤销 install 再按 install_id/前缀清行。复跑后我独立查库：funnel_events/telemetry_optin/task_executions/tasks/executors 五类全 0；端口 3105/5176 RELEASED；无 dist/main/vite/playwright/Chrome 残留进程。
6. **诚实降级 —— PASS（无需降级）**。环境实测具备，实现方未降级，全程真栈，不存在把 mock 级说成真机级的情况。
7. **守卫 —— PASS**。新 spec/config 是独立新文件（`??`，未改既有文件）；既有 4 个 e2e config 的 testMatch 均不含本 spec，无污染。既有 smoke 回归 `playwright.smoke.config.ts` → **9 passed / EXIT=0**。无硬编码口令：spec 口令全从 `process.env` 读且不明文打印，config 仅含非秘密 fixture key（32B hex，注释标明非生产密钥）。`/tmp/r436-env.sh` 为 644（含口令，属 /tmp 临时衍生文件、不进仓库）——轻微卫生提示，非假绿、非 P0/P1。

## 4. 缺口分级

- **无 P0 / P1 / P2**。
- 唯一观察项（非缺口）：`/tmp/r436-env.sh` 权限 644 且含口令明文（/tmp 临时文件，未入仓，运行期衍生）；建议实现方报告里注明该 env 文件为临时物、用完可删。不影响验收结论。

## 5. 截图路径（我复跑重新生成，mtime 01:06）

- `/tmp/r436-north-star-dashboard.png`（整页，110731 B）
- `/tmp/r436-north-star-card.png`（卡片特写，53747 B，视觉确认 Strict 1 / proxy 1 / 全局口径 / 两条警告）
- `/tmp/r436-north-star-counterproof.png`（反证态，103132 B）

## 6. 最终结论

**真正达到「真浏览器 + 真后端 + 真 PG」级**（AGENTS.md §4.4 最高级 浏览器/真机）：真 dist + 真系统 Chrome 158 + 真 PG e2e 库 + 真 confirm 事件链 + 真 GET API + 网络抓包佐证 + 数据驱动反证 + 清理彻底 + 既有回归不破。非 mock 假绿。**建议关闭 R436**，并将 PROJECT-STATUS §4「浏览器真机未覆盖」未决项更新为已覆盖（附本报告挂链）。
