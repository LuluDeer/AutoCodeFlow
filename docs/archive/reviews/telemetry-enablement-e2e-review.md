# R437 独立验收复核 —— 真浏览器验证生产启用完整路径（终版结论）

> 受众：lead / 接手复核者 · 状态：已完成 · 最后核对：2026-11-22 01:37 +0800
> 复核人写域：仅本文件。全程未碰 spec/config/生产代码/baseline/既有文档（临时探针仅 /tmp，口令未打印）。
> 结论一句话：**真正达到「真浏览器 + 真后端 + 真 PG」级（AGENTS.md §4.4 最高级）。7 项清单全 PASS，无 P0/P1；建议关闭 R437，另开 1 项 P2 文案修正。**

## 0. 复核时点与独立性

- 实现方 r437-enablement-e2e 于 01:34:13 定稿（spec 617 行）/ 01:31:50 config 定稿，明确「不再编辑，端口已释放」后，我按它给的精确命令**独立复跑**（EXIT=0），不采信其自报数字。
- 先做静态复核：CodeGraph 1.6.2 CLI 探查 `TelemetrySettings` / `agentApi.telemetryConsent` / consent & status 端点 / `FunnelEventsService.record`；逐字读必读四文档 + spec 617 行 + 专用 config + 相关 locale/en.ts + system_config / config_history 实体定义（列名 `key` / `configKey` 逐一核实）。
- 复跑后再做**独立事后取证**：真 PG 只读查库、端口/进程残留检查、既有 smoke 回归、五张截图视觉复核。
- 环境未降级、未把 mock 说成真机：全程真 dist + 系统 Chrome 158.0.8127.36 + 真 PG `autoflow_ttfv_e2e`。 <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->

## 1. 环境复核（硬结论：环境完全具备）

- CodeGraph CLI `/home/zou/.codegraph/versions/v1.6.2/bin/codegraph`：索引 2633 文件 / 52064 节点，`TelemetrySettings` / `setTelemetryConsent` / `telemetryStatus` / `record` 均可逐字探查。
- 真 PG：node `pg.Client` 连 `.env`（只 SELECT）→ `autoflow_ttfv_e2e` 存在，`funnel_events` / `telemetry_optin` / `executors` 三表齐全。 <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->
- 真后端 dist：`dist/main.js` 与 `funnel-events.service.js` mtime 均为 2026-11-21T23:19，非 stale。
- Chrome 158.0.8127.36；复跑前端口 3105 / 5176 全空闲。
- 专用 config `playwright.telemetry.config.ts`：`testMatch: /e2e\/telemetry-enablement-real\.spec\.ts$/` 完全独立，webServer 起真 `node dist/main`（3105，测试库 + fixture key）+ vite dev（5176，/api proxy → 3105），口令从进程环境继承。

## 2. 独立复跑结果（精确命令，EXIT=0）

<!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->

```bash
source /tmp/r436-run-env.sh
cd /data/project/AutoCodeFlow/apps/admin-web
npx playwright test --config playwright.telemetry.config.ts --reporter=list
```

- 结果：**3 passed（15.7s），EXIT_CODE=0**（我复跑现场输出，非转述）。
- witness 关键值（clickAt→beforeOk→responseAt 时间戳，ms 为点击到响应耗时）：
  - `beforeAll {"db":"autoflow_ttfv_e2e","installId":"e701ca2dd93474e5b52fee192ff19aa7","status":{"systemEnabled":false,"count":0,"coverage":"gate_off","knownExecutorCount":1},"login":{"status":201,"tokenIssued":true,"refreshTokenIssued":true}}` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->
  - `s1-no-executors {"coverage":"0 / 0","alertVisible":true,"backendCoverage":"no_executors"}`
  - `ui-consent {"action":"switch-off+popconfirm-ok","afterClickMs":226,"httpStatus":201,"source":"admin-ui"}`
  - `ui-consent {"action":"switch-on+popconfirm-ok","afterClickMs":197,"httpStatus":201,"installIds":["e701ca2dd93474e5b52fee192ff19aa7"],"source":"admin-ui"}`
  - `s1-full {"coverageText":"1 / 1","alertCount":0,"backend":{"systemEnabled":true,"count":1,"coverage":"full","known":1,"installs":[{"installId":"e701ca2dd93474e5b52fee192ff19aa7","optIn":true,"source":"admin-ui"}]},"pageErrors":[],"consoleErrors":[]}`
  - `s2-partial {"coverageText":"0 / 1","alertText":"Some executors are not authorized (0 of 1 authorized)\nRe-authorize all","reauthorizeVisible":true,"backendCoverage":"partial"}`
  - `ui-reauthorize {"afterClickMs":97,"httpStatus":201,"installIds":["e701ca2dd93474e5b52fee192ff19aa7"],"source":"admin-ui"}`
  - `s2-restored {"coverageText":"1 / 1","alertCount":0,"backend":{"count":1,"coverage":"full","known":1}}`
  - `s3-optout-confirm {"confirmStatus":201,"ok":true,"waitedMs":2000,"funnelRows":0,"execHash":"1de4293df80363aa90377634d95fe1db"}`
  - `s3-optin-confirm {"confirmStatus":201,"ok":true,"funnelRows":[{"event_name":"business_confirmed","install_id":"e701ca2dd93474e5b52fee192ff19aa7","execution_id_hash":"1de4293df80363aa90377634d95fe1db","dedupe_key":"confirmed:1de4293df80363aa90377634d95fe1db","ts":"2026-11-21T17:35:27.804Z"}],"coverageText":"1 / 1"}`
  - `cleanup {"configHistoryDeleted":5,"funnel":0,"optin":0,"executors":0,"taskExecutions":0,"tasks":0,"gate":"false","statusCoverage":"gate_off"}`

