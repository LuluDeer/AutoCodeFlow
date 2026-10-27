# 待决策清单（OPEN DECISIONS）

> 本文件只放**需要人拍板**的事，不放已完成的工作（那些在 `PLAN-CLAIMS.md` 的按轮记录里）。
> 每条都带**证据出处**与**两个选项的代价** —— 目的是让决策可以在 5 分钟内做完，而不需要重读整本板子。
>
> 排序：先放「现在就在影响行为」的，后放「只是不一致、暂不影响」的。

## A. 现在就在影响正确性 / 用户体验

### A1. FIRE_ONCE 补偿要不要把「窗口内存在任何执行」当成已覆盖
- **现象**：手动触发不推进 `lastTriggerTime`，于是「手动跑过一次之后」补偿扫描仍可能再补派一次。
- **证据**：`PLAN-CLAIMS.md` R130（三场景表）、R133（claim 原子性复核）。
- **选项**：① 保持现状（严格 cron 语义：手动跑 ≠ 服务该计划点）；② 补偿前查「窗口内有无执行」（运维语义：人已经跑过了）。
- **代价**：② 每次候选多一条索引查询；① 保留一次多余执行。

### A2. 四个 Python 库（`autocodeflow-{ai,http,notify,db}`）接发布线还是删除
- **现象**：有源码 + 测试 + pyproject + CHANGELOG，但**不在** version-guard、**不在** publish 矩阵、**仓内零消费者**；版本是 `0.3.2`（落后平台主线 `1.15.x` 十余个 minor——`acf-cli` / `autocodeflow-node-sdk` 已到 1.15.0；四个 pyproject 第 7 行均为 `version = "0.3.2"`）。
- **证据**：R135（现状表）、R136（守卫）、R134-A1（已修 6 处缺陷 + 20 条用例）。
- **选项**：① 接进 PyPI 发布线（补 version-guard + 矩阵 + 文档 + 版本归位）；② 删掉。
- **代价**：① 一条发布流水线 + 版本线决策；② 丢掉 `R134-A1` 那批已写好的回归用例。
- **守卫**：`check-publishable-wiring.mjs` 已把这条**钉成红灯风险**（新增第五个这样的包会立刻红）。

### A3. `acf-cli` 破坏性命令的确认门：已收口 4 类 / 仍无门 3 条
- **已收口（R192-A1，均已加 `-y/--yes`）**：`task kill`（`packages/acf-cli/src/commands/tasks.ts:870`）、`task webhook enable·rotate·disable`（同文件 `:905` 选项，`:917-925` 只对非 `status` 动作询问）、`apikey revoke`（`packages/acf-cli/src/commands/apikeys.ts:115`）。语义统一：非 TTY 且缺 `--yes` ⇒ 退出码 2（`EXIT_CODES.USAGE`，见 `packages/acf-cli/src/ui.ts:29`/`:176-187`）且请求不发出。
- **仍无门的 3 条（按后果分别判定，分级而非一刀切）**：
  - `task rollback`（`tasks.ts:510-522`）：每次写入都落版本快照、可再回滚（R192-A1 已判定不加门）。
  - `deploy stop`（`packages/acf-cli/src/commands/deploy.ts:95-107`）：只把运行中的部署停到 STOPPED，可由 redeploy/upgrade 恢复，不销毁数据。
  - `executor offline`（`packages/acf-cli/src/commands/executors.ts:198-213`）：只把执行器标记为 offline（不打断在跑任务，命令自述用于崩溃后的陈旧记录），执行器下次心跳重新注册即自愈。
- **真实缺口（不是「要不要加门」，建议单列为 P2 待办）**：CLI 没有 `executor online` 逆操作（`executors.ts` 只有 list/get/rotate/offline），运维在 CLI 里无法撤销 offline，只能等心跳——缺的是一条逆操作。
- **证据**：R193（`apikey revoke` 自述 cannot be undone 却零确认）、R195（文件级计数太粗，按命令枚举才发现 7 处）、R198（退出码/确认门设计本身是好的，应复用）。

