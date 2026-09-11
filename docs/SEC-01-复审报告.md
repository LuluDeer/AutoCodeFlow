# SEC-01 复审报告 v2 —— 五模块专项对账收口

> 对应认领板 [PLAN-CLAIMS.md](./PLAN-CLAIMS.md) 行 112 SEC-01（第五轮 004，2026-09-10）。
> 范围 = 0beef76 报告 B 节「低覆盖模块专项」五项：BUG-12 executor-desktop / BUG-13 acf-cli / BUG-14 mcp-server / BUG-15 双 SDK / BUG-16 registry-npm。
> v1（BUG-13 时代，基线 43d42c8）由 main-A 于 2026-09-07 完成四模块复审并以 8c9665e 落地修复；BUG-12 于 2026-09-09 由子代理完成（49a75bb + SEC-NEW-1/8fe9fe1）。
> **v2 任务 = 重新验证而非抄板**：对五模块各做一轮轻量源码走查，逐项核对板上结论在最新代码形态（含 round9/round10/round11 401 自愈演进与 SEC-NEW-1 后桌面端形态）下仍然成立，形成文件:行号级证据；新发现只记录不修。零代码改动。
> 复审基线：develop @ ef55bb9（工作树含并行在途 admin-api/admin-web 改动，本轮零触碰）。v1 全文可经 git 历史回溯（本文件升级前的最后 v1 形态随 8c9665e 入库）。

## 一、结论总表（验收口径：全「已确认/已排除」）

| 模块 | 审项 | v1 结论 | v2 结论 | v2 证据锚点（抽查复核过） |
|---|---|---|---|---|
| acf-cli | BUG-13 认证传递/降级/重试 | 2 项缺陷已修 | **已确认**（F13-1/F13-2 修复在位且经 0f518d0 回归入库固化） | §三.1 |
| mcp-server | BUG-14 鉴权链 | 1 项缺陷已修 | **已确认**（F14-1 可选 refresh 自愈在位；新增 403 不刷新/refresh 不带过期凭据回归） | §三.2 |
| node-sdk / autoflow-sdk | BUG-15 降级/重试/错误传播 | 2 项不对称已修 | **已确认**（F15-1/F15-2 修复在位；401 降级语义 = 无隐式重试 + 可读错误传播，round9/round11 后形态已反映） | §三.3 |
| registry-npm | BUG-16 下载路由/token 边界 | 无缺陷（2 注记） | **已排除**（无缺陷结论维持；2 条注记原样未决，另 1 条已被 6e2c6ac 静态自检守卫） | §三.4 |
| executor-desktop | BUG-12 凭据存储/IPC/子进程 env | 1 项新发现（F12-1 → SEC-NEW-1）+ 2 小修 | **已确认**（F12-1 经 SEC-NEW-1/8fe9fe1 收口；BUG-12 两小修在位；排除项逐条复核维持） | §三.5 |

**五模块对账：5/5「已确认/已排除」，零「待办」级未闭合缺陷。** 本轮新发现 2 条（1×P3 + 1×Info），均不构成验收阻塞，列 §四 待主会话裁定。

## 二、报告 v2 相对 v1 的增量复核范围

v1 基线 43d42c8 → v1 落地 8c9665e（2026-09-07，四模块修复+报告）→ v2 基线 ef55bb9（2026-09-10）。8c9665e 之后触及五包的提交全量如下（`git log --name-only 8c9665e..HEAD` 走查），v2 走查对每包按「提交增量 + 板上结论」双线核对：

