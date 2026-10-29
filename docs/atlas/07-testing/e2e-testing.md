# 全链 E2E 测试（根级 Playwright）
> 所属: docs/atlas/07-testing · 最后核对: 2026-10-29 · 对应代码: `playwright.e2e.config.js`、`apps/admin-web/e2e/legacy/e2e-full.spec.js`、`apps/admin-web/e2e/legacy/e2e-python-executor.spec.js`、`apps/admin-web/e2e/legacy/e2e-ui09-mobile.spec.js`、`scripts/e2e-full.sh`

> **本轮整篇重核（第 3 轮 docs-truth 登记项）**：旧版（2026-09-13）写「45 个 `test()` / describe 4 组 /
> 用例编号 1–45 / ui09 用例 45–46」，**四处全过期**。逐文件点数的真值见下表：**51 个 `test()` 声明、
> 9 个 describe 组**（`e2e-full.spec.js` 内 7 组 19 例，另两份各 1 组）。少的 3 例不是「被删」，是旧清单**从来没收录**（46 pull 派发 / 47 token 轮换 /
> E-3 解释器匹配，E-45 补齐后重编号）；另外 `security-redline-rbac`、`-ssrf` 两组旧文里的编号
> 整体错了一位（旧写 36–40 / 41–43，实际 37–41 / 42–44）。

## 入口只有一个，先分清「不是入口」的两份副本

- **唯一入口**：`playwright.e2e.config.js` —— `testDir: 'apps/admin-web/e2e/legacy'` + `testMatch: '**/e2e-*.spec.js'`。该目录下除三份 spec 只有一个 `package.json`（内容 `{"type":"commonjs"}`，用来隔离 admin-web 根 `"type":"module"`，否则 CJS `require` 会被按 ESM 加载而炸）。
- `scripts/e2e-full.sh` 用 `--config=../../playwright.e2e.config.js` 一次跑完这三份；CI 的 `e2e-full` / `e2e-full-windows` 都只走这个入口（互斥对侧：`apps/admin-web/playwright.config.ts` 用 `testIgnore: '**/legacy/**'` 排除 legacy，见下节分工表）。
- **`apps/admin-web/e2e-full.spec.js`（顶层，601 行 / 16 个 `test()` / 0 个 describe）不是入口**：它不在根级 `testDir` 内；`apps/admin-web/playwright.config.ts` 的 `testDir: './e2e'` 也圈不到它；`apps/admin-web/playwright.e2e.config.cjs` 的 `testMatch` 是 `**/e2e-full.spec.cjs`（`.cjs`，不匹配 `.js`）。内容是停在用例 16 的旧快照（`git log` 停在 R14/R15 那批），没有 RBAC / SSRF / 私服 / pull / token 轮换 / 解释器匹配任何一组。**任何入口都不执行它，统计例数绝不能用它当来源。**
- **`apps/admin-web/e2e/e2e-ui09-mobile.spec.js` 是又一份同名副本**（1 个 `test()`，断言 TaskFormPage sticky 提交条，与 legacy 版断言不同）：它会被 admin-web 权威套件（`playwright.config.ts`，`testDir: './e2e'`）在**手动** `npx playwright test` 时拾取，但不经 `e2e-full.sh`、也不在 CI，**同样不计入根级全链例数**。

## 用例总数（2026-10-29 逐文件静态点数）

| spec（均在 `apps/admin-web/e2e/legacy/`） | describe 组 | `test()` 声明 | 条件 `test.skip()` | 说明 |
|---|---|---|---|---|
| `e2e-full.spec.js` | 7 | **48** | 5 | 编号 1–47 连续 + 1 个 `E-3`；5 处 skip **全在用例体内**（运行时条件跳，不是声明） |
| `e2e-python-executor.spec.js` | 1 | **1** | 1 | skip 在 describe 体层：`E2E_PYTHON_EXECUTOR_AVAILABLE!=1` 时整组跳 |
| `e2e-ui09-mobile.spec.js` | 1 | **2** | 1 | skip 在用例体内：API seed 不出执行记录时跳「执行详情」 |
| **合计（入口口径）** | **9** | **51** | **7** | 别名：`e2e-full.spec.js` 内部 = 顶层 29 例 + 7 组 19 例 |

