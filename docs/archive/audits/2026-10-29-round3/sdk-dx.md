# SDK / CLI / MCP / docs-site 开发者体验 审计（2026-10-29 · 第 3 轮）

> 只读审计。基线：工作区 `HEAD`（`git log` 最新为 release 1.15.0 之后的多条 fix），
> `version.txt = 1.15.0`。审计期间未修改任何源码，未跑全量测试套件。

## 1 范围与方法

**范围（本域六个包）**

| 包 | 版本 | 审计面 |
|---|---|---|
| `packages/autocodeflow-node-sdk` | 1.15.0 | `http-client.ts` / `context.ts` / `logger.ts` / `types.ts` / `index.ts` / README |
| `packages/autoflow-sdk`（Python） | 1.15.0 | `http.py` / `callback.py` / `context.py` / `models.py` / README / pyproject |
| `packages/acf-cli` | 1.15.0 | 只做实跑冒烟（版本/帮助/未知子命令/错误路径退出码）+ README |
| `packages/mcp-server` | 1.15.0 | `tools.ts` 工具描述 ↔ 后端路由权限 ↔ DTO 边界 |
| `packages/docs-site` | — | `sdk-node.md` / `sdk-python.md` / `getting-started.md` / `capability-matrix.md` / README 的同步纪律与守卫 |
| `packages/contract-fixtures` | — | `contract.json` 向量面、消费点、ADR-027 关系 |

**方法**

1. CodeGraph `codegraph explore`（projectPath=`/home/yongsheng/project/AutoCodeFlow`）定位 `HttpClient` /
   `TaskContext` / `getParam` / `isRetryableError` 等符号的逐字源码；`http-client.ts` 全文按行读。
2. 文档面与配置面（Markdown / JSON / pyproject）走 grep + read。
3. **实证**：用构建产物 `packages/autocodeflow-node-sdk/dist/index.js` 起真 node 进程读了真实 `retry`
   配置（见 DX-01）；用 `node packages/acf-cli/dist/index.js` 实跑 CLI 四条路径（见 §2）。
4. 去重：先读 `docs/AGENT-SWARM-PLAYBOOK.md` §7、`docs/archive/audits/{cli-agent-ux-audit-2026-10-08,mcp-agent-ux-audit-2026-10-08,audit-ledger-2026-10}.md`、
   `docs/adr/adr-027-test-double-fidelity.md`，再核每个候选是否已登记。
5. 交叉验证守卫覆盖面：`scripts/check-sdk-docs-truthfulness.mjs`、`scripts/check-release-config.mjs`、
   `packages/docs-site/scripts/sync-check.mjs`、`scripts/check-failure-reasons.mjs`、
   `scripts/check-consumer-routes.mjs`（读判据，不跑全量）。

**结论方向**：CLI 与 MCP 的**功能面**在前两轮审计里已被打磨得比较好（本轮实跑 CLI 四条路径未发现新问题，
MCP 工具描述与后端 DTO 边界抽查一致）。本域剩下的问题集中在**「文档/示例/发版物对代码的陈述」**——
即开发者照着读会读到与实现相反的事实，而现有守卫恰好只比对「文档 ↔ 文档」，抓不到这一类。

---

## 2 未覆盖 / 未实测（如实写）

1. **未起 admin-api / 未真机跑平台任务**。所有「后端会 400/403」的结论来自**读 DTO 与守卫装饰器**
   （`@IsEnum`、`@Roles`、`ValidationPipe{forbidNonWhitelisted:true}`），没有实际发请求验证。
   验证方式（给修复 agent）：`docker compose up -d postgres redis && cd apps/admin-api && npm run start:dev`
   后 `POST /api/tasks` 提交 `examples/private-registry-deps-node/task.example.json`。
2. **未跑任何包的完整测试套件**（并发约束：只允许 ≤90s 的针对性脚本）。因此「某行为没有测试覆盖」是按
   `grep` 全仓测试文件得出的（如 `retry: null` 在 `src/__tests__` 中零命中），不是跑出来的。
3. **未验证 PyPI / npm 上的真实发布物**（无网络安装）。DX-03 的「PyPI 页面会显示 1.0.0」是从
   `pyproject.toml: readme = "README.md"` 推断的（PyPI 用该文件作 long_description），未实际打开 pypi.org 页面。
4. **MCP 未做真实 stdio 握手**（前一轮 `mcp-agent-ux-audit-2026-10-08` 已做过，本轮只做静态对读）。
   DX-07 的「非管理员拿到 403」是按 `@Roles(UserRole.ADMIN)` 推断，未用非 ADMIN token 实测。
5. **contract-fixtures 的向量未被逐条执行**。只做了「消费点声明 ↔ 仓库里真实存在的测试文件」对账，
   未验证每条向量在四端都被断言（append-only 段如 `executorEnvSerialization` 已自述「不再对实现断言」）。
6. **未审计 `examples/desktop-automation`**（无 `task.example.json`，与 SDK 面关系弱）。
7. `packages/docs-site` 的 VitePress **构建未跑**（`npm run build` 属安装/构建动作，本轮禁止）。

---

## 3 发现总表