## B. 跨语言/跨包语义不一致（两边都自洽，合起来不齐）

### B1. 两个发布 SDK 的重试语义不同（真实差异只剩「HttpClient 有无重试」）
- **真实差异**：node 的 `HttpClient` 默认对幂等方法重试（指数退避 + `Retry-After`）；python 侧的**普通出站 HTTP 客户端**（`packages/autoflow-sdk/autoflow_sdk/http.py:154-166`，类 docstring 自述「No automatic retry…无重试无熔断」）确实不重试。
- **回调通道两侧都有有界重试，差异只在预算**：node 执行器 `apps/executor-node/src/callback.ts`——实时发送 5 次（`MAX_RETRIES = 5`，`:849`；base `CALLBACK_LIVE_BASE_DELAY_MS = 1_000`，`:191`）+ 落盘重发 150 轮、base 5s/cap 600s（`CALLBACK_REPLAY_BACKOFF_BASE_MS`，`:180-181`）；python 执行器 `apps/executor-python/routers/execute.py`——实时 3 次（`CALLBACK_RETRY_ATTEMPTS = 3`，`:841`；base 1s，`:842`）+ 落盘重发 150 轮、base 1s/cap 600s（`:2649-2659`）。SDK 层同样有界：`packages/autoflow-sdk/autoflow_sdk/callback.py:68` `CALLBACK_MAX_ATTEMPTS = 3` + 指数退避 + 抖动 + `Retry-After`（`:393-422`）；node `http-client.ts` 默认 `maxRetries=3`（合计 4 次尝试，`:195-199`），回调通道单次等待封顶 5s（`CALLBACK_MAX_WAIT_MS`，`:135`）。
- **为什么不算缺陷**：重复投递由 admin 侧终态迁移的 `status IN (open gate)` 条件 UPDATE 兜住——重复终态回调命中 0 行（见 `callback.py` 顶部 NETOPT-10-1 注释，`:60-68`）。因此「多试一次/少试一次」只影响延迟与带宽，不改变最终状态。
- **证据**：R180（发现）、R183（python README 修正）、R191（node 回调等待封顶 5s）、R177-A1。
- **现状**：已在两边 README 互相指认（`R182`/`R183`），**用户可读到**，但仍会踩。
- **选项**：① 保持（各语言按各自习惯）；② python 加重试（= 改变既有任务失败时机）。

### B2. 配置错语义两包相反：`from_env()` 不抛 / `fromEnv()` 抛
- **现象**：python 侧 `execution_id` 默认 `unknown` 且继续跑，回调可能带着 `unknown` 发出去；node 侧直接抛。
- **证据**：R177-A1 遗留 1。
- **代价**：统一 = **破坏性变更**，需要 deprecation 周期。

### B3. 熔断：node 的 breaker 是**跨端点单实例共享**（唯一真实的差异）
- **现象**：node `packages/autocodeflow-node-sdk/src/http-client.ts:497` 只有一个 `private readonly breaker: CircuitBreaker`，`send` 内统一取用（`:752-797`）——**同一实例服务所有端点**，回调连续失败会连带阻断无关的 GET（快速失败抛 `CircuitBreakerOpenError`）。
- **python 侧不是「没有熔断」**：`packages/autocodeflow-http/autocodeflow_http/client.py:157` 有 `CircuitBreakerOpenError`，`:282` 有 `CircuitBreaker`（含 half-open 单探测上限，PK-09），形态是**按客户端实例**（`:364` `self._breaker = circuit_breaker or CircuitBreaker()`）；node 侧注释亦自认「与 python 的 `_CircuitBreaker` 同构」（`http-client.ts:63`）。
- **证据**：R177-A1 遗留 5。