| 包 | 8c9665e..ef55bb9 增量提交 | v2 增量复核点 |
|---|---|---|
| packages/acf-cli | dc82ac7（BUG-01/N51 exec/tasks 文案）、e2bc806（ECO-02 --json）、a00438b（QA-07 契约向量，client.ts unwrap/detailFromData 空串语义）、11b349e（NF-07 executor rotate/offline）、0f518d0（BUG-13 回归入库：client.test+commands.test） | ① 自愈链核心文件 client.ts/config.ts/login.ts 自 e2bc806 起未被功能提交改写（QA-07 仅动 unwrap 空 message 语义，git diff 核对不触碰拦截器）；② NF-07 rotate 新命令不落盘新 token（§三.1-c）；③ 回归用例数从 v1 的 59 → 现 84 |
| packages/mcp-server | 0241b5a（BUG-14 测试修复）、6297f21（ECO-03 四工具）、a00438b（QA-07）、9e76802（NF-06 retry_execution/deploy_app）、0f518d0（403 不刷新+refresh 不带过期 Authorization 回归）、1882b66（VERSION 1.1.0） | ① api.ts 鉴权链未被工具面扩容改写（NF-06/ECO-03 均走 tools.ts 注入 `ApiCall`，鉴权单一出口仍在 api.ts，见 §三.2-b）；② 0f518d0 新增的两条鉴权语义回归确认（§三.2-c） |
| packages/autocodeflow-node-sdk | a00438b（QA-07 契约测试）、e2574bd（ECO-01 reportSuccess/reportFailure + context.ts）、0f518d0（http-client.test 403/不重试回归） | ① http-client.ts 本体自 v1 起零改动（git log 核对，增量只落测试与 context.ts）；② 401 降级形态 = enabled 门 + 无隐式重试（§三.3-b） |
| packages/autoflow-sdk | 5d8c0dc（BUG-10 三分类进 callback.py）、e2574bd（ECO-01 HttpClientError + http.py）、a00438b（test_contract.py）、0f518d0（callback timeout 不重试回归）、5a30000（1.1.0 版本 bump） | ① VALID_FAILURE_REASONS 白名单含 stale_recovered（callback.py:48-63）且 report_failure 校验在位；② http.py 无重试语义 docstring 如实（F15-1 维持） |
| apps/registry-npm | 6e2c6ac（配置静态自检 scripts/registry-npm-config.selftest.mjs + README 权限矩阵；config.yaml 本体零改动） | ① config.yaml 与 v1 逐行一致（`$authenticated` 面/60d/someProp 均原样）；② 注记① 部分升级：死键虽未删，但已纳入静态自检防漂移视野（§三.4） |
| apps/executor-desktop | 8fe9fe1（SEC-NEW-1 safeStorage）、49a75bb（BUG-12 小修）、04c82ee（fast-uri/xmldom 钉版）、c4a0fbc（DSK-02/03 打包+自动更新）、5141962/2342743（bundle 重打）、95505f0（DSK-04 系统通知） | ① SEC-NEW-1 全链（信封/迁移/掩码/解密出口）逐文件走查（§三.5-b）；② BUG-12 两小修在位（§三.5-c）；③ DSK-02/03/04 新增面（updater/notifier/autolaunch）凭据零扩散走查（§三.5-d） |

round9/round10/round11 的 401 自愈演进说明：round10 落地的是 **executor-node→admin 方向**的 forceTokenRefresh（admin 推送/轮换后执行器侧自愈，PROGRESS-round10 L18-19），round11 修复的是 admin `reloadConfig` 推送侧必然 401（issueToken 幂等复用，VERIFY-round11 L17/L26）。这两个 401 自愈与五模块客户端包的 401 自愈（本报告 §三.1/§三.2）方向相反、互不覆盖——v2 已确认双方在位且语义不冲突。

## 三、五模块逐项对账（重新验证记录）

### 1. acf-cli（BUG-13）——已确认

**F13-1 refreshToken 丢弃（P2，已修）**：`packages/acf-cli/src/commands/login.ts:37-41` 同时落 accessToken 与 refreshToken（`setRefreshToken(data.refreshToken ?? '')`）；存储面 `packages/acf-cli/src/config.ts:31-33` 提供 `getRefreshToken()`（`ACF_REFRESH_TOKEN` env 优先）。**F13-2 token 创建时烘焙（P2，已修）**：`packages/acf-cli/src/client.ts:97-107` 请求拦截器逐请求 `getToken()` 注入 `Authorization: Bearer`，实例创建时不再烘焙（注释 L97-98 明示 resetClient 仅兼容保留）。