## 3. 复核清单逐条结论 + 证据

1. **真 UI 非 API 直调 —— PASS（无 P0）**。spec 全文 617 行：唯一 consent 出现处是 `consentResponse` 的 `page.waitForResponse(... '/agent/telemetry/consent' && POST ...)`（:186），**无 `page.route` / `route.fulfill` / `route.abort` / 直接 `fetch POST /consent`**。两次 `ui-consent` 见证均由 `clickSwitchConsent()` 真点 `getByRole('switch')` → 断言 Popconfirm 文案 → `pop.getByRole('button',{name:'Confirm'}).click()` 触发；`waitForResponse` 在 `sw.click()` **前**注册（:194 早于 :196），命中响应在点击之后：`afterClickMs=226` 与 `197`，HTTP 201、`source=admin-ui`。重授权另经 `telemetry-reauthorize-btn.click()`（:229），`afterClickMs=97`。场景 3 的 confirm 是业务端点（spec 无 UI 控件可点），consent 仍走 Switch+Popconfirm，符合 lead 集成事实。
2. **coverage 真变化 —— PASS**。beforeAll 真 status `gate_off / count=0 / knownExecutorCount=1`；场景 1 UI `0 / 0` + `telemetry-coverage-alert` 可见 + 后端 `no_executors` → UI 撤销（总闸 off）→ 插执行器并点 Refresh → UI `0 / 1` → Switch+Popconfirm → UI `1 / 1`、告警数 0、真 status `full / count=1 / known=1`、installs 含 `installId=INSTALL_ID, optIn=true, source=admin-ui`。UI testid `telemetry-coverage-value` / `telemetry-coverage-alert` 与 `TelemetrySettings.tsx:207/219/229` 逐字一致；读的是 `GET /agent/telemetry/status` 真响应（`backendStatus()` 经 `api()` fetch 到 3105），无 mock/无硬编码兜底数值。五张截图中 0/0 与 1/1 视觉确认。
3. **重授权按钮真触发 —— PASS**。SQL 只撤授权行（不动总闸）后真 status `partial / count=0`，UI `0 / 1` + 绿色 info 告警 + `Re-authorize all` 按钮可见（截图 `/tmp/r437-03-partial-alert.png` 实见）；`clickReauthorize()` 真点 `telemetry-reauthorize-btn` 后抓 201（`afterClickMs=97`），UI 回 `1 / 1`、告警消失，后端 `full / count=1`。是 UI 点击非 API。
4. **隐私解耦真栈 —— PASS，与 §7 裁决一致**。opt-out 经真 UI（Switch+Popconfirm OK，201）→ 真 status `systemEnabled=false/count=0` → 真 `POST /agent/executions/:execId/confirm` 返回 **201 ok:true** → 等 2s 后 funnel 行数 0（含 `dedupe_key=confirmed:<execHash>` 过滤为 0）；opt-in 经真 UI 后同 execution 再 confirm 仍 201 ok:true，`expect.poll` 真等到 1 行 `business_confirmed`，`execution_id_hash=execHash`、`dedupe_key=confirmed:execHash`、install_id=INSTALL_ID。代码链佐证：`FunnelEventsService.record`（`funnel-events.service.ts:52-60`）未授权返回 `{recorded:false,reason:"not_opted_in"}`，只拦漏斗写入；`north-star-business-confirmed.md` §7：「确认端点自身不因 telemetry 未授权而拒绝业务动作，只是不写漏斗事件」。产品正确性与裁决一致。
5. **清理/隔离 —— PASS**。spec 造数全带 `PREFIX=r437-enable-` / `TEST_FP` / `INSTALL_ID` / `execHash`，`cleanRows()` 按这些精确删除，不 DROP 表。我复跑后**独立查库**（不采信 spec 自报）：funnel=0、optin=0、executors=0、task_executions=0、tasks=0、`system_configs.value='false'`、`config_history` 新增=0（baseline=68）。端口 3105/5176 RELEASED；`ps` 无 dist/main / vite / playwright / Chrome 残留。口令仅从 `process.env.INITIAL_ADMIN_PASSWORD` 读取并在 beforeAll 断言存在，witness/日志/截图均无口令；截图只截 `getByRole('tabpanel')`，视觉确认无凭据区。
6. **诚实降级 —— PASS（无需降级）**。环境实测具备，spec 无 `test.skip` / 无 mock 分支；beforeAll 显式断言 `DB_DATABASE` 为 test/e2e 与口令存在，起栈失败即红，不存在把 mock 级说成真机级。加固点 `waitGate()`（:116-120）只**只读轮询真 status** 等待 SQL 直改总闸的缓存窗口，不写 consent、不伪造状态；我复跑未遇缓存窗口抖动。
7. **守卫 —— PASS**。专用 config `testMatch` 只匹配新 spec；既有 smoke `playwright.smoke.config.ts`（`testMatch: /(navigation|pages)\.spec\.ts$/`，离线 build+preview 端口 4177）回归 **9 passed / EXIT=0**。无硬编码口令：口令全走 `process.env`；`FIXTURE_SECRETS_KEY`（config:16 与 spec:36 同值）注释明确「非生产密钥，仅 32B hex fixture」，与 R436 同款，非凭据泄漏。