### B4. 协议声明了 `adminApiUrls`，python 侧不实现且**不报错**（2026-10-27 审计新增）
- **现象**：`packages/executor-protocol/protocol.json` 的 `ConfigReloadRequest` 含 `adminApiUrls`（node 应用并按新拓扑重建客户端）；python 只把它列进 `ignored_fields` 仍回 `success: true`（`apps/executor-python/routers/config.py` 的 `_KNOWN_CONFIG_FIELDS` 注释自述「只在 node 侧支持」）。协议文件本身**没有登记**这条差异。
- **影响面（如实）**：admin-api 目前**不发**这个键（`grep -rn adminApiUrls apps/admin-api/src` → 0 命中），所以今天踩不到；踩到的是「按协议实现第三方调用方」——它会拿到成功回执却没换拓扑。
- **选项**：① 协议里给该键加 `$comment` 标注「python 未实现，收进 ignored_fields」；② python 补实现（多 base URL 轮换，工作量在 HTTP 客户端层）。
- **代价**：① 一段注释；② 一个跨语言的连接拓扑特性，需与 node 的轮换语义逐条对齐。

### B5. python 报 `protocolVersion=8` 却永远不发 `deployedApps`/`installedPackages`/`registrationConflict`（2026-10-27 审计新增）
- **现象**：v7/v8 的字段 `executorImplementedBy` 列了 executor-python，而 python 心跳**恒不发**这三个键（`apps/executor-python/scheduler.py:462-473`）。v8 这个版本号的目的恰是「让中台能区分『应报未报』与『无冲突』」，python 报 8 却永不发该键 ⇒ 该判据在 python 上失效。
- **现状豁免条件**：v8 注释允许「缺席即合法」，所以不是错误；但它让**版本号失去判据意义**。
- **选项**：① 在协议里显式声明 python 为「部分实现」并列出缺席键；② python 补实现（桌面端能力，python 执行器是否需要待产品判断）。
- **代价**：① 文档/协议一段；② 需要 python 侧真的能枚举已部署应用。

## C. 已接受但值得知道的风险

| 项 | 状态 | 出处 |
|---|---|---|
| 渠道配置 **明文落库**（`notification_channel_configs`） | ADR-028 明确接受（附四条重开条件） | ADR-028 / R150-A1 |
| system-config 密钥静态明文 | 同上 | ADR-028 |
| python 侧**嵌套 zip >64 MiB 仅 warn**（admin 是 fail-closed） | 未统一 | R94 |
| Slack / Feishu **path 型凭据**日志不掩（掩 path 会破坏「掩码回传保存」） | 有意保留 | R150-A1 |
| node `isNetworkLevelError` 白名单可能漏 `EPIPE` 类 | **未实测**（需真 socket 半关） | R177-A1 遗留 4 |

## D. 小决策（一句话可拍）

- **D1**：`acf app create --json <body>` 这个 **DEPRECATED 旗标**要不要删？它污染了 `isJsonInvocation` 的探针判断（R196）。删 = 兼容性变更，收益是「按名字做的判断不再误命中」。
- **D2**：`acf task kill` / `rollback` 要不要补 `--json`？它们现在只能人读，而 `task list` 可以机器读（R197）。`approval approve/reject` 不用补（输出就是一句确认）。
- **D6**：任务列表「按名称排序」与游标分页**互斥**，要哪一个？（2026-10-27 审计新增，来自一个真实的前端假交互）
  - **现状**：列头的 `sorter` 是**纯客户端**排序（只排当前页），而表格是服务端 + 游标（keyset）分页 ⇒ 用户以为按名称全局排序、翻页即失效。已于 2026-10-27 删除该 sorter 并留注释（`apps/admin-web/src/pages/TaskListPage.tsx`）。
  - **为什么不能直接接服务端排序**：后端**支持** `sortBy`/`sortOrder`（`list-tasks-query.dto.ts` + `TASK_SORT_WHITELIST`），但 `task.service` 的 `assertCursorCompatibleWithQuery` 对 **cursor+sortBy 直接 400**。
  - **选项**：① 排序时退回 offset 分页（要接受翻页期间的重复/跳行）；② 后端支持 cursor+sortBy（有序游标，工作量在 SQL 与游标编码）；③ 维持现状（不提供排序）。
  - **代价**：①② 都是后端/分页契约变更；③ 零成本，但「按名称找任务」只能靠搜索框。