401 自愈链（重新走查，与 v1 描述一致）：
- `client.ts:108-132` 响应拦截器：仅 401、非 `/auth/*`（`isAuthPath` L87-89）、未重放过（`_acfAuthRetried` L110-120）时触发；
- 单飞并发收敛：`client.ts:121-124`（`refreshInFlight ??=`）；
- `refreshAccessToken`（L58-85）换发双 token 均入库（DR-07 原子轮换语义，L72-78），刷新失败 `clearAuth()`（L130 → config.ts:52-55 清双 token 留 apiUrl）；
- 与 DR-06 不冲突：重放仅发生在认证态（请求未达业务层），非业务副作用重试；测试 `client.test.ts:309`「non-401 errors are rethrown untouched (DR-06: no business retry)」钉死。

回归锚点（0f518d0 入库 + 本轮实跑）：`packages/acf-cli/src/__tests__/client.test.ts` describe「401 refresh self-heal (BUG-13)」L208 起七用例（刷新重放 L220 / 失败清凭据 L248 / 无 refreshToken 快速失败 L264 / auth 路径豁免 L274 / 并发单飞 L286 / 非 401 不动 L309）；QA-07 契约向量 L399-427。

**a) 请求签名链与存储面复核（v2 重点）**：env 优先级链 `ACF_TOKEN`/`ACF_REFRESH_TOKEN`（config.ts:27-33）→ `--token` 全局参数注入 `ACF_TOKEN`（index.ts:42,47）→ conf 存储；`config set-token`（index.ts:66-67）直接写 store。链路无旁路，签名头只出自 client.ts 拦截器一处。

**b) NF-07 增量（11b349e）安全复核**：`packages/acf-cli/src/commands/executors.ts:161-178` executor rotate（ADMIN）——新 token 仅一次性控制台输出（L175-176），全文件无 `setToken`/store 写调用，凭据不落盘；offline 映射 ADMIN set-offline 语义。无新增凭据扩散面。

**c) 测试基线实跑**：acf-cli **84/84**（4 文件，vitest）+ `tsc --noEmit` 绿。较 v1 的 59 只增不减（增量 = QA-07 契约 + ECO-02/NF-07/BUG-01 回归）。

### 2. mcp-server（BUG-14）——已确认

**F14-1 长驻进程 token 过期死锁（P2，已修）**：`packages/mcp-server/src/api.ts:29-31` 模块态 `currentToken/currentRefreshToken`；`AUTOCODEFLOW_API_REFRESH_TOKEN`（可选，fail-fast 缺省姿态不变：index.ts:88-89/99-104 缺 token 时启动即报错）。401 自愈：`api.ts:97-114`（非 `/auth/*`、`_retried` 单次、有 refreshToken 三条件 L100-104），单飞 `L105-107`，重放 `L110`；轮换出的新 refreshToken 保内存（L50-56），不落盘。`--help` env 说明在位（index.ts:88-89）。

**a) 鉴权头传播复核（v2 重点）**：全部工具（含 NF-06 新增 retry_execution/deploy_app、ECO-03 四工具）经 `register*Tools(server, apiRequest)` 注入（index.ts:33-38），HTTP 鉴权单一出口 = `api.ts:79-87`（逐请求 `Authorization: Bearer ${currentToken}`）。tools.ts 本体零 HTTP 关注点（`ApiCall` 注入型，tools.ts:8-14），工具面扩容不可能绕过鉴权链。

**b) refresh 请求不带过期凭据（0f518d0 增量）**：`api.ts:38-43` refresh POST 头仅 `Content-Type`，不携带过期 Authorization；测试 `api.test.ts:356-380`「does not send the expired access token to /auth/refresh」断言 `refreshInit.headers` 恰为 `{Content-Type}`。

