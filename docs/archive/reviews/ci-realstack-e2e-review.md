# R439 独立验收 —— 北极星真栈 e2e 接入 CI（`north-star-real-e2e`）

验收对象：`.github/workflows/ci.yml` 新增 job `north-star-real-e2e`（ci.yml:2306，90 行 / 9 steps，插在 `e2e-full` 与 `e2e-full-windows` 之间）。
验收性质：**静态 CI 配置复核 + spec/config 源码逐字对照 + 三守卫独立复跑**。本机未真跑 GitHub Actions（无 CI 运行时），未重跑浏览器真栈（R436/R437 上游轮已做过，本报告不冒充那一级证据）。对齐 AGENTS §4.4：本次最高证据级别 = 静态探查 + 守卫自检。

## 总判定

**8 项清单全 PASS，无 P0 / P1；未发现会让 job 在 CI 必红的 env 缺失、口令不可解或表缺失。建议关闭。**
两条非阻塞提示：P2（AGENT_HANDOFF 缺 R439 交接段）、P3（两 config 共用端口的串行形态）见文末。

## 逐条结论 + 证据

### 1. env 完整性 —— PASS

两个 spec + 两个 config 的 `process.env.X` 读取全集（grep 取全集，共 7 个）与 job env 对照：

| 变量 | 读取点 | job env（ci.yml:2331-2349） | 判定 |
|---|---|---|---|
| `DB_DATABASE` | 两 spec beforeAll 库名守卫 + PG Client；两 config webServer.env 硬编码 | `autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 --> | ✓ 四处同值；`/(^\|_)(test\|e2e)(_\|$)/i` 命中 `_e2e` |
| `DB_HOST` | 两 spec PG Client | `localhost` | ✓ |
| `DB_PORT` | 两 spec PG Client（`Number()`） | `5432` | ✓ |
| `DB_USERNAME` | 两 spec PG Client | `autoflow` | ✓ |
| `DB_PASSWORD` | 两 spec PG Client | `test` | ✓ |
| `INITIAL_ADMIN_PASSWORD` | 两 spec beforeAll truthy 断言 + `/auth/login` body | `admin123` | ✓ 见第 2 条 |
| `PLAYWRIGHT_CHROMIUM_CHANNEL` | 两 config `channel: … \|\| 'chrome'` | `chrome` | ✓ 显式设，config 另有默认双保险 |

清单点名但 spec/config 未直接读取的另外三项：

- `REDIS_HOST` / `REDIS_PORT` —— job = `localhost` / `6379`，与 redis service 映射口一致；后端 boot 消费（`Joi` 默认也是 localhost/6379）。✓
- `REDIS_PASSWORD` —— **非缺口**：两 spec / 两 config 均不读；`app.module.ts:180` 为 `Joi.string().allow("").optional()`；redis service 无密码。job 不设是正确的（设错反而可能触发 AUTH 失败）。
- `SEC_SECRETS_KEY` —— job = `4a6b8c0d…1f3a5b`（64hex），与两 config 的 `FIXTURE_SECRETS_KEY` 及 R437 spec 的 `FIXTURE_SECRETS_KEY` **四处逐字一致**（脚本比对 `ALL EQUAL: true`，各 64 字符）。✓

清单未列但决定后端 boot 成败的 Joi required 项（`app.module.ts:188-193`），job 同样提供，且与长期全绿的 `admin-api-e2e` job 同值：

- `JWT_SECRET` = `test-jwt-secret-32chars-long-here`（33 ≥ 32）✓
- `JWT_REFRESH_SECRET` = `test-refresh-secret-32chars-long`（32 ≥ 32）✓
- `EXECUTOR_SECRET` = `test-executor-secret`（20 ≥ 16）✓

**Playwright 三层 env 合并已源码核实**：`apps/admin-web/node_modules/playwright/lib/runner/index.js:943-947` 为
`env: { ...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env, ...this._options.env }`。
⇒ job 级 `process.env` 会传给 webServer 的 `node dist/main`；config 里写死的 `DB_DATABASE` / `SEC_SECRETS_KEY` 优先级最高，因此 job 必须与其同库（已满足，见第 3 条）。

### 2. `INITIAL_ADMIN_PASSWORD` 可解 —— PASS（非 P0）

- 来源明确、非猜测、非空：`admin123`，与 `admin-api-e2e`（ci.yml:293）、`admin-api-coverage`（ci.yml:224）**完全同值**，这两个 job 长期 CI 绿。
- seed 链路：`users.service.ts:65-100` 的 `onModuleInit` 在 `users` 表 count=0 时用 `initialAdmin.password` 建 `username:"admin"`；`configuration.ts:707-708` 把 env 映射到该配置节。
- 弱口令 fail-fast（`configuration.ts:1155-1175`）只在 production 语义下触发；本 job 未设 `NODE_ENV=production`，与 `admin-api-e2e` 同口径，`admin123` 可用（既有 job 已证）。
- 时序：step6 `migration:run` 建 `users` 表 → step8/9 webServer bootstrap 时 seed → spec beforeAll `POST /auth/login` 断言 `status === 201`（`auth.controller.ts:119` 的 `@Post("login")` 无 `@HttpCode` 覆盖，NestJS 默认 201）。✓

### 3. DB / 表前提 —— PASS

- `services.postgres.env.POSTGRES_DB = autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->（ci.yml:2316）= job `DB_DATABASE`（:2337）= 两 config webServer.env 硬编码值（northstar:47 / telemetry:47）= spec PG Client 的 `process.env.DB_DATABASE`。**同库闭环**，无"后端一连、spec 一连"的分叉。
- step6 `Apply migrations for real-stack e2e` → `npm run migration:run`（cwd `apps/admin-api`，用 job 的 `DB_*`）在 step8/9 spec **之前**，空库全链建表。
- 所需两张表都有迁移：`1790000000101-AddFunnelEvents.ts`（`funnel_events`）、`1790000000102-AddTelemetryOptin.ts`（`telemetry_optin`）；另有 `system_configs` / `config_history`（R437 `setGate`）、`executors` / `tasks` / `task_executions`（两 spec 造数）均在全链内。✓
- 后端 webServer 起于 spec 时（`node dist/main`），迁移已先落库。✓