- **D3**：`process.exit(0)` 要不要统一成 `process.exitCode`？—— **未能复现截断**（R202）：8 MB 单次 `console.log` 后立即 `process.exit(0)`，无论重定向到文件还是走真实管道，字节数都与期望完全一致。**不建议基于这个理由改动**；只剩「多写交错 + 中途 exit」这一未测形态。
- **D8**：Agent 的**审批闭环**要不要做？做到什么程度？（2026-10-27 审计轮 #11 新增，A1）
  - **现状（实测）**：`approvalRequired: true` 的 5 个工具（update_task / rollback_task_version /
    upgrade_deployment / stop_deployment / sop_publish）返回 `awaiting_approval`，但
    `requestApproval()` 只拼一个 `apr-<sessionId>-<ts>` 字符串 + 推通知、**不落库**（无 approval
    实体）；`agent.controller` 只有 list/detail/create/resume/budget 五条路由，**没有批准端点**；
    `markWaiting()` 在生产代码零调用方。⇒ 这 5 个工具**永久不可执行**。
  - **本轮已做**：如实降级（注册表 APPROVAL-GAP 注释 + 回给模型的文案改成"当前不可执行" +
    tripwire 防止文案与实现再漂移），**没有**假装它能用。
  - **选项**：① 做完整闭环——新增 `agent_approvals` 实体 + `POST /agent/approvals/:id/grant|revoke` +
    会话恢复后重放该次工具调用（工作量：一条迁移 + 一组端点 + 恢复语义 + 越权面复核）；
    ② 维持降级，把这 5 个工具改成 `hardDisabled`（口径彻底对齐，但失去"人工点头后可执行"的能力）；
    ③ 只做"审批"不做"重放"——批准后由人自己在中台执行该动作，Agent 只拿一条"已批准，请结束"的回执。
  - **代价**：①最完整但最大；②最小、最诚实，但产品上少一个能力；③折中，避免恢复语义的复杂度。
  - **建议**：③ 起步（人对人的审批走既有 DEP-04 通道），把①的"重放"留给确有需求的场景。
- **D4**：66 个未分类错误码要不要加第 7 类，或改成域级提示（R108）。
- **D7**：执行结果回调面的限流桶要不要改**双层**（per-executor 60/min + per-IP 硬顶）？（2026-10-27 审计轮 #7 安全轴新增）
  - **现状**：`ExecutorAwareThrottlerGuard.getTracker` 对执行器机器面路由返回 `executor:{x-executor-address}`（`apps/admin-api/src/common/guards/executor-aware-throttler.guard.ts:136-139`）。该头**客户端可设**，而回调路径是**全仓唯一的 55MB 预认证 body 解析**（`main.ts:208-216`，token 在 handler 才校验）⇒ 每次换一个头值就得到一个全新的 60/min 桶，聚合速率无上限（未认证 DoS 放大面）。`@nestjs/throttler` 6 的 `getTracker` 单返回值语义下无法同时计两个桶。
  - **为什么没直接改**：需要先定 per-IP 硬顶的数值口径——定低了会误杀「大量执行器共享一个 NAT 出口」的既有场景（B-2 当年要修的正是它），定高了缓解有限。属**产品/容量拍板**，不是纯技术选择。
  - **选项**：① 命名 throttler 双层（`default` 走 per-executor、`callback-ip` 走 per-IP 硬顶），`generateKey` 按 throttlerName 分派 tracker；② 只认**已登记**地址（需一次带缓存的查表，guard 引入依赖）；③ 维持现状 + 只加 pre-auth Content-Length 闸（411/413，照抄 `registry-pypi/main.py:412-445`）。
  - **代价**：①要全机器面回归（callback/register/heartbeat/pull/command-result）+ 一次压测；②每请求一次查表且引入 DB 依赖到 guard；③只压单请求成本、不压并发数。
  - **2026-10-27 实施轮 #8 已落地选项 ④（新增，不在原三选之内）并否决 ③**：
    ④ = 在 **body parser 之前**加一条**与分桶无关**的 per-IP 硬顶中间件
    （`apps/admin-api/src/common/middleware/ip-ceiling.middleware.ts`，滑动窗口 +
    429/`Retry-After` + 告警按 IP 节流；额度 `CALLBACK_IP_CEILING_PER_MINUTE`
    默认 12000/min）。它不动 `getTracker` 的分桶语义，因此 B-2 的 NAT 收益零损失，
    也不需要全机器面回归；代价是**每副本独立计数**（总量 = 副本数 × 限额）。
    **③ 被否决**：body-parser 已按声明 `Content-Length` 判上限；执行器回调走 axios /
    `json=` 均带该头，所以 411/413 预检只能挡住扫描器，压不住并发 —— 真正的放大器
    是并发数。**剩余待定**：12000/min 是推算值（100 台 × 60/min 留 2 倍余量），
    需一次真机压测确认；若目标拓扑含 >200 台共享出口，应先调该 env 再部署。