**c) 403 不刷新（0f518d0 增量）**：`api.test.ts:344-354`「does not refresh on 403」——403 是授权失败而非 token 过期，不触发刷新链（api.ts 条件本就只认 401）。403 文案仍区分 ADMIN 要求（api.test.ts:149-155；buildHttpError api.ts:155-158）。

**d) 测试基线实跑**：mcp-server **100/100**（3 文件）+ `tsc --noEmit` 绿（v1 时 46，增量为 ECO-03/NF-06/QA-07/0f518d0 回归）。

### 3. node-sdk / autoflow-sdk（BUG-15）——已确认

**F15-1 文档谎言（P3，已修，维持）**：py `packages/autoflow-sdk/autoflow_sdk/http.py:23-26` docstring 如实声明「No automatic retry（BUG-15 复审：原文档串声称 basic retry logic 但实现从未有过）」，非幂等方法永不被隐式重试；README 同步（`packages/autoflow-sdk/README.md:73`、`packages/autocodeflow-node-sdk/README.md:90`：「SDK 不做隐式重试，401/403/timeout 等错误会保留后端 message 后传播」）。

**F15-2 failureReason 白名单不对称（P3，已修，维持且再扩）**：py `packages/autoflow-sdk/autoflow_sdk/callback.py:48-63` `VALID_FAILURE_REASONS` 含 `stale_recovered`（L56，与 admin DTO 枚举同步）及 BUG-10 三分类（dependency_install_failed/git_fetch_failed/runtime_missing，L58-60）；report_failure 前置校验拒绝非法值（callback.py:243-247）。admin 侧枚举源 `apps/admin-api/src/modules/task/entities/task-execution.entity.ts:34`。

**401 降级重试路径（v2 重点，round9/round11 后形态）**：
- **node**：`packages/autocodeflow-node-sdk/src/http-client.ts:51`（`enabled = Boolean(baseURL && token)` 门）+ L53-59 `disabledReason` 缺凭据即 disabled（构造成功、请求抛清晰错误，L141-146 `requireEnabled`）——**无 401 自动刷新、无隐式重试**（回调 token 是 per-execution 一次性凭据，刷新语义不适用；401 靠 token 短 TTL 内失效+任务级失败传播）；错误可读化 L81-94（envelope message 附加，不改写 status）；测试 `src/__tests__/http-client.test.ts:243-271`（401/403 message 附加且 403 不重试不改写）+ L273「does not retry SDK requests; axios errors propagate from the first attempt」。10s 超时对齐 py 侧（L62-65）。
- **py**：`callback.py:155-156` disabled 时 `CallbackDisabledError`；report 非 2xx 抛 `_status_error`（L164-165）——enriched `httpx.HTTPStatusError`（L188-193，保留原类型可捕获性，message 带后端 detail）；`http.py:67-80` `_raise` 抛 `HttpClientError`（L6，ECO-01 子类，行为兼容）；`trust_env=False` 双侧钉死（callback.py:158、http.py:39/94，防代理 env 劫持任务出站流量）。timeout 不重试：`tests/test_callback.py:219-223`（ReadTimeout 直抛，0f518d0）。

**降级语义对等复核**：`enabled/disabled_reason` 双端对等（node L51-59 / py callback.py:112-129）；executorAddress 可选语义 U14 后双端一致（node L122-138 仅 callback 路径且不覆盖显式值 / py callback.py:195-208 同规则）。测试基线实跑：node-sdk **63/63**（jest 4 套件）、autoflow-sdk **111 passed**（pytest）。较 v1（43/100）均只增（ECO-01/QA-07/0f518d0）。

### 4. registry-npm（BUG-16）——已排除（无缺陷结论维持）

配置面 `apps/registry-npm/config.yaml` 与 v1 逐行一致（6e2c6ac 未改配置本体）：
- **包权限**：`'@autoflow/*'` 与 `'**'` 双块 access/publish/unpublish 全 `$authenticated`（config.yaml:29-39），无 `$all`/`$anonymous`；匿名拉取/元数据探测均 401。
- **凭据存储**：htpasswd 落持久卷（L4-12，`file: /verdaccio/storage/htpasswd`，max_users:100）；compose `npm_data:/verdaccio/storage`（docker-compose.yml:360）+ 配置只读挂载（L361）。
- **暴露面**：默认 loopback 绑定（docker-compose.yml:358 `'127.0.0.1:4873:4873'`）+ 显式 `max_body_size: 100mb`（L17）。
- **JWT 寿命**：API 60d / web 7d 显式（L22/L27）——注记② 维持未决（见 §五）。