| id | 优先级 | 一句话 | 落点 |
|---|---|---|---|
| SDK-DX-01 | P2 | `{ retry: null }` 文档承诺「关闭重试与熔断」，实现是**空操作**（仍 3 次重试 + 熔断） | `packages/autocodeflow-node-sdk/src/http-client.ts:517-520,547-550` |
| SDK-DX-02 | P2 | 三份文档说 node SDK「无自动重试 / 不校验 failureReason」，代码两条都相反 | `docs/sdk-guide.md:44,51,52`；`packages/docs-site/sdk-node.md:67,87`；`capability-matrix.md`「重试语义」两行 |
| SDK-DX-03 | P2 | PyPI 面 README 自称 `1.0.0` / `1.13.0`、Python `≥3.9`，实际 1.15.0 / `>=3.10`，且无 release-please 标记 | `packages/autoflow-sdk/README.md:124,143`；`packages/autoflow-sdk/pyproject.toml:14` |
| SDK-DX-04 | P2 | `ctx.success()/failure()` 的 `output`、`message`、`logsDropped` 全仓**零消费方**，文档称「随 worker 上报」 | `packages/autocodeflow-node-sdk/src/context.ts:273-307`；`apps/executor-node/src/routes/execute.ts:3094` |
| SDK-DX-05 | P3 | 四个已发布包的 `CHANGELOG.md` 冻结在 1.9.0，实际版本 1.15.0（6 个 release 无条目），结构性原因在发版配置 | `packages/*/CHANGELOG.md:3`；`release-please-config.json`（无 per-package 条目） |
| SDK-DX-06 | P3 | 示例 `task.example.json` 含后端**禁止**的 `id` 字段并**缺必填** `triggerType`，无法作为创建载荷 | `examples/private-registry-deps-node/task.example.json:1` |
| SDK-DX-07 | P3 | 官方 node 示例手写 `getParam` 用 `JSON.parse` 强制转型，与 SDK 已导出的 `ctx.getParam()` 语义相反（py 孪生示例用的是 SDK 方法） | `examples/callback-report-node/callback_report.js:46-56` |
| SDK-DX-08 | P3 | 4 个 ADMIN-only 写工具（3 个 mutex 组 + `update_application`）描述里没有 `ADMIN only.` 前缀（同类已在上一轮修过 6 个工具） | `packages/mcp-server/src/tools.ts:1449,1594,1635,1682`；`mutex-group.controller.ts:47,57,68`；`application.controller.ts:248` |
| SDK-DX-09 | P3 | `ctx.getParam()` 大小写不敏感、Python `ctx.get_param()` 敏感——跨语言移植静默返回 `None` | `packages/autocodeflow-node-sdk/src/context.ts:374-390`；`packages/autoflow-sdk/autoflow_sdk/context.py:157-159` |

---

## 4 逐条证据

### SDK-DX-01【P2】`{ retry: null }` 是空操作——文档承诺的「关掉重试与熔断」不存在

**现象**：构造函数签名与 README 都把 `retry: null` 当作「恢复薄包装行为」的唯一出口，实现里 `null` 与
`undefined` 走同一条分支，落回 `DEFAULT_HTTP_RETRY`。

**逐字代码**

```ts
// packages/autocodeflow-node-sdk/src/http-client.ts:516-520
    /**
     * B-4: 可靠性配置（重试 + 熔断，默认与 python SDK 对齐）。调用方可按需
     * 覆盖；`retry: null` 显式关闭重试/熔断（保持旧薄包装行为）。
     */
    options?: { retry?: Partial<HttpRetryConfig> | null },
```

```ts
// packages/autocodeflow-node-sdk/src/http-client.ts:547-550
    // B-4: 收敛配置（retry: null → 关断重试/熔断，即旧薄包装行为）
    this.retry = options?.retry
      ? { ...DEFAULT_HTTP_RETRY, ...options.retry }
      : { ...DEFAULT_HTTP_RETRY };
```

```md
<!-- packages/autocodeflow-node-sdk/README.md:99-100 -->
`401/403/timeout` 等错误会保留后端 message 后原样传播给任务代码；要完全关掉重试与熔断（恢复薄包装行为）传
`new HttpClient(..., { retry: null })`。
```

**实证**（构建产物 `dist/index.js`，2026-10-29 本机）

```
$ node -e "const {HttpClient}=require('./dist/index.js');
  console.log(JSON.stringify(new HttpClient('http://x','t',undefined,undefined,{retry:null}).retry))"
{"maxRetries":3,"minWaitMs":1000,"maxWaitMs":30000,"retryableStatuses":[429,500,502,503,504],"safeMethodsOnly":true}
```

`retry: null` 与不传 options 的产物**逐字节相同**；`{retry:{maxRetries:0}}` 才真的把尝试次数降到 1。
`grep -rn "retry: null" packages/autocodeflow-node-sdk/src/__tests__` 零命中——没有任何用例钉这个出口。

**触发路径**：任务作者因某端点不希望被重试（或想避免熔断器把后续请求挡成
`CircuitBreakerOpenError`）→ 按 README 传 `{ retry: null }` → 仍走 `maxAttempts = maxRetries + 1 = 4`、
`this.breaker.tryAcquire()` 仍生效（`send()` 循环头 `http-client.ts:752`）。

**影响与量级**：不是「少一个开关」，而是**错误类型会变**。熔断器连续 5 次可熔断失败后 open，下一条
`POST` 直接抛 `CircuitBreakerOpenError`（`name` 与 `HttpClientDisabledError` / axios error 都不同），
调用方 `catch (e) { if (e.response?.status === 503) … }` 会漏接并让任务以非预期错误终止。按
`http-client.ts:204-212` 的阈值 + 默认 4 次尝试，单个 HttpClient 实例在一次 5xx 抖动风暴里就能把熔断器推开。
量级：所有「按文档关掉可靠性层」的外部消费方 100% 失效；本仓内部调用点都用默认值（`forAdminApi` 传
`undefined`），所以存量测试全绿、问题对外部用户才成立。

**最小修法**：`options` 增加显式语义——
`this.retry = options?.retry === null ? { ...DEFAULT_HTTP_RETRY, maxRetries: 0, safeMethodsOnly: false } : options?.retry ? {...} : {...}`，
同时给熔断器一个 `disabled` 位（`send()` 里 `if (this.retry.breakerEnabled === false) { … }` 直接跳过
`tryAcquire/onFailure`），并补一条 `it('retry: null disables retry AND breaker')`（断言 `retry.maxRetries===0`
+ 5 次连续失败不抛 `CircuitBreakerOpenError`）。反证：把实现回退成当前 `? :` 形态，该用例必须红。

**可借鉴的 OSS 做法**：`axios-retry` 用 `retryCondition: () => false` 显式表达「关」；`octokit` 的
`retry: false` 与 `{ retry: { retries: 0 } }` 是同一语义的两种写法且文档明说等价；`tenacity`
（python）用 `retry=retry_if_not_exception_type(...)` 而不是靠「不传」。共同点：**关闭 ≠ 不配置**。