> 合计行的 **9 / 51** 不是手抄的：`scripts/check-atlas-counts.mjs` 的第 ⑤ 项判据会逐份点数这三份
> spec 的**行首** `test(` / `test.only(` 声明（排除 `test.skip(` 与注释），与本行不一致即红、
> 解析不到本行也红。加/删用例后跑 `npm run check:atlas-counts` 即可知道该把 51 改成多少。

默认实跑的用例数（不是声明数）：

- 不启用私服（`E2E_PRIVATE_REGISTRY` 未设）→ 用例 45 条件跳过，**实跑 50 例**；
- 本地没起 executor-python（`E2E_PYTHON_EXECUTOR_AVAILABLE!=1`）→ 再少 1 例（E-18 整组 skip），**49 例**；
- CI 两个 e2e job 都装了 python 3.12（E-18 / L-5），故 **CI 基线 50 例**；46 / 47 / E-3 的 skip 是「共享 token 注册失败」的运行时报错面，不属默认跳过。

## 顶层业务用例（无 describe，29 例，编号 1–29）

| # | 场景 |
|---|---|
| 1 | 登录与仪表盘 |
| 2 | 应用管理 — 新建应用 |
| 3 | 任务管理 — 新建定时任务 |
| 4 | 手动触发任务 & 查看执行 |
| 5 | 执行日志 — 列表与详情 |
| 6 | 运行机 — 列表、详情、安装向导 |
| 7 | 运行机包管理 & 私有仓库 |
| 8 | 应用部署管理 |
| 9 | 并发调度状态查询 |
| 10 | 中断/终止运行中的任务 |
| 11 | 任务启停控制 |
| 12 | 通知渠道设置 |
| 13 | 用户管理 |
| 14 | 审计日志 |
| 15 | AI 配置检查 & Swagger API 文档 |
| 16 | Prometheus 指标端点 |
| 17 | RBAC — admin 访问 /notifications 正常且菜单入口可见 |
| 18 | RBAC — 普通用户 /notifications 被拦(403)且菜单无入口 |
| 19 | RBAC — 普通用户 /users /audit /executor-packages /executors/install 均被拦 |
| 20 | settings AI Tab — 普通用户降级提示且零 /ai/config 请求 |
| 21 | settings AI Tab — admin 正常发起 GET /ai/config 并渲染表单 |
| 22 | TaskFormPage — auto/group/pinned/broadcast 四模式切换与 pinned 选择器绑定 |
| 23 | executorId 残留清理 — 编辑页还原 pinned，切 broadcast 后 pin 被清空 |
| 24 | executorId 残留清理 — 切 auto 提交后 executorId 显式置空 |
| 25 | 创建向导 pinned 提交应携带完整字段与 executorId（R8 P0 回归守卫） |
| 26 | pinned 全链 — 详情页绑定可见、UI 触发、执行记录 executorAddress=目标执行器 |
| 27 | pinned 离线语义 — 目标执行器离线 trigger FAILED，错误消息与失败分类 UI 可读 |
| 28 | pinned 目标不存在 — executorId 幽灵 uuid trigger FAILED，UI 错误展示可读 |
| 29 | UI 向导建 pinned 任务 → 触发执行 executorAddress=绑定执行器（全 UI 闭环） |

## describe 分组（`e2e-full.spec.js` 内 7 组，共 19 例）

| describe | 起始行 | 用例号 | 例数 |
|---|---|---|---|
| `security-redline-approval` | 1347 | 30–36 | 7 |
| `security-redline-rbac` | 1590 | 37–41 | 5 |
| `security-redline-ssrf` | 1817 | 42–44 | 3 |
| `private-registry (BUG-18)` | 1914 | 45 | 1 |
| `pull-dispatch (ARCH-32)` | 2013 | 46 | 1 |
| `token-rotation (AUTH-05)` | 2089 | 47 | 1 |
| `interpreter-match cross-module (E-3)` | 2167 | E-3 | 1 |