### 4. dist / 依赖 —— PASS

- step3 `npm ci`（`apps/admin-api`）：spec 用 `createRequire(…/admin-api/package.json)` 加载 `pg`（`package.json:68` `pg ^8.23.1` 为 production 依赖，在位）。✓
- step4 `npm ci`（`apps/admin-web`）：`@playwright/test` 在位。✓
- step5 `Build admin-api dist` → `npm run build`（`nest build -p tsconfig.build.json`）产出 `dist/main`，供两 config 的 `command: 'cd ../admin-api && node dist/main'`。顺序：ci → build → migration → spec。✓

### 5. chrome / Playwright —— PASS

- step7 照 `e2e-full`（ci.yml:2275-2280）：`sudo rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.sources`（ deb822 `.list`/`.sources` 双删）+ `npx playwright install --with-deps chromium`（系统依赖）。✓
- job env `PLAYWRIGHT_CHROMIUM_CHANNEL: chrome`（:2349）；两 config `channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome'`。✓
- 与 `e2e-full` 注释一致："playwright 系统依赖不含 chrome 本体"，`channel=chrome` 用 runner 预装 Chrome 本体，双删 apt 源只防 `--with-deps` 的 `apt-get update` Hash Sum mismatch。✓

### 6. 触发 / 隔离 —— PASS

- `if: github.event_name != 'schedule'`（:2309），与 `admin-api-e2e` 同口径：PR / develop push / dispatch 跑，旁路 nightly 月度轮（schedule 下主套件本就被旁路，避免拖慢/扰动演练轮）。✓
- `services`（PG/Redis）为 job 级定义，只随本 job 起停，不污染其它 job；端口用宿主 `5432/6379`，与本 job 内 webServer/spec  isolated runner 一致。✓
- action 固定 SHA：checkout `3d3c42e…90b1`、setup-node `949feb2…c15c1`，与全文件其余 job 逐字相同（pinned）。✓
- `runs-on: ubuntu-24.04` 固定版本（无 `-latest`），`timeout-minutes: 30`。✓