**与既有条目的关系**：`docs/AGENT-SWARM-PLAYBOOK.md` §7 的 `TOOLS-04`（超时只 reject 不取消）与本条同属
「可靠性层行为与声明不符」，但落点、机理、修法完全不同，不重复。

---

### SDK-DX-02【P2】三份文档说「无自动重试 / 不校验 failureReason」，代码两条都相反

**现象**：`http-client.ts` 自 B-4 起默认开启重试 + 熔断（`DEFAULT_HTTP_RETRY.maxRetries = 3`）；
`context.ts` 自 NETOPT-F P3-2 起**本地**校验 `failureReason`。但 `docs/sdk-guide.md`、
`packages/docs-site/sdk-node.md`、`packages/docs-site/capability-matrix.md` 三处仍写「无自动重试」「校验交给服务端」。
三份文档彼此一致（因此同步守卫不报），与代码相反（因此没有任何守卫报警）。

**逐字代码（文档侧）**

```md
<!-- docs/sdk-guide.md:51-52 -->
| **重试语义: http** | ❌ 无自动重试（axios 直传） — `http-client.ts` | … | ✅ 对等：两侧都把重试决策留给任务代码（SAFE_METHODS 重试逻辑在 `autocodeflow-http` 包，非任务 SDK） |
| **重试语义: 回调** | ❌ 无隐式重试（失败即 reject，执行器统一回调兜底） — `http-client.ts` | ❌ 同 — `callback.py` | …
```

```md
<!-- docs/sdk-guide.md:44（节选） -->
… node 为薄客户端不做本地校验，非法值由 admin DTO 拒绝
```

```md
<!-- packages/docs-site/sdk-node.md:67 -->
| 重试 | **无自动重试**——重试决策留给任务代码 |
```

```md
<!-- packages/docs-site/sdk-node.md:87 -->
| `ctx.reportFailure(error, options?)` | … **本地不校验** failureReason 枚举，非法值由 admin DTO 拒绝 |
```

**逐字代码（实现侧）**

```ts
// packages/autocodeflow-node-sdk/src/http-client.ts:92-96,195-201
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET','HEAD','OPTIONS']);
export const DEFAULT_HTTP_RETRY: HttpRetryConfig = {
  maxRetries: 3, minWaitMs: 1_000, maxWaitMs: 30_000,
  retryableStatuses: RETRYABLE_HTTP_STATUSES, safeMethodsOnly: true,
};
```

```ts
// packages/autocodeflow-node-sdk/src/context.ts:451-456
    if (!VALID_FAILURE_REASONS.has(failureReason)) {
      throw new TypeError(
        `invalid failureReason ${JSON.stringify(failureReason)}; expected one of ` +
          [...VALID_FAILURE_REASONS].sort().join(', '),
      );
    }
```

`isTerminalCallbackUrl`（`http-client.ts:113-118`）把回调 POST 也纳入重试面，即「回调无隐式重试」这句
现在是**反的**：`send()` 的 `isSafe` 对 `/api/executions/callback` 显式豁免。

**触发路径**

- 读站点/指南的人 → 判定「`ctx.http.post` 是单发」→ 在**非幂等**语义上依赖这一点（例如把回调当
  「对账触发信号」，或据此设计自己的重试）→ 实际一次 503 会打 4 次（回调通道还带 5s 封顶退避）。
- 读 `sdk-node.md:87` 的人 → 认为非法 `failureReason` 会被后端 400 并拿到可读错误 → 实际在本地抛
  `TypeError`（且是同步抛，不是 reject，`try/await` 之外的 `catch` 写法会漏）。

**影响与量级**：文档站是**对外发布面**（GitHub Pages，`docs-site-deploy.yml` 仅 main 触发，已上线）。
`capability-matrix.md` 还是用户做「要不要从 py 迁 node」决策的唯一对照表，其中 3 行（http 重试、回调重试、
failureReason 校验）是错的，且结论方向恰好是「对等 ✅ / 无需注意」，把差异读没了。

**最小修法**（三步，别只改字）

1. 三处文档改成事实：http 重试 = 幂等方法 `maxRetries=3`（总 4 次）+ 熔断 + `Retry-After`；回调 POST =
   同样重试（`CALLBACK_MAX_WAIT_MS=5s` 封顶）；`failureReason` = **本地**白名单早拒（`TypeError`）＋
   与 `packages/executor-protocol/protocol.json` 的 `executorReportable` 同源。
2. 把 `capability-matrix` 的「重试语义」两行合并成一行「可靠性层（node 有 / py 无，差异原因 X）」，
   避免再出现「同一事实拆两行、改一行漏一行」。
3. **补一条机器守卫**：`scripts/check-sdk-docs-truthfulness.mjs` 目前只判「代码围栏里有 `ctx.` 就必须有
   import」+「必须写明 glue 不装 requirements」。加两条判据：
   (a) 若 `http-client.ts` 里存在 `DEFAULT_HTTP_RETRY` 且 `maxRetries > 0`，则目标文档**不得**出现
   `无自动重试` / `无隐式重试`；(b) 若 `context.ts` 里存在 `VALID_FAILURE_REASONS.has(`，则不得出现
   `本地不校验`。两条都能用一行正则实现，且天然是「代码为真值」的方向（代码改回薄包装时文档必须同步改回）。

**可借鉴的 OSS 做法**：`stripe-node` / `openai-node` 的 README 里，重试策略由**生成**的一段
（`README.md` 中 `<!-- GENERATED: retry -->` 区间）产出，参数表直接从 `DEFAULT_*` 常量渲染；`prisma` 用
`docs/` 与源码常量的一致性脚本。核心是**别让散文描述可被代码推翻的事实**。

---

### SDK-DX-03【P2】PyPI 面 README 的版本与 Python 版本要求双双漂移，且发版工具不会修它

**现象**：`packages/autoflow-sdk/README.md` 里两处版本声明分别写 `1.0.0` 与 `1.13.0`（同一文件两个不同
的错值），Python 要求写 `≥ 3.9`；实际 `pyproject.toml` / `__init__.py` 都是 `1.15.0`，`requires-python = ">=3.10"`。
该 README 正是 PyPI 的项目描述（`readme = "README.md"`），也是 `docs-site/getting-started.md`、
`sdk-python.md` 的源头。