编号在 spec 内是**全局唯一连续**的（1–47 + `E-3`），不再像旧文档那样「组内重新起算」——旧文的编号错位就是从这个误会来的。

### `security-redline-approval`（30–36，7 例）

| # | 场景 | 断言要点 |
|---|---|---|
| 30 | 审批冻结 — approvalRequired 应用 deploy 落 pending_approval 零派发 | deploy 201 后 `approvalStatus=pending_approval`、`status=pending`、`approvalMeta.requestedBy` 留痕；审批挂起期重复 deploy 被 in-flight 防重挡下 409 |
| 31 | 第二人规则 — 提交者本人 approve 自己的部署应 403 | 自审 403（HTTP 码 + 包络 code 双复核），审批态仍 `pending_approval`（未被动过） |
| 32 | 并发双审批 — 两个管理员同时 approve 恰一 200 一 409（原子认领） | `Promise.all` 双 approve：恰好一个成功、另一个 409，不出现「双通过」 |
| 33 | reject 语义 — 非提交者管理员拒绝 → FAILED 离开待审批 | 他人 reject 201，部署行离开 pending 且终态 FAILED，槽位释放 |
| 34 | cancel 语义 — 提交者撤回自己的待审批 200；他人撤回 403 | 提交者 cancel 成功、他人 cancel 403 |
| 35 | 审批 RBAC — 普通用户与未携带 token 打审批三动作/待办均被拦 | approve/reject/cancel 三动作 + 待办列表：普通用户 403、无 token 401 |
| 36 | 第二人 approve — 批准后部署真实离开 pending 进入 push 链（正向闭环） | approve 后 30s 内离开 pending 进入真实派发链；探针 `GET /users` 403 证明 token 有效且被 RBAC 拦（排除「假 403」） |

### `security-redline-rbac`（37–41，5 例）

| # | 场景 | 断言要点 |
|---|---|---|
| 37 | 执行器写面全 403 — patch/reload-config/rotate-token/set-offline/delete | 普通用户 token 打五个写端点，逐一 403 |
| 38 | 应用与部署写面全 403 — create/update/delete/deploy/upgrade-all/rollback | 同上，应用/部署写面逐端点 403 |
| 39 | 审计/配置/AI/用户管理面全 403 — export/rollback/shared-token/config/users | 同上，管理面逐端点 403 |
| 40 | 事件订阅契约对齐 + 管理面 403/401 — subscriptions/webhook | 订阅读面 200（含自己的 + 系统级）、建订阅 403、陌生订阅死信重放 404、webhook 无签名 403 / 无 token 401 |
| 41 | 任务配置写面 403 — 普通用户改/删他人任务被拦（NF-03 属主守卫；对照：读面开放） | 写面 403 **同时**读面 2xx 对照组通过——证明 403 出自属主守卫，不是凭据失效 |

### `security-redline-ssrf`（42–44，3 例）

| # | 场景 | 断言要点 |
|---|---|---|
| 42 | SSRF — webhook 订阅六出站点恶意 URL 全 400 | 回环 / 私网 v4 / `[::1]` / `[fe80::1]` / `[::ffff:127.0.0.1]` / 0x7f000001 / 云元数据 169.254.169.254 等逐条 400，并复核包络 `code=400` |
| 43 | SSRF — DNS 重绑定域名形态与非 http scheme 全 400 | 重绑定域名（解析到内网）+ `ftp`/`file`/`gopher` 非 http scheme 全 400 |
| 44 | SSRF — 形状校验对照 + 未携带 token 401 面 | 非法事件名 400（形状校验对照组，防「一律 400」的假绿）；匿名建订阅 401 |

### `private-registry (BUG-18)`（45，1 例）