### 7. CI 守卫 / diff 边界 —— PASS（独立复跑，均 exit 0）

- `npm run check:workflow-yaml` → exit 0：selftest 13/13；10 个 workflow 全可解析（js-yaml@5.5.0），1201 映射项 0 处未加引号冒号纯量。
- `node scripts/check-workflow-actions-pinned.mjs --selftest && …` → exit 0：selftest 13/13；10 文件 / 111 处 uses 全固定 SHA、0 本地路径、0 docker://、12 distinct action。
- `npm run check:runner-labels` → exit 0：selftest 7/7；10 workflow / 61 处取值全固定或登记豁免。
- **js-yaml 结构核对**：新 job 解析存在，keys = `runs-on,timeout-minutes,if,services,env,steps`；9 steps（checkout → setup-node → 2×npm ci → build → migration → install chromium → R436 → R437）；services = postgres,redis；`POSTGRES_DB = DB_DATABASE = autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->；job env 15 键齐全；全文件 40 个 job。
- **diff 越界**：`git diff .github/workflows/ci.yml` 两个 hunk —— hunk1（约 :370-401）是前序 R434 的 QA-08 revert 改动（工作树累积未提交，非本次引入）；hunk2（约 :2294-2385，+90 行）才是 R439。**R439 自身纯 add 一个新 job，未修改任何既有 job / 既有 step / spec / config / baseline。**

### 8. 诚实边界 —— PASS（附文档缺口见 P2）

- `docs/PROJECT-STATUS.md:21` 对 R439 明确标注"**静态 CI 配置 + 守卫（R434/R439，未真跑 GitHub Actions）**"，未把"本地真栈绿"冒充"CI 已验证"。✓
- 实现方未声称在 CI 上真跑过 job；本报告同样如实标注证据级别（见开头）。✓

## 缺口分级

- **P0 / P1：无。** 无 env 缺失、无口令不可解、无表缺失、无关库分叉；job 不会因上述原因在 CI 必红。
- **P2（文档完备性，非阻塞）**：`docs/AGENT_HANDOFF.md` 尚无 R439「本次交接」段（当前最新段停在 R434，:80）。按 AGENTS §4.5 每轮应更新交接段；建议 lead/实现方补一段并挂链本报告。
- **P3（运行时观测点，非阻塞）**：两个 config 都用 `5176` / `3105` 且 `reuseExistingServer: false`、`retries: 0`；同一 job 内 step8 → step9 串行依赖 Playwright 干净释放端口。本地真栈两 spec 各自单独跑过，但"两 config 在同一 job 连续跑"是 R439 新形态。若未来出现端口占用 flake，优先查这里；当前不构成关闭障碍。

## 建议

**关闭 R439。** 接线正确、env 闭环、守卫全绿、diff 无越界；P2/P3 作为收尾备注，不影响 job 可运行性。

## 命令 / exit 记录

| 命令 | 结果 |
|---|---|
| `npm run check:workflow-yaml` | exit 0（13/13 selftest；10 workflow parseable） |
| `node scripts/check-workflow-actions-pinned.mjs --selftest && node scripts/check-workflow-actions-pinned.mjs` | exit 0（13/13；111/111 pinned） |
| `npm run check:runner-labels` | exit 0（7/7；61 处合规） |
| `node -e "js-yaml.load(ci.yml).jobs['north-star-real-e2e']"` | 结构核对通过（9 steps / 2 services / 15 env keys） |
| `grep -hoE 'process\.env\.[A-Z_]+' 两 spec + 两 config \| sort -u` | 7 变量，逐项对照 job env 全命中 |
| SEC_SECRETS_KEY 四处字面量脚本比对 | `ALL EQUAL: true`（各 64 字符） |
| `git diff .github/workflows/ci.yml` | 2 hunk：hunk1=R434 遗留，hunk2=R439 新 job（+90），无越界 |

挂链（由 lead 在自有写域完成，避免 `test:docs` 孤儿判红）：在 `docs/README.md` 报告表与 `docs/PROJECT-STATUS.md` CI 防线行各补一条指向本报告的链接。本报告自身不放跨目录相对链接，以免触发死链守卫。