**逐字代码**

```toml
# packages/autoflow-sdk/pyproject.toml:10-14
readme = "README.md"
license = { text = "MIT" }
requires-python = ">=3.10"
```

```md
<!-- packages/autoflow-sdk/README.md:19 -->
要求 Python ≥ 3.9；运行时依赖 `httpx`、`pyyaml`、`pydantic>=2`
```

```md
<!-- packages/autoflow-sdk/README.md:123-124 -->
- 版本策略：与 `@autocodeflow/sdk`（npm）、`autocodeflow-mcp-server` 走
  **lockstep** 单版本线，当前 `1.0.0`。
```

```md
<!-- packages/autoflow-sdk/README.md:143 -->
> 版本随 autocodeflow lockstep 组同步发布(当前 1.13.0,与 mcp-server/acf-cli 同版)。
```

对照（已修好的那一半）：`packages/autocodeflow-node-sdk/README.md:151,171` 两处都带
`<!-- x-release-please-version -->` 且值正确 `1.15.0`；`release-please-config.json` 的 root `extra-files`
里也确有 `packages/autocodeflow-node-sdk/README.md`，**但没有 `packages/autoflow-sdk/README.md`**。
提交 `9c9710e` 的 message 明确记录了「node-sdk README 版本声明双错 → 已修 + 未登记 extra-files」，
**py 侧同款问题没有跟着修**。

**触发路径**：`pip install autoflow-sdk` 的 PyPI 页面（long_description 就是这份 README）显示「当前
1.0.0」→ 用户以为这是 1.0 时代的包，或按「Python ≥ 3.9」在 3.9 环境装 → pip 直接
`ERROR: Package 'autoflow-sdk' requires a different Python: 3.9.x not in '>=3.10'`。
`docs/sdk-guide.md:19` 自己写的是 `Python ≥ 3.10`，即仓库内两份文档互相矛盾，站点镜像了错的那份。

**影响与量级**：3.9 用户**首装必失败**（且报错发生在 resolver 层，看不出是文档错）；版本声明错会让
「这个包多久没更新」的判断失真（对 SDK 类包是采纳决策信号）。扩散面：3 个 md 文件（README +
`docs-site/getting-started.md:20` + `docs-site/sdk-python.md:20`），其中 2 个已挂
`x-release-please-version` 标记，但它们只同步版本号、**不同步「3.9」这个手写正文**。

**最小修法**

1. `README.md:124` → `当前 \`1.15.0\`。<!-- x-release-please-version -->`；`:143` 同改并加标记（照 node-sdk
   的两处写法逐字对齐）；`:19` → `≥ 3.10`。
2. `release-please-config.json` 的 root `extra-files` 追加 `{"type":"generic","path":"/packages/autoflow-sdk/README.md"}`。
3. `packages/docs-site/scripts/sync-check.mjs` 增第 9 面：manifest `requires-python` ↔ 站点「要求 Python ≥ x」
   （现有 8 面里有 lockstep 版本与截断常量，缺运行时版本；这条与 `check-env-drift` 同构，几行正则即可）。
4. 顺手把 `packages/docs-site/README.md` 里「版本号写当前实值 1.3.0」这句流程注记改掉（同一处纪律，已过期 6 个 minor）。

**可借鉴的 OSS 做法**：`pydantic` / `httpx` 的 README 顶部 badge 与 `pyproject` 由 CI 从单一常量渲染；
`astral-sh/ruff` 在 README 里只写「requires Python 3.8+」**一次**，其余处一律引用该句。纪律是
**同一事实只允许一处手写**，其余靠渲染或守卫。

---

### SDK-DX-04【P2】`TaskResult` 的 `output` / `message` / `logsDropped` 全仓零消费方，文档却称「随 worker 上报」

**现象**：node SDK 的主要「人体工学卖点」是 `ctx.success(msg, output)` / `ctx.failure(...)` 构造
`TaskResult`（含 ring 缓冲日志与 `logsDropped` 提示）。但 executor-node 的回调路径用的是**子进程
stdout 缓冲区**，从来不读脚本返回值；`logsDropped` 在全仓除 SDK 自身与测试外零引用。

**逐字代码**

```ts
// packages/autocodeflow-node-sdk/src/context.ts:273-292
  private flushLogs(): Pick<TaskResult, 'logs' | 'logsDropped'> {
    const logs = this.logger.getLogs();
    const dropped = this.logger.droppedCount;
    return dropped > 0 ? { logs, logsDropped: dropped } : { logs };
  }
  success(message?: string, output?: Record<string, unknown>): TaskResult {
    return { success: true, ...(message !== undefined ? { message } : {}),
      ...(output !== undefined ? { output } : {}), ...this.flushLogs() };
  }
```

```ts
// apps/executor-node/src/routes/execute.ts:3086-3097（终态回调只取 stdout 缓冲区）
    const result = await runProcess(cmd, args, workDir, env, timeout, executionId);
    …
    pushCallback({
      executionId,
      status: 'success',
      exitCode: result.exitCode,
      logs: truncateCallbackLogs(result.logs),
      durationMs: Date.now() - startTime,
```

```md
<!-- packages/docs-site/sdk-node.md:115（承诺） -->
| `ctx.success(msg?, output?)` / `ctx.failure(msg?, output?)` | 构造 `TaskResult`，自动附带 `getLogs()` 的日志（`TaskResult.logs` 随 worker 上报进执行日志） |
```

`grep -rn "logsDropped" --include=*.ts --include=*.tsx --include=*.py` 全仓命中：SDK 自身
（`types.ts:107` / `context.ts` / `logger.ts:111`）、SDK 单测 5 处、`dist/index.d.ts`，以及
`apps/executor-desktop/src/main/export-flows.ts`（同名但**不同语义**的字段）。后端 `CallbackItemDto`
（`execution-callback.dto.ts:150-160`）没有 `logsDropped` / `output` 键；但它**有**一个
`result?: Record<string, unknown>`（`:209-225`，`CALLBACK_RESULT_MAX_BYTES = 4096` 体积闸，落
`task_executions.result` jsonb），当前只被 python 执行器用来上报解释器快照——即「结构化结果回传」的
通道早就存在，node 侧的 `TaskResult.output` 只是没接上去。