| # | 场景 | 断言要点 |
|---|---|---|
| 45 | 私服依赖由 executor 装到任务依赖目录，凭据不落任务树 | 用「非 glue 且无 git」载体走安装段：依赖落任务依赖目录、lockfile 记私服地址、`.npmrc`/`_authToken` 不落任务树。**默认 `test.skip`**（要 `E2E_NPM_REGISTRY_URL`，即 `E2E_PRIVATE_REGISTRY=1` 且本地有 verdaccio 镜像） |

### `pull-dispatch (ARCH-32)`（46，1 例，serial）

| # | 场景 | 断言要点 |
|---|---|---|
| 46 | pull 模式 — register(pull) → 空轮询 → 触发派发 → 长轮询取件（载荷对上真实执行行） | 注册一次性 pull 执行器 200/201 → 首轮空轮询无载荷 → 触发任务 → 长轮询取回派发载荷并核对与真实执行行一致；注册失败（共享 token 不可用）显式 `test.skip` 不误报 |

### `token-rotation (AUTH-05)`（47，1 例，serial）

| # | 场景 | 断言要点 |
|---|---|---|
| 47 | token 轮换自愈 — 旧 token 立即 401 / 新 token 可用 / /executors/token 取回可用凭据 | 轮换后旧 per-executor token 立即 401、新 token 可正常调用、`GET /executors/token` 取回的凭据可直接用 |

### `interpreter-match cross-module (E-3)`（E-3，1 例，serial）

| # | 场景 | 断言要点 |
|---|---|---|
| E-3 | runtimeVersion 声明 → 调度按解释器过滤 → 派发落在匹配执行器 | 两个 pull 执行器分别声明 python 3.9 / 3.12，`runtimeVersion` 过滤后只派给匹配者；真实 executor-node 未上报 interpreters 时按 `LEGACY_DEFAULT ["3.12"]` 兜底（这正是过滤行为本身，不靠 runtime/capabilities 排除） |

## 另两份 spec（同目录、同入口）

### `e2e-python-executor.spec.js`（E-18，1 例）

- describe `E-18: executor-python 全链覆盖`，1 例：**注册 → 派发 python glue 任务 → 执行成功 → 回调终态=success**（`TERMINAL_STATUSES` 轮询到终态再断言，避免拿 queued 假绿）。
- describe 体层 `test.skip(!PYTHON_AVAILABLE)`：`E2E_PYTHON_EXECUTOR_AVAILABLE!=1`（python 执行器未起）时整组跳。脚本在启动 executor-node 后并列起 executor-python（端口 **8003**），就绪才置该变量。
- 历史：E-18 之前「46 例 e2e 只注册 executor-node」，python 执行器零端到端覆盖——这 1 例就是补的那个洞。

### `e2e-ui09-mobile.spec.js`（UI-09，2 例）

- describe `UI-09 移动端真机走查（375×812）`，编号「45.」「46.」是**文件内的历史编号**（当年全局编号只到 44），与 `e2e-full.spec.js` 的 45 / 46 / 47 **撞号**——引用本文件请说「UI-09 第 1/2 例」或按标题，别用数字。

| 文件内编号 | 场景 | 断言要点 |
|---|---|---|
| 45. | Dashboard 在 375px 无横向溢出且 KPI 区可见 | 等「任务总数」KPI 可见 + 375×812 视口无横向溢出（不追像素级布局，像素由 `ui09-mobile-pages` 单测锚定） |
| 46. | 执行详情在 375px 无横向溢出 | 取最近一条执行（库空则 API seed 一条），执行详情页无横向溢出；seed 失败时 `test.skip` 并说明原因 |

## 怎么起环境跑

```bash
bash scripts/e2e-full.sh                  # 默认：docker 一次性 PG/Redis，全自动
SKIP_DOCKER=1 bash scripts/e2e-full.sh    # 复用本机已有 PG/Redis（CI 即此形态）
```