**v2 增量（6e2c6ac）**：`scripts/registry-npm-config.selftest.mjs`（根 `npm run test:registry-npm` 接入，package.json:21）将上述边界固化为静态断言——禁 `$all/$anonymous`（L63-64）、htpasswd 持久化（L65）、双 token 寿命显式（L66-67）、loopback 绑定/只读挂载/持久卷（L69-71）、README 权限矩阵四行（L73-78）。**实跑通过**。README 权限矩阵（apps/registry-npm/README.md:37-48）与配置一致。

**管理面下载路由 token 边界（v1 抽查范围之外补充核对，结论一致）**：执行器包下载 `apps/admin-api/src/modules/executor-package/executor-package.controller.ts:216-268`——`@Public()`+空 `@Roles()` 跳过全局守卫后，处理器内双通道校验：共享 token（`verifyExecutorToken`，timingSafeEqual，`apps/admin-api/src/common/utils/verify-executor-token.util.ts:32-64`）→ 回落 access JWT（`type === 'access'`，L254-263），双败 401（L265-268）；无签名 URL 面存在（不走临时 URL，逐请求验凭据）。产物下载 `apps/admin-api/src/modules/artifacts/artifacts.controller.ts:105-126` 则全程 JWT 守卫（无 @Public）。任务侧 `.npmrc` 凭据注入链 round-12 修复维持，本轮抽查无回归。

### 5. executor-desktop（BUG-12 + SEC-NEW-1）——已确认

**F12-1 executorToken 明文落盘（P3，SEC-NEW-1/8fe9fe1 收口）**——safeStorage 全链走查：
- **信封与纯函数**：`apps/executor-desktop/src/main/token-crypto.ts:18`（`enc:ss:` 前缀判别）+ `isValueEncrypted`（L56-58）/`encryptToken`（L65-88，safeStorage 不可用/加密失败返回 null 由调用方定降级姿态）/`decryptToken`（L96-120，解密失败返回 ''+warn，不猜明文）；降级 warn 一次/进程（L127-136，同 SEC-02 姿态）。
- **写面分支表**：`config-store.ts:99-119` `save()`——明文→加密落盘（L113-114）/掩码回写→保留原值（L107-111）/空串→清空（L102-105）/降级→保明文 fail-safe（L114）；`setRaw` 防误用注记（L134-136，secret 写必须走 save 分支表）。
- **存量迁移**：构造器触发 `migratePlaintextToken()`（config-store.ts:60 → L69-82，明文存量原子覆盖为信封，失败保明文下轮重试）。
- **IPC 读面掩码**：`config:get`/`executor:status` 走 `getAllMasked()`（ipc-handlers.ts:36,110-114 → config-store.ts:147-150，token 恒 `******` L48-49），明文与密文均不过桥；明文唯一出口 = `getDecryptedToken()`（config-store.ts:139-141）→ `executor-process.ts:13-20` `resolveToken()` → 子进程 env `EXECUTOR_SHARED_TOKEN`（L85-87）。
- **测试**：`token-crypto.selftest.ts` 三姿态 31 断言（0f518d0 时点板上口径）；本轮实跑 `npm run test:main` 四套件全绿（path-domain/token-crypto/updater/notifier-rules，apps/executor-desktop/package.json:17）。

**BUG-12 小修（49a75bb）在位**：
- `config:save`/`config:save-and-close-wizard` `isPlainConfig` 门（ipc-handlers.ts:42-48,69-72，拒数组/非对象载荷）；
- `sharedWebPreferences()` 单一来源（window-manager.ts:16-23，contextIsolation:true + nodeIntegration:false 显式钉死，双窗口 L54/L87 复用；sandbox 走 Electron≥20 默认开启，L85-86 注记）。