**触发路径**：任务作者按 README/站点写 `return ctx.success('all done', { rows: 42 })` → 进程退出 0 →
executor 只看 exitCode + stdout → `output` 静默丢弃，`rows: 42` 永远不出现在任何执行详情页。
长跑任务触发 ring 溢出（`MAX_ENTRIES = 1000`）→ `logsDropped` 被算出来但无人读，PK-24 注释里
「truncation stays observable instead of silent」在平台侧不成立（日志本身仍然完整，因为
`TaskLogger.log()` 同时写了 `console.*`，走 stdout 采集——两条通道语义被混为一谈）。

**影响与量级**：这是「功能静默失效」而非体验问题：文档给出的结构化输出通道实际不存在，且失败方向是
**静默**（无报错、无告警）。量级 = 所有用 `ctx.success(msg, output)` 上报结构化结果的 node 任务 100%。
`docs/sdk-guide.md` 的「缺口与计划」只承认「`TaskResult.output` 的 schema 未在 SDK 层校验」——
比现实乐观：不是「没校验」，是「没人读」。

**最小修法**（两条路，选一条并在文档里写清）

- **A（推荐，成本小）**：承认 stdout 是唯一通道 → `TaskLogger` 已写 console，把 `TaskResult` 降级为
  「便捷返回值」并在文档删掉「随 worker 上报」；`logsDropped` 改为在 ring 溢出时**就地打一行**
  `console.warn('...[logs ring overflow] N entries evicted')`，让事实出现在执行日志里（能力等价，零后端改动）。
- **B（补全契约，比预想便宜一半）**：`CallbackItemDto.result` 已存在（4KB 体积闸 `CALLBACK_RESULT_MAX_BYTES`
  已就位），落库列也在（`task-execution.entity.ts:241` 的 `@Column({type:"jsonb"}) result`）。所以只需：
  executor-node 在 entrypoint（打包）任务里取脚本的结构化返回值（建议写 `AUTOFLOW_RESULT_FILE`，避开与
  普通日志混流），塞进回调项 `result`；`logsDropped` 最省的做法是塞进 `result.logsDropped`（不加列）。
  **但**：`result` 目前在 admin-web 侧**没有任何渲染入口**（`ExecutionDetailPage.tsx` / `TaskDetailPage.tsx`
  对 `result` 零引用），所以 B 方案还要顺带补一个展示面板——这是它比 A 贵的地方。

无论走哪条，先补一个「文档承诺 ↔ 真实消费点」的钉子用例：`grep` 断言 `logsDropped` 在
`apps/executor-node/src` 或 `apps/admin-api/src` 至少有一处消费，否则文档不得声称可观测。

**可借鉴的 OSS 做法**：GitHub Actions 的 `$GITHUB_OUTPUT`（写文件而非返回值）、Airflow 的 XCom、
GitLab CI 的 `dotenv` artifact——**子进程时代谢数据一律走显式通道**，没有一个成熟实现依赖「函数返回值」
把结果传回调度器。本项目已有先例可用：`AUTOFLOW_ARTIFACTS_DIR`。

---

### SDK-DX-05【P3】四个已发布包的 CHANGELOG 冻结在 1.9.0，实际版本 1.15.0

**现象**：`@autocodeflow/sdk` / `@autocodeflow/cli` / `autocodeflow-mcp-server` / `autoflow-sdk`
四包 manifest 均为 `1.15.0`，tag `v1.10.0 … v1.15.0` 均已存在，但四份 `CHANGELOG.md` 的最新条目都是
`## [1.9.0] … (2026-10-07)`——6 个 release、20 天无一条记录。

**逐字代码**

```
$ for f in packages/*/CHANGELOG.md; do grep -n "^## \[" $f | head -1; done
packages/autocodeflow-node-sdk/CHANGELOG.md:3:## [1.9.0](…compare/v1.8.0...v1.9.0) (2026-10-07)
packages/acf-cli/CHANGELOG.md:3:## [1.9.0](…compare/v1.8.0...v1.9.0) (2026-10-07)
packages/mcp-server/CHANGELOG.md:3:## [1.9.0](…compare/v1.8.0...v1.9.0) (2026-10-07)
packages/autoflow-sdk/CHANGELOG.md:3:## [1.9.0](…compare/v1.8.0...v1.9.0) (2026-10-07)
$ node -e "console.log(require('./packages/mcp-server/package.json').version)"   # 1.15.0
$ git tag --sort=-v:refname | head -3                                            # v1.15.0 v1.14.0 v1.13.0
```

**根因（结构性，不是忘了写）**：`release-please-config.json` 只有 root 条目 `"."`（`release-type: simple`
+ `version-file: version.txt`），四包的 `package.json` / `pyproject.toml` / `README.md` / 文档站页面全部
以 `extra-files` 形式**被 root 广播版本号**，而 `CHANGELOG.md` 从不在 `extra-files` 里；四包也没有自己的
`packages/<pkg>` 条目。root `CHANGELOG.md` 则是全的（`## [1.15.0] … 2026-10-26` 在 `CHANGELOG.md:3`）。

**触发路径**：消费方/下游审计者在 GitHub 打开 `packages/mcp-server/CHANGELOG.md` 想知道「56 个工具是哪
一版加的」→ 看到的是 1.9.0 的「49→52 工具」→ 与 README「56 tools」冲突，且无从得知 1.10–1.15 发生了什么。
安全问题（如 `1.15.0` 里 `fix(deps): 5 条新 GHSA 清偿`）在包级 CHANGELOG 里完全不可见。

**影响与量级**：不改变运行时行为，但破坏「发布物自带审计轨迹」这一契约：4 个对外发布的包 × 6 个版本。
npm 侧 `files: ["dist"]` 使 tarball 本来就不含 CHANGELOG，所以损害集中在仓库面与 PyPI/GitHub 浏览面。