- 编排链路：PG(:15432)+Redis(:16379) → admin-api(:3105，空库跑完整迁移链) → executor-node(:8002 注册在线)（+ 可选 executor-python:8003） → admin-web vite(:5176) → Playwright chromium。前置：bash + docker + node>=20 + 各 apps/*/node_modules 已装（chromium 由脚本兜底 install）。
- 可覆盖环境变量：`E2E_DB_HOST/PORT/USER/PASS/NAME`、`E2E_REDIS_HOST/PORT/PASS`、`E2E_API_BASE`、`E2E_WORK_DIR`（Windows 须给盘符路径如 `C:/tmp/acf-e2e-tasks`）、`E2E_LOG_ROOT`。
- 脚本显式钉住的关键 env（防 flake，见脚本头注）：
  - `LOGIN_THROTTLE_LIMIT/THROTTLE_LIMIT=10000` —— **51 例**（入口口径）合计约 60 次登录 + 高频 API 轮询，默认 20/60 必级联 429（W-22 同根）；
  - `EXECUTION_CALLBACK_SECRET` 两端显式同值 —— 消除 fallback 语义漂移；
  - `EXECUTOR_ALLOW_PRIVATE_NETWORK=true` —— 派发目标 localhost:8002 是回环地址，SSRF 守卫默认拦回环；
  - `E2E_EXECUTOR_SECRET` 透传给 spec —— 46 / 47 / E-3 要注册一次性执行器；
  - 每次全新库 —— docker 模式 drop+create，SKIP_DOCKER 模式要求空库，断言不漂移。
- 私服场景：设 `E2E_PRIVATE_REGISTRY=1` 且本地有 verdaccio/verdaccio:5 镜像时，脚本起一次性 Verdaccio 并置 `E2E_PRIVATE_REGISTRY_ENABLED=1`（**用例 45** 才执行）；未启用会打印一行跳过说明。⚠️ 脚本那行文案**仍写「用例 44」**（私服用例已重编号为 45，脚本注释/文案滞后，`scripts/**` 不在文档轮改动范围——按「用例 45」读）。
- 全部子进程 exec 化 + trap 清理，容器/三服务/日志不落残留。
- CI：`e2e-full` job（ubuntu，services 提供 PG/Redis + `SKIP_DOCKER=1`）每次 PR/push 跑；`e2e-full-windows`（windows-latest，原生 PG 服务 + portable redis 下载）仅 PR / 手动 / schedule（W-28，盲区恰是 Windows：W-22/W-26 都是 Windows runner 抓出 Linux 漏掉的 bug）。
- 配置文件 `playwright.e2e.config.js`（2026-10-29 逐项核对）：`testDir: 'apps/admin-web/e2e/legacy'`、`testMatch: '**/e2e-*.spec.js'`、baseURL `http://localhost:5176`（`PLAYWRIGHT_BASE_URL` 可覆盖）、headless、`timeout: 60000`、`actionTimeout: 15000`、`navigationTimeout: 20000`、`workers: 1`、`retries: 1`、`reporter: [['list']]`、`locale: 'zh-CN'`、screenshot only-on-failure。
  - `workers: 1`：全链只起**单**后端实例，多 worker 并行会让两份 spec 同时打同一后端造成数据竞争/状态污染（flaky 根因）。
  - `locale: 'zh-CN'`：三份 spec 断言的是**中文**文案（`系统`、`普通用户`、`通知设置`…），而 Playwright chromium 默认 `navigator.language` 是 en-US、i18n 又按「跟随浏览器语言、其次英文」判定——不钉死 locale 会 **26 例**集体超时红（LANG-ERR-01 / UI-10）。要英文界面的用例自行 `page.addInitScript` 覆盖 `localStorage('autoflow-lang')`。
  - 旧文档写的 `testIgnore: '**/apps/**'` **已不存在**：收编后改用「精确 `testDir` 圈 legacy/」实现同一互斥目的（反向由 admin-web config 的 `testIgnore: '**/legacy/**'` 承接）。
- 本地单跑某用例：`npx playwright test --config=playwright.e2e.config.js -g "pinned"`（`-g` 按标题 grep），但仍需脚本起好的环境或自行起栈。