## 4. lead 提出的 3 个观察项——独立判断

- **gate_off 无告警块**：非产品缺口。`TelemetrySettings.tsx:215-237` 告警只在 `no_executors` / `partial` 渲染；`gate_off` 是默认未启用（合规零采集）态，Switch off + 灰色 coverage tag 已如实表达，不报警符合隐私默认原则。若要给「误以为已启用」的管理员加引导，属 UX 优化，非本切片启用路径缺口。
- **Popconfirm 文案与全量授权语义偏差 —— 真实 P2 产品缺口**：`locales/en.ts:1054` 的 `descOn` 写「The **current install** will be recorded as opted in...」，但 `TelemetrySettings.tsx:118-130` 的 `submitConsent(true)` 不带 `installIds`，后端 `agent.controller.ts:944-951` 遍历全部 executor 指纹授权；`s1-full` witness 亦显示一次 UI 点击即产生 install 行。用户被引导以为只授权当前实例，实际是全量。不导致越权或数据外泄（全量授权是 design intent，且用户主动 opt-in、表格可回看），故定 P2 而非 P1。建议文案改为「All known executors will be opted in and the system gate will be opened.」并同步 zh 与 spec 断言。本复核不改实现，报 lead 决策。
- **SystemConfig 1s 缓存**：非产品缺口。SQL 直改总闸绕不过 `SystemConfigService` 的错误缓存失效广播，是**测试 fixture** 的稳定性问题；生产 consent 端点走 service 正常失效。实现方已用 `waitGate()` 轮询真 status 消除，我复跑全程未见状态抖动。

## 5. 缺口分级

- **无 P0 / P1**；7 项清单无一项假绿、无 API 冒充 UI、无 mock 说成真机。
- **P2（1 项，非阻塞本切片）**：Popconfirm On 文案「current install」与实际全量授权语义不符（详见 §4）。
- 观察项（非缺口）：`/tmp/r436-run-env.sh` 权限 644 且含口令明文，属 /tmp 临时衍生文件、未入仓、运行期需要；R436 report 已同类记录。建议用完删除。
- 文档守卫提示：本 review 文件按约定只写自身，**未改 README**。若 `check-docs.mjs` 的 orphan 检查要求新文档从 README 可达，请 lead 挂链后再跑文档守卫；其余风格按 R436 review 同款（`autoflow_ttfv_e2e` 处已加 `metric-docs:ignore-unknown`）。

## 6. 截图路径（我复跑现场生成，mtime 01:35）

- `/tmp/r437-01-no-executors.png`：0/0 + 黄色 no_executors 告警 + Re-authorize all（视觉确认）。
- `/tmp/r437-02-full-enabled.png`：1/1、告警消失、Admin UI 来源、Opted in（视觉确认）。
- `/tmp/r437-03-partial-alert.png`：0/1、绿色 partial 告警 + Re-authorize all、表格 Not opted in/revoke（视觉确认）。
- `/tmp/r437-04-reauthorized.png`：重授权后 1/1。
- `/tmp/r437-05-privacy-restored.png`：opt-in confirm 后 1/1、Opted in（视觉确认）。
- 五张均为 `getByRole('tabpanel')` 局部截图，不含凭据/口令。

## 7. 最终结论

**真正达到「真浏览器 + 真后端 + 真 PG」级**（AGENTS.md §4.4 最高级 浏览器/真机）：真 dist + 真系统 Chrome 158 + 真 PG e2e 库 + UI 点击驱动的 consent（时间戳证明）+ 真 status coverage 变化 + 重授权真点击 + §7 隐私解耦真反证 + 五表清理与端口释放 + 既有 smoke 不破。非 mock 假绿。**建议关闭 R437**；P2 文案修正另开低优先级项，不阻塞本切片验收结论。