- **D7-2**：`acf executor online` 要不要补？—— （2026-10-27 审计轮 #7 **更正 A3 的定性与结论**）
  - **A3 的原判断**：「CLI 没有 `executor online` 逆操作，运维只能等心跳」被列为真实缺口。
  - **实测更正**：心跳与注册都会**无条件**把该行置回 `ONLINE` 并清 `offlineReason`（`apps/admin-api/src/modules/executor/executor.service.ts:2694-2701`，注释「遗留 P1-24：恢复在线即清除离线原因」）⇒ `POST /executors/:id/set-offline` 是**自愈的**，最迟一个心跳周期（默认 30s）后恢复。
  - **结论**：**不需要新增命令**。该命令唯一收益是省掉 ≤30s 等待，代价是一条新写端点 + 权限面 + 文档。若将来确有「必须立即恢复」的运维场景，先问「为什么不能等一个心跳」。
- **D5**：桌面客户端「配置读取失败」时 UI 语言的兜底默认值应是 zh 还是 en？（UIUX 审计 F-36）
  - **现状**：`UI_LANGUAGE_DEFAULT = 'en'`（`apps/executor-desktop/src/main/ui-language.ts:50`），配置读取失败时整窗按英文渲染（renderer `main.tsx` 启动兜底）；正常路径的默认是 `uiLanguage: 'auto'`（跟随系统语言，zh* → 中文），本常量**只在** config.json 损坏 / IPC 异常 / 旧 preload 缺 getConfig 时生效。
  - **历史纠葛**：语言判定层首版方向是「非 en 即中文」（当时注释与产品早期口径都写「默认中文」），后按产品要求「默认英文、但优先跟随系统语言」反转，代码随之改为 en 兜底，但 `main.tsx` 的注释没跟上（F-36 已把注释改到与实现一致，**行为未动**）。
  - **选项**：① 维持 en（与现实现、渲染层/主进程两侧既有行为一致）；② 改 zh（中文系统上配置损坏瞬间界面不突变，代价是英文/其他语言系统用户在故障瞬间看到中文）。
  - **代价**：①不动代码，接受「中文用户配置损坏 → 瞬间整窗英文」；②改一个常量 + 两侧注释，但属**行为变更**，需回归语言兜底相关 selftest（tray-texts / renderer parity 的「非法值=默认英文」用例组）。

---

## 已结案（无需决策，列出以免重复讨论）

- **6 字段 cron 的「静默降级」**：已证明**不可达** —— 四条写入口全部收口在 `normalizeTaskDto`，非 5 字段在落库前就被拒（R131）。
- **四个库是否导出异常类型**：已修，且 `R134-A1` 是错误面修复，不是设计问题。
- **DST 语义**：`R126-A1` 的实测声明**未被独立复核**（我试了三次未能复现），但仍记在账上，不下结论。