## 编号沿革与 CI 里的计数文案（读 CI 注释前先看这段）

- 旧文档「45 例 / 4 组 / 用例 45–46」的来源：清单停在用例 44（私服）+ ui09 自带的 45./46.，**漏了** E-45 追加的 46（pull 派发）、47（token 轮换）与 NETOPT-6⑦ 重编号后的 E-3（解释器匹配）；`rbac` / `ssrf` 两组的编号还各错一位。现在以 spec 内 `test(` 逐行点数为准。
- `ci.yml` 的 e2e step 名写 **`Run 48-case full-chain e2e`**（ubuntu）与 **`Run 48-case full-chain e2e (Windows)`**：48 只等于 `e2e-full.spec.js` **单文件**声明数，而 step 实际跑的是三份（合计 51），故 step 名偏低 3 例。
- 同文件 `e2e-full-windows` 的 job 头注释写「Windows 全栈 e2e（29 例）」「同一份根级 29 例 spec」：29 是「顶层无 describe」的例数，既不是单文件 48 也不是套件 51——一个 job 头里两套口径。
- `scripts/e2e-full.sh` 头注写「48 例 test() 声明（编号 1-47 唯一 + E-3）+ 5 例条件 skip」，正确；但同文件 [6/6] 横幅写「Playwright **53 例**声明」（= 48+5，把运行时 skip 也当声明），第 35 行又写「**43 例** ~60 次登录」——脚本内部三处口径互相不一致。
- 本页一律按 **spec 里实际 `test(` 点数**（51 / 48+1+2）取值；`apps/**` 与 `ci.yml`、`scripts/**` 的上述滞后只登记、不在文档轮越界修。

## apps/admin-web/e2e/ 与根 e2e 的分工

| | 根级全链（`playwright.e2e.config.js` → legacy 三份，51 例） | `apps/admin-web/e2e/`（6 个 `*.spec.ts`：auth / functional / login_real / navigation / pages / application-versions，另 1 份 `e2e-ui09-mobile.spec.js` 副本） |
|---|---|---|
| 驱动 | `scripts/e2e-full.sh` 起全栈真环境 | 手动 `npx playwright test`（apps/admin-web 下，`playwright.config.ts`，testDir `./e2e`，`testIgnore: '**/legacy/**'`，baseURL 5176） |
| 环境 | 全新库全链，含执行器与安全红线 | 需自备已在跑的栈（`login_real` 用真实凭据登录） |
| CI | `e2e-full` / `e2e-full-windows` | **不在 CI**（admin-web CI 只有 lint+build） |
| 定位 | 回归门禁 + 安全红线 | 页面级走查/探索性补充 |

## 失败时先看什么

1. 先分清**环境问题**还是**回归**：vite/3105/8002 端口是否被占、docker 是否可用、`SKIP_DOCKER` 模式下给的库是否为空库（脚本要求空库，残留种子会毒化断言）。
2. 失败截图在 `/tmp/e2e-*.png`、日志在 `/tmp/acf-e2e-logs*/`（CI 上由 `e2e-artifacts` artifact 收集，retention 7 天；Windows job 另收 `C:/tmp/acf-e2e-tasks/` 与 `test-results/`）。
3. 429 级联：确认节流放大 env 已生效（脚本默认设置，绕过脚本手工单跑 spec 时要自备）。
4. 成片中文文案找不到元素 → 先确认 `locale: 'zh-CN'` 没被绕过（手工起 config 以外的方式跑时最易踩）。
5. 46 / 47 / E-3 被 skip → 看 `E2E_EXECUTOR_SECRET` 是否透传（注册一次性执行器失败即 skip，不误报失败）。
6. 定位到具体用例后，对照上表找同域文档：审批流见 [approval-flow](../04-flows/approval-flow.md)、安全模型见 [security-model](../04-flows/security-model.md)、回调见 [execution-callback](../04-flows/execution-callback.md)、私服见 [registry-npm](../01-apps/registry-npm.md) 与 [registry-pypi](../01-apps/registry-pypi/README.md)。