**v1/板上排除项逐条复核（全部维持「已排除」）**：
- **IPC 白名单**：主进程全部 `ipcMain.handle` 显式枚举（ipc-handlers.ts:31-347，19 个通道，无任意透传/eval/open 面）；preload 仅白名单 expose（preload/index.ts:3-86）；路径类通道三闸在位——`log:read` executionId 字符集白名单+域校验（L174-207）、`log:open-file` 域+后缀双闸（L246-261）、`apps:log:read` 域校验（L305-321）。
- **子进程 env**：仅 `EXECUTOR_SHARED_TOKEN` 单点注入（executor-process.ts:74-88 全量键名核对，无桌面端新增凭据；`...process.env` 继承为宿主态既有语义）；任务子进程 env 由 executor-node 白名单收敛（round-4，A-1 红线）未变。
- **日志广播**：`executor:log-line` 只透传子进程 stdout/stderr 行（executor-process.ts:98-112,269-273），token 不入日志。
- **敏感字段面**：autolaunch（autolaunch.ts）/updater（updater.ts）无凭据读写；DSK-04 通知内容不含 token/errorMessage/绝对路径（notifier.ts:5、notifier-rules.ts:16-17）。

**v2 增量面走查（DSK-02/03/04，8c9665e 后新增，v1 未覆盖）**：
- `updater.ts:106-117` AUTOUPDATE_URL 仅接受 http/https（协议白名单），`autoDownload=false`+用户确认安装（L129-130,194-203）；版本回退不弹窗（L42-48 isNewerVersion + L147-150 兜底）。
- 依赖面：04c82ee 钉 fast-uri 3.1.7/xmldom 0.8.15（SEC-06 侦察 high 清偿）；electron-store 8.2.0→conf 10.2.0→dot-prop 6.0.1（原型污染修复版，node_modules 实测核对）、ajv 8.20.0。
- 打包/更新链凭据零涉及（electron-builder.yml publish 仅 github provider 指向，无 token 内嵌）。

## 四、新发现（待主会话裁定——只记录不修）

| # | 严重度 | 模块 | 发现 | 建议方向 |
|---|---|---|---|---|
| N-SEC01-v2-1 | P3 | acf-cli | CLI 双 token（access+refresh）经 `conf` **明文落盘**于用户配置目录（`packages/acf-cli/src/config.ts:14-21`，`~/.config/acf-cli/config.json`）。与 F12-1 desktop 同型的 at-rest 面，且 refreshToken 是长期凭据（较 15m access token 更敏感）。ADR-012 范围仅桌面端；CLI 无 safeStorage 可用（Node 无原生 keyring）。 | 可评估 keytar/OS keyring 集成，或最低限度在 README 部署指引中注明 CI/定时场景优先 `ACF_TOKEN` env 注入而非 login 落盘。不阻塞验收，登记与否请主会话裁定。 |

> **N-SEC01-v2-1 已闭环（SEC-NEW-4）**：按上表建议方向二落地——`config.ts` 落盘文件经 `conf.configFileMode` 以 `0600` 创建，存量组/其他可读文件在模块加载时由 `hardenConfigPermissions()` 一次性收紧为 `0600`（只改权限，不迁移/不删除凭据，chmod 失败静默降级）；`ACF_CONFIG_DIR` 提供目录覆盖（只读 home / 共享机器 / 测试）；CI/定时场景的 `ACF_API_URL`+`ACF_TOKEN`（+可选 `ACF_REFRESH_TOKEN`）env 注入面已在根 `README.md`「CLI 工具 (acf)」段文档化。加密落盘（keytar/OS keyring）留作后续评估——明文为纯 Node 无 keyring 的平台固有下限，`0600` 为当前最低限度可交付姿态。回归锚点见 `packages/acf-cli/src/__tests__/config-security.test.ts`。
| N-SEC01-v2-2 | Info | executor-desktop | Linux 桌面自动更新链（DSK-03/c4a0fbc）**无代码签名校验**：electron-updater 在 Linux（AppImage/deb）不验包签名，完整性仅靠 latest-linux.yml sha512 + 更新源传输安全（github provider=HTTPS；generic 源=AUTOUPDATE_URL 部署者自担）。`autoDownload=false` 用户确认闸与版本回退兜底已在位。 | 平台固有姿态非缺陷；建议真机轮（deployment.md Ubuntu 段已有待验注记）在 runbook 中补一条「AUTOUPDATE_URL 必须指向部署者可信源」提示即可。 |