**最小修法**（二选一）

- **A**：给四包各建 `packages/<pkg>` 条目（`release-type: node` / `python` + `linked-versions` 组已存在），
  让 release-please 真正写包级 CHANGELOG——但要处理「同一 commit 既要进 root 又要进 4 个包」的重复条目。
- **B（更省）**：保留单一 root CHANGELOG，把四包的 `CHANGELOG.md` 改成**指针 stub**
  （标题 + 一句「本包版本随 lockstep 组发布，条目见仓库根 CHANGELOG.md 的 vX.Y.Z 段」+ 最新版本号），
  并加守卫 `scripts/check-release-config.mjs` 判据：`package.json.version` 与「stub 顶部声明的版本」必须相等，
  不等即红（这样 stub 不会再冻结）。
- 无论哪条，都补一条 `check-release-config` 断言：manifest 版本 ∈ 某个 CHANGELOG 的最新条目集合。

**可借鉴的 OSS 做法**：`vercel/next.js`（单仓单 CHANGELOG）、`microsoft/playwright`（`packages/*/CHANGELOG.md`
由 release 脚本从同一 release body 复制）——后者正是「一份内容多处落地」，比「每包独立 release-please」
便宜得多，且不会出现包级条目与根条目口径不一。

---

### SDK-DX-06【P3】示例 `task.example.json` 含后端禁止的 `id`、缺必填 `triggerType`，无法作为创建载荷

**现象**：四个官方示例里的三份 `task.example.json` 字段集与 `CreateTaskDto` 一致（`triggerType` 必填项在、
无额外键），第四份（node 私服依赖示例）多了 `id`、少了 `triggerType`——与它的 python 孪生示例也不一致。
全局 `ValidationPipe` 开了 `forbidNonWhitelisted`，所以这份 JSON **不能**直接作为 `POST /api/tasks` 的 body。

**逐字代码**

```json
// examples/private-registry-deps-node/task.example.json:1-5
{
  "id": "private-registry-deps-node-demo",
  "name": "私服依赖示例（Node）",
  "runtime": "node",
  "entrypoint": "examples/private-registry-deps-node/private_dep_task.js",
```

```json
// examples/private-registry-deps/task.example.json:1-4（python 孪生：无 id、有 triggerType）
{
  "name": "私服依赖示例（Python）",
  "triggerType": "cron",
  "runtime": "python",
```

```ts
// apps/admin-api/src/modules/task/dto/create-task.dto.ts:87（必填，无 @IsOptional）
  @ApiProperty() @IsEnum(TaskTriggerType) triggerType: TaskTriggerType;
```

```ts
// apps/admin-api/src/main.ts:403,407
      whitelist: true,
      forbidNonWhitelisted: true,
```

**触发路径**：用户读 `docs/sdk-guide.md:111`「每个示例自包含…`task.example.json`（最小任务配置）」→
`acf task create --body @examples/private-registry-deps-node/task.example.json`（或脚本 `POST /api/tasks`
把文件原样当 body）→ 400 `property id should not exist`；把 `id` 删掉再试 → 400
`triggerType must be one of the following values`。两次撞墙，且第二次报错指向一个「示例里根本没有的字段」，
用户会先怀疑产品而不是示例。

**影响与量级**：单文件、单示例；但示例是「第一次上手」的路径，且这类偏差**没有任何守卫**。
这正是 `cli-agent-ux-audit-2026-10-08` §8 登记为 `⬜ 未做的 P2-3：示例 payload 与后端 DTO 的自动对账守卫`——
**本条是那个缺口当前实际命中的一个实例**（不是同一 finding 的重复：上一轮只登记「守卫缺失」，
没指出哪份示例已经坏了）。

**最小修法**：删 `id`、补 `"triggerType": "cron"`；然后落 P2-3 的守卫最小版（30 行，零依赖）：
`scripts/check-example-task-configs.mjs` 从 `create-task.dto.ts` 抓顶层属性名集合
（`grep '^  [a-zA-Z]\+[?!]\?:'` + `@IsOptional` 判定必填），与 `examples/*/task.example.json` 的键集双向对账
（多键 → 报「后端会 400 未白名单属性」；缺必填键 → 报「缺必填 X」）。挂进 `test:guards:repo`，
用 `examples/private-registry-deps-node` 的现状做 selftest 反例（红→修绿）。

**可借鉴的 OSS 做法**：OpenAPI 驱动的 example 校验——`dredd` / `schemathesis` 直接用 `openapi.json` 校验
examples 目录；本仓已有 `apps/admin-api/swagger:export` + `scripts/check-openapi-response-schema.mjs`，
把「examples/*.json 逐个 `POST` 到 schema 校验器」接进现有链路的成本很低。

---

### SDK-DX-07【P3】官方 node 示例手写 `getParam` 用 `JSON.parse` 强制转型，与 SDK 的 `ctx.getParam()` 语义相反

**现象**：示例里自定义了一个 `getParam` 直接读 `process.env.AUTOFLOW_<KEY>` 并 `JSON.parse`，把
`AUTOFLOW_LIMIT=3` 变成数字 `3`；而 SDK 的 `coerceParamValue` 明确**故意**把 `"3"` 保留为字符串
（A-11R 的核心教训），并优先读类型化通道 `AUTOFLOW_PARAMS_JSON`。python 孪生示例用的是 SDK 方法。

**逐字代码**

```js
// examples/callback-report-node/callback_report.js:46-56
function getParam(key, defaultValue) {
  const envValue = process.env[`AUTOFLOW_${key.toUpperCase()}`];
  if (envValue !== undefined) {
    try {
      return JSON.parse(envValue);
    } catch (e) {
      return envValue; // 裸字符串不是合法 JSON，原样返回
    }
  }
  return defaultValue;
}
```

```ts
// packages/autocodeflow-node-sdk/src/context.ts:144-153（SDK 的规则：数字只有带小数点/指数才还原）
  if (first === '-' || (first >= '0' && first <= '9')) {
    if (value.includes('.') || value.includes('e') || value.includes('E')) {
      try { return JSON.parse(value); } catch { return value; }
    }
  }
  return value;
```

```python
# examples/callback-report/callback_report.py:64（python 孪生示例用的是 SDK 方法）
    mode = (ctx.get_param("mode") or "success").lower()
```

**触发路径**：用户把示例当模板复制进自己的 node 任务 → 参数 `limit` 配成字符串 `"3"`（控制台
`ParamsEditor` 契约是 `Record<string,string>`，只能产生字符串）→ 示例的 `getParam` 得到数字 `3`，
`if (limit === "3")` 之类分支失效 / `padStart` 抛 TypeError；同时**完全绕过** `AUTOFLOW_PARAMS_JSON`，
于是布尔/容器类型在两个通道间来回失真。同一份逻辑在 python 示例里走 SDK，行为正确——同一作者、同一示例族，
两种语义。

**影响与量级**：示例是「官方推荐写法」的事实标准；`examples/callback-report-node` 被 SDK 指南、
docs-site、两个 README 共 3 处引用。属于**传染性**问题：错误的参数读取范式会扩散到所有复制它的人。
（附带：`getParam('mode','success')` 的 `defaultValue` 与 SDK 的 `fallback` 参数名也不一致，纯 ergonomics。）

**最小修法**：删掉示例里的 `getParam`，改 `ctx.getParam('mode', 'success')`（与 SDK 对齐、与 python 示例
对称）；在文件头注释里保留 A-11/A-11R 的历史说明（那部分信息有价值），但**不要**留一份可被复制的替代实现。
再加一条守卫：`scripts/check-sdk-docs-truthfulness.mjs` 判据 D——`examples/*-node/*.js` 里出现
`process.env[\`AUTOFLOW_` 且同文件出现 `JSON.parse` 时报警（引导用 `ctx.getParam`）。

**可借鉴的 OSS 做法**：`vercel/ai` 与 `openai-node` 的 examples 一律**只调用 SDK 公开方法**，从不读 SDK
已经封装的 env；`supabase-js` 的 examples 目录有 CI 检查「不得出现 `process.env.SUPABASE_`」以外的直读。

---

### SDK-DX-08【P3】四个 ADMIN-only 写工具的描述里没有 `ADMIN only.` 前缀

**现象**：上一轮 MCP 审计（`mcp-agent-ux-audit-2026-10-08`）给 6 个 SOP/agent 工具加了 `ADMIN only.`
描述前缀，理由是「非管理员 agent 只能靠 403 才发现」。此后新增的 MUTEX-01 四工具里，三个写工具
（`create/update/delete_mutex_group`）打的是同样 ADMIN-only 的端点，但**没有**遵循这一约定。

**逐字代码**

```ts
// apps/admin-api/src/modules/application/mutex-group.controller.ts:45-47 / 55-57 / 66-68
  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "创建互斥组" })
  @Put(":id")
  @Roles(UserRole.ADMIN)
  @Delete(":id")
  @Roles(UserRole.ADMIN)
```

```ts
// packages/mcp-server/src/tools.ts:1594-1595（无 ADMIN 提示）
  server.tool(
    "create_mutex_group",
    "Create an application mutex group. Creating a group does not change the behaviour of any existing application — apps join a group only when their mutexGroupId is set (via update_application).",
```

对照（已修的写法）：

```ts
// packages/mcp-server/src/tools.ts:2055
    "Approve a pending deployment (DEP-04). Approving dispatches it to the executor. Second-person rule: the approver must differ from the requester, otherwise the API returns an error. ADMIN only.",
```

**触发路径**：VIEWER/OPERATOR 角色的 agent 被要求「给这两个应用建互斥组」→ 调 `create_mutex_group` →
403 → 按前一轮修好的语义它期望「描述里会告诉我需要 ADMIN」，于是重试两次、换参数、最后才怀疑权限；
期间可能误判为「工具坏了」并改走 `update_application` 的 `mutexGroupId`（`PUT /applications/:id` 也是
`@Roles(UserRole.ADMIN)`，见 `application.controller.ts:248-249`，描述里同样没提），于是第二次 403。
注意 `list_mutex_groups` / `list_applications` 是**全登录用户可读**，所以 agent 能看到组、改不了组——
这是最容易踩的「半可写」形态。

**影响与量级**：P3（连续两次 403 + 无谓往返），但**模式**价值高：这是「约定只对当时那 6 个工具执行过」
的典型缺守卫。逐项核对后：`approve_deployment` / `reject_deployment` / `list_pending_approvals` /
SOP·agent 6 个 ✅ 已有 `ADMIN only.`；**❌ 缺的共 4 个**：`create_mutex_group`、`update_mutex_group`、
`delete_mutex_group`、`update_application`（后者是最高频的写工具之一）。

**最小修法**：四处描述前缀加 `ADMIN only. `（逐字照 2026-10-08 的既有形态，便于 grep）；然后落一条
可机检守卫：`scripts/check-mcp-admin-hints.mjs` —— 对 `tools.ts` 里每个工具，取其 `call<…>("METHOD", "/path")`
的路径，回到 `apps/admin-api/src/**/*.controller.ts` 找同名路由的 `@Roles`；若命中 `UserRole.ADMIN`
而工具描述不含 `ADMIN only`，则报 `tools.ts:行号`。`check-consumer-routes.mjs` 已经在做「MCP 工具 ↔ openapi
路由存在性」的对账，扩一列「roles」即可复用整套解析。

**可借鉴的 OSS 做法**：`stripe-mcp` / `github-mcp-server` 把权限写进 tool `description` 的固定前缀
（`[read-only]` / `[requires: admin]`），并在 CI 里对 `tools/list` 输出做断言；MCP 规范目前没有
「permission hint」标准字段，所以**描述前缀 + 守卫**是当下唯一可靠做法。

---

### SDK-DX-09【P3】`ctx.getParam()` 大小写不敏感 / `ctx.get_param()` 敏感——跨语言移植静默取空

**现象**：node 的 `getParam` 在类型化通道上做**大小写不敏感**回退扫描（注释明确说「任务一直写
`getParam('limit')` 读配置为 `LIMIT` 的参数」）；python 的 `get_param` 是 `dict.get` 精确匹配。两侧
`params` 键在实现里都被小写成小写，所以**只有「用大写/混合大小写去读」这一种写法**会分叉。

**逐字代码**

```ts
// packages/autocodeflow-node-sdk/src/context.ts:374-390
  getParam(key: string, fallback?: unknown): unknown {
    const typed = this.env.params;
    if (typed) {
      if (Object.prototype.hasOwnProperty.call(typed, key)) return typed[key];
      const upper = key.toUpperCase();
      for (const [k, v] of Object.entries(typed)) {
        if (k.toUpperCase() === upper) return v;
      }
      return fallback;
    }
```

```python
# packages/autoflow-sdk/autoflow_sdk/context.py:157-159
    def get_param(self, key: str, default: Any = None) -> Any:
        """Retrieve a task parameter by key."""
        return self.params.get(key, default)
```

**触发路径**：控制台里参数名配成 `LIMIT`（`ParamsEditor` 保留用户输入的大小写）→ 任务写
`ctx.get_param("LIMIT")`：python 在 typed 通道里键已被 `_load_typed_params` 小写化（`context.py:65-67`），
`params` 里是 `limit` → 返回 `None`（无任何提示）；同一逻辑搬到 node 里 `ctx.getParam("LIMIT")` 正常返回。
反向也一样：任务原本在 node 上写 `getParam("Limit")` 跑得好，迁到 python 立刻静默取空。

**影响与量级**：P3（静默 `None`/`undefined` 而不是报错，排查成本高）。`docs/sdk-guide.md` 的能力矩阵
「env 注入: AUTOFLOW_\* 参数」把两侧标为「✅ 语义对等」，未记录这一条差异——与 DX-02 同源（矩阵只对齐
了「都优先 typed 通道」，没对齐「键匹配规则」）。

**最小修法**：pydantic/typing 无法解决，直接让 python 对齐 node——`get_param` 先精确取，未命中再遍历
`{k.lower(): v}` 兜底（3 行）；或反过来把 node 的大小写回退删掉（breaking，不建议）。同时矩阵该行补一句
「键匹配：node 大小写不敏感 / py 精确（本轮已对齐，或明确记为差异）」。

**可借鉴的 OSS 做法**：`os.environ` 在 Windows 上大小写不敏感、POSIX 上敏感——主流库（`django` 的
`settings`、`github` 的 `actions/toolkit` `getInput()`）统一选择「**统一不敏感**，并文档写明」，
因为 env/param 的键名大小写几乎从不是语义。

---

## 5 建议实施顺序（收益 ÷ 风险）

| 序 | 条目 | 收益 | 风险/成本 | 说明 |
|---|---|---|---|---|
| 1 | **SDK-DX-03**（PyPI README 版本 + Python ≥3.10） | 高（对外发布面事实错误 + 3.9 首装必失败） | 极低（改 3 行 + 1 条 config） | 纯文本 + 一条 extra-files；不涉代码，可与任何人并行 |
| 2 | **SDK-DX-02**（三份文档的重试/校验口径） | 高（对外文档站事实相反，且是迁移决策矩阵） | 低（改 4 处 + 2 条守卫判据） | 与 1 同批做，避免「同一文件改两遍」；守卫必须一起落，否则下次再漂 |
| 3 | **SDK-DX-01**（`retry: null` 空操作） | 中高（对外可 catch 的错误类型契约） | 中（要动 `send()` 熔断路径 + 反证用例） | 唯一需要改行为并跑 SDK 单测的一条；建议独立 commit |
| 4 | **SDK-DX-04**（`TaskResult` 无消费方） | 中（当前是静默丢数据；文档承诺落空） | 中（A 方案极小：文档收紧 + ring 溢出就地 warn；B 方案要动 executor 契约 + 补前端展示面板） | 先做 A，B 单独立项；**不要**只改文档不改行为说明 |
| 5 | **SDK-DX-06 + DX-07**（示例可提交性 + 示例 getParam） | 中（首次上手路径） | 低（改 1 个 JSON + 1 个 js，附 1 条守卫） | 两条同属 `examples/`，一次改完；DX-06 的守卫正好回收 CLI 审计的 P2-3 |
| 6 | **SDK-DX-08**（4 个工具 ADMIN 提示 + 守卫） | 中（新工具会持续缺；守卫可复用既有的路由对账） | 低（4 处描述 + 复用 `check-consumer-routes` 解析） | 依赖 MCP 侧无并发改动（当前 `apps/admin-api/src/modules/agent/**` 有未提交改动，`tools.ts` 干净） |
| 7 | **SDK-DX-05**（CHANGELOG 冻结） | 中低（审计轨迹） | 低（选 B 方案：改 4 个 stub + 1 条断言） | 与发版节奏绑定，建议排在下次 release 前，避免与 release-please PR 冲突 |
| 8 | **SDK-DX-09**（get_param 大小写） | 低 | 低（py 侧 3 行 + 矩阵一行） | 可在 DX-02 的矩阵改写里顺手做（同一行文字） |

**不建议本轮做**：`docs-site` 的 VitePress 构建验证（需 `npm install`，与并发纪律冲突）；
把 `outputSchema`/`structuredContent` 加到 56 个 MCP 工具（上一轮已登记为「较重」，且与 DX-04 的
B 方案是同一决策面，应先拍板 B 再做）。

---

### 附：本轮复核为「无需再报」的既有条目

- 上一轮 MCP 审计的三条 `⬜`（`sop_assignments_pending` 全量过滤 / `get_execution` 512KB 常量双写 /
  零 `outputSchema`）——现状与登记一致，未恶化，不重复。
- CLI 的 `⬜ P1-5/P1-6/P2-3`——本轮实跑未发现新增功能缺口；`P2-3`（示例 payload 对账守卫）在本报告
  DX-06 里以「已命中的实例 + 最小守卫」形态给出，属于推进而非重复。
- `docs/AGENT-SWARM-PLAYBOOK.md` §7 的 `TOOLS-04 / TOOLS-06 / desktop-* / data-3 / doc-guard`——不同域、
  不同机理，未触碰。