**零「待办」级缺陷**。v1 两条 registry-npm 注记为 carried-forward 未决事项（非本轮新发现），见 §五。

## 五、遗留与 carried-forward

- registry-npm 注记①（`security.api.jwt.verify.someProp: []` 死配置键，config.yaml:23-24）：v1 起 维持未删（避免无 verdaccio 运行时验证的配置漂移）；6e2c6ac 静态自检未将其纳入断言，清理仍留下次维护窗口。
- registry-npm 注记②（API JWT `expiresIn: 60d`，config.yaml:22）：内网私服可接受，暴露面扩大时缩短并配轮换手册。
- SEC-NEW-1 真机边界（ADR-012 缩水声明延续）：Linux keyring 真机加密往返/换机解密失败两场景留真机轮。
- CLI/MCP/双 SDK 的全部单测锚点已由 0f518d0 入库成为红线回归（SECURITY-REDLINE-CHECKLIST A-7 行），v2 实跑全绿，无需新增代码动作。

## 六、验证与自检记录（纯文档任务的自检口径）

- **测试实跑**（本报告唯一引用的运行证据，全部本轮实跑）：acf-cli 84/84 + tsc 绿；mcp-server 100/100 + tsc 绿；node-sdk 63/63（jest）；autoflow-sdk 111 passed（pytest）；`npm run test:registry-npm` 通过；desktop `npm run test:main` 四 selftest 套件全绿。
- **路径真实性**：报告内引用的全部源码/文档路径逐一核对存在（均为本轮实际 Read 过的文件，无推断路径）。
- **行号抽查**：文内 file:line 证据全部来自本轮 Read 输出行号（client.ts/login.ts/config.ts/api.ts/http-client.ts/http.py/callback.py/config.yaml/selftest 脚本/config-store.ts/token-crypto.ts/ipc-handlers.ts/executor-process.ts/window-manager.ts/preload/index.ts/updater.ts/executor-package.controller.ts/verify-executor-token.util.ts/artifacts.controller.ts/task-execution.entity.ts 及各测试文件）。
- **零代码声明**：本任务仅改动 `docs/SEC-01-复审报告.md`（原地升级 v2）与 `docs/SECURITY-REDLINE-CHECKLIST.md`（补交叉引用）两个文档文件；git add 逐文件，未触碰任何代码/测试/CI/配置，未卷入工作树中并行在途的 admin-api/admin-web 改动。

## 七、v1 → v2 主要变更说明

1. v1 总表五行的「已修/无缺陷/新发现」表述统一升级为三态「已确认/已排除/待办」；desktop 行由「新发现待办」转为「已确认」（SEC-NEW-1 收口）。
2. 新增 §二 增量复核范围（8c9665e..ef55bb9 逐包提交对账，含 NF-06/NF-07/ECO-02/ECO-03/QA-07/SEC-NEW-1/BUG-12 小修/DSK-02~04/0f518d0 回归入库）。
3. 全部结论补至文件:行号级证据（v1 多为叙述级）；401 自愈相关章节反映 round10/round11 演进后的完整语义。
4. 新增 §四 待裁定清单（2 条）与 §六 自检记录；§五 承接 v1「遗留」并标注 carried-forward 属性。
5. 交叉引用：SECURITY-REDLINE-CHECKLIST.md「七、待办缺口」SEC-NEW-1 行更新为已闭环并指向本报告。
