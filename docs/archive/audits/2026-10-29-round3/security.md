# 安全纵深：认证授权、隔离、注入、供应链 审计（2026-10-29 · 第 3 轮）

## 1 范围与方法

### 1.1 范围

| 面 | 具体对象 | 说明 |
|---|---|---|
| 认证/授权 | `apps/admin-api/src/common/guards/*`（JwtAuthGuard / RolesGuard / WriteGuardEnforcementInterceptor / ownership-assertion.store / executor-aware-throttler）、`modules/auth/**`、`modules/api-keys/**`、`modules/project/project-access.service.ts` | 含路由级矩阵守卫 `apps/admin-api/scripts/check-route-authz-matrix.mjs` 与 `common/guards/__tests__/route-authz-matrix.spec.ts`（253 路由 / 33 控制器） |
| 机器面凭据 | `modules/executor/executor.controller.ts`、`executor.service.ts`（register / heartbeat / pull / token / command-result / config / terminal-states）、`modules/task/execution-callback.controller.ts`、`modules/sop/sop-collab.controller.ts`、`modules/artifacts/artifacts.controller.ts` | 「执行器地址 + 共享令牌 + per-executor 令牌」三层凭据的全部消费点 |
| 出站/SSRF | `common/utils/safe-http.util.ts`（`assertAndPinHttpUrl` / `pinnedAxiosConfig`）与全部 21 个调用点 | 只验证「是否有未 pin 的调用点」，不重复 D-1/D-2/D-3 的矩阵结论 |
| 注入 | 全部 `.query(` / `Raw(` / `orderBy(` 调用点；`log-retention` 的 DETACH/DROP；registry-pypi 的路径落盘；任务版本/导出白名单 | 只找白名单**之外**的形态 |
| 入站 webhook | `common/utils/webhook-hmac.util.ts` + `task-webhook.controller.ts` + `alerts.controller.ts` + `application.controller.ts` | HMAC 语义与重放面 |
| 供应链/构建 | `.github/workflows/*.yml`（permissions / npm-audit / pip-audit / lockfile 校验）、`apps/*/Dockerfile`、`**/requirements.txt`、`docker-compose*.yml` 镜像引用 | 只看「校验闸覆盖不到」的部分 |

### 1.2 方法（按探查纪律执行）

1. `codegraph status` → 索引 38,004 节点 / 1,972 文件，`Index is up to date`；探查以 `codegraph explore` 为主（`ORDER BY/sort whitelist`、`ApiKeyGuard scope` 等），命中后只对**相关行区间**用 `read`/`sed` 取逐字代码，未通读任何模块。
2. 先读判据与既有账：`docs/SECURITY-REDLINE-CHECKLIST.md`（A-1~G-5 全部红线）、`docs/adr/adr-013-project-roles.md`、`adr-014-oidc-sso.md`、`adr-026-conditional-state-writes.md`、`adr-028-config-secret-at-rest.md`、`adr-017-executor-unique-identity.md`、`scripts/check-constant-time-compare.mjs`、`check-ssrf-deny-parity.mjs`、`check-conditional-writes.mjs`、`check-guards-wired.mjs`、`apps/admin-api/scripts/check-route-authz-matrix.mjs`，以及 `docs/AGENT-SWARM-PLAYBOOK.md §7`、`docs/archive/audits/audit-ledger-2026-10.md`（R1~R6）、`docs/PLAN-CLAIMS.md`。
3. **实跑了 4 个只读守卫**（全部绿，说明「已登记形态」没有回归，缺陷只能在判据之外）：
   - `node scripts/check-constant-time-compare.mjs` → ✔ 1008 文件无凭据 `===`
   - `node scripts/check-conditional-writes.mjs` → ✔ 无条件状态写 0 处（基线 0）
   - `node scripts/check-ssrf-deny-parity.mjs` → ✔ 18 条危险地址三端对齐
   - `node apps/admin-api/scripts/check-route-authz-matrix.mjs` → ✔ routes=253 controllers=33（role-gated 112 / declared-token 22 / declared-public 6 / declared-owner 44 / delegated 6 / open-registered 10 / jwt 53）
4. 逐条 finding 都给出「逐字代码 + 触发路径」；拿不准的地方在条目内显式标 **未验证** 并写验证方式。

### 1.3 与既有账的去重口径

- 未报：`§7 backlog` 的 data-3/desktop-budget/TOOLS-04/TOOLS-06/desktop-resend/doc-guard；R1~R6 台账里已修/已暂缓项（含 B-12 读面无项目隔离、A-12 权限热路径缓存）；SEC-04 SSRF 矩阵、ADR-028 配置密钥明文落库（明确接受现状）、ADR-013 的 executor/package 角色下放裁定。
- 报了的 3 条与既有条目**同源但形态更具体**，条目内均写了「与 X 的关系」。
- 同轮并行报告（`docs/archive/audits/2026-10-29-round3/{executors,db,observability,runtime-perf,web-ux,sdk-dx}.md`）读后核对：无重叠——`executors.md` 只覆盖执行器进程/协议侧（EXEC-01~07），`runtime-perf.md:317` 提到的 `getExecutorStats()` 全列 `find()` 经复核是**性能**问题（响应已显式投影，无 `tokenHash` 外泄），不构成凭据面 finding。

## 2 未覆盖 / 未实测（如实）

| # | 未覆盖项 | 原因 | 建议的验证方式 |
|---|---|---|---|
| 1 | SEC-R3-1/2/3 的**动态复现**（真实打 200 拿到别人 tokenHash / 拉到别人队列） | 只读审计纪律 + 无真机执行器集群，未构造真实攻防 | 在 `apps/admin-api` 集成环境用 `docker-compose.demo.yml` 起两台执行器，持 A 的共享令牌打 `POST /api/executors/heartbeat {address: B}`，断言响应 `tokenHash` 非 null；再打 `pull` 断言返回 B 的队列载荷 |
| 2 | `apps/executor-desktop/**`、`apps/admin-api/src/modules/agent/**` | 另一 agent 正在改（工作区有未提交改动），按并发纪律不深读 | 由其写入方按本轮结论复核（本轮 3 条根因都在 executor 机器面，与 agent 域正交） |
| 3 | executor-node / executor-python 的**本地**注入面（entrypoint、env 白名单、git clone、下载器） | 属 C-1~C-7 红线，已有 spec 锚点且本轮判据未发现新形态 | 按清单 A-1/C-1/C-3 跑既有 spec |
| 4 | DNS rebinding 的**线上验证** | 21 个出站点**全部**使用 `assertAndPinHttpUrl` + `pinnedAxiosConfig`（逐个核过），无未 pin 调用点；因此未做重绑定实验 | 保留：新增出站点时 `grep assertSafeHttpUrl(` 必须为 0（只允许 `assertAndPin*`） |
| 5 | OIDC 协议级攻击（alg 混淆、state 重放） | ADR-014 已把验证矩阵写死并有 13 例真机套件；本轮未重复 | `npm run test:oidc-sso` |
| 6 | 全量测试 / 全量守卫链 | 明令禁止（≥90s、禁全量） | 修复 agent 按 playbook §5 矩阵跑 |
| 7 | `check-constant-time-compare` 的**函数名不含敏感词**的比较（如 `expected === received`） | 判据只认标识符名，属已知盲区；本轮抽查 hit 面未见实例 | 若要机械化：把「HMAC/base64 结果比较」纳入判据，或对 `webhook-hmac.util` 这类文件加 allowlist 断言 |
| 8 | `docker-compose.ha.yml` / `staging` 的 TLS 与反代头信任 | 属部署面，非本轮域 | 随 `check-compose-sandbox` 扩展 |

## 3 发现总表

| id | 优先级 | 一句话 | 落点 |
|---|---|---|---|
| SEC-R3-1 | **P1** | 集群共享令牌被当作 per-executor 面的等价凭据：持共享令牌 + 目标 address 即可让 register **轮换并回传**该执行器的明文 per-executor 令牌（原机被 401），或从 heartbeat 响应**读走**其回调 HMAC 密钥 `tokenHash` | `apps/admin-api/src/modules/executor/executor.service.ts:7380`、`:2941`、`apps/admin-api/src/modules/executor/executor.controller.ts:509` |
| SEC-R3-2 | **P1** | `POST /executors/pull` 用共享令牌即可解析到**任意**执行器行并取走其队列载荷，载荷内含 `decryptForDispatch` 解出的**明文任务 secrets**（顺带把对方队列耗尽） | `apps/admin-api/src/modules/executor/executor.controller.ts:586`、`executor-pull.service.ts:585/604`、`executor.service.ts:6025`、`:1460` |
| SEC-R3-3 | P2 | `POST /api/executions/:id/logs` 的共享令牌兜底**不校验该 execution 的执行器归属** → 任意执行器的日志行可被写入任意 execution（伪造排障/取证证据 + 行膨胀） | `apps/admin-api/src/modules/task/execution-callback.controller.ts:492` |
| SEC-R3-4 | P2 | 入站 webhook（任务触发 / Alertmanager / 应用 CI）只有 ±5min 时间戳窗、**无 nonce 与幂等键** → 一次抓包可在 5 分钟内无限次重放，重复触发任务 / 重复外发告警 | `apps/admin-api/src/common/utils/webhook-hmac.util.ts:65`、`modules/task/task-webhook.service.ts:279`、`:306` |
| SEC-R3-5 | P3 | `@WriteGuard` 的「已授权证据」在判定**之前**无条件落证，且 `assertCanOperate` 在主体缺失时直接放行 → 强制点无法区分「校验过」与「根本没校验」（`trigger(..., null, "webhook")` 就是这种调用） | `apps/admin-api/src/modules/task/task.service.ts:1094`、`:1153`、`:1165`、`:1176` |
| SEC-R3-6 | P3 | 供应链：镜像全用可变 tag、Python 依赖无 hash 且 `tenacity>=8.2.0` 浮动区间 → 重建镜像时对「上游被替换 / 上游发新版」零防御 | `apps/executor-python/Dockerfile:5`、`apps/executor-python/requirements.txt:5`、`docker-compose.yml`（`postgres:16-alpine` 等 13 处） |
| SEC-R3-7 | P3 | DR-01 的残余面：安装命令把**集群共享令牌**放进 shell argv（`--secret '<token>'`），会落进目标机的 `~/.bash_history` 与安装期的 `ps` 可见面 | `apps/admin-api/src/modules/executor/executor.service.ts:7684` |

> 共 7 条（宁少勿滥）。P1 两条、P2 两条、P3 三条。

## 4 逐条证据

---

### SEC-R3-1（P1）共享令牌 = per-executor 身份：register 可轮换并回传他人的令牌，heartbeat 可读走他人的回调 HMAC 密钥

#### 现象

`authenticateMachineRequest` 是全部执行器机器面（register / heartbeat / pull / token / command-result / config / terminal-states / agent-collab 九条）的**唯一认证入口**，它按顺序试三种凭据，第 ② 种就是**集群共享令牌**：

```ts
// executor.service.ts:7379-7385
    // ② 共享令牌（与引入本方法前逐字节一致：timing-safe 比对，空配置即不可用）
    const sharedOk = await this.compareSharedToken(presented);
    if (sharedOk) {
      this.rememberTokenValidation(cacheKey, address, now);
      // 共享令牌**不**采纳自报 id（见头注安全边界）：歧义态仍是 null。
      return { ok: true, executor, via: "shared", resolvedBy };
    }
```

它返回的 `via` 字段**没有任何调用方消费**（全仓 `grep "\.via"` 仅命中定义与返回语句），也就是说「共享令牌」与「该行自己的 per-executor 令牌」在下游完全等价。

于是两条具体越权成立：

**(a) 回调 HMAC 密钥外泄。** heartbeat 响应回传该行的 `tokenHash`：

```ts
// executor.controller.ts:509
    const tokenHash = await this.svc.getCallbackSecretById(saved.id);
    ...
    return { ...saved, tokenHash, minVersion: ..., versionCompliant: ... };
```

而 `tokenHash` 列不是「不可逆的比对哈希」——它就是回调令牌的 **HMAC 密钥本体**：

```ts
// executor.service.ts:7557-7563  getCallbackSecretById → 直接返回 e.tokenHash
    const executor = await this.repo.createQueryBuilder("e")
      .addSelect("e.tokenHash").where("e.id = :id", { id }).getOne();
    return executor?.tokenHash ?? null;

// execution-callback.controller.ts:357-374（N26：拿 tokenHash 当 HMAC 密钥试签）
      const secrets = await this.executorService.getCallbackSecretCandidatesByAddress(addr);
      const claims = verifyExecutionCallbackToken(token, secrets);
      if (claims) return claims;
```

DTO 自己也把这一点写明了：`ExecutorHeartbeatResponseDto.tokenHash` 的描述是「该执行器的回调鉴权 secret（机器面：持有令牌的一方可取回它来为执行回调签名）」。

**(b) 身份接管（更严重）。** register 用不同 `startupId` 时走轮换，并把**新明文令牌**回给调用方：

```ts
// executor.service.ts:2878-2885（N4 判据：sameProcess 才算幂等）
    const perExecutorToken =
      prior?.tokenHash && sameProcess
        ? null
        : await this.issueTokenForDuplicateRegister(executor, incomingStartupId);
// executor.service.ts:2941（非幂等分支 → 轮换并返回明文）
    return (await this.rotateToken(executor.id)).token;
```

#### 触发路径

1. 攻击者取得集群共享令牌。三个现实来源：① 任一执行器的 `.env`（`EXECUTOR_SHARED_TOKEN`，install.sh 以 600 权限落盘但**每台执行器都有**）；② `GET /api/executors/install-cmd`（ADMIN）返回的 `token` 字段；③ 备份/镜像/日志。
2. 取得目标地址：`GET /api/executors` 或 `/api/executors/picker` 对**任何已登录用户**可见（`jwt` 形态，无 `@Roles`；ADR-013 §6 的读面开放裁定）。
3. 打机器面（`@Public` + 共享令牌即可）：
   - `POST /api/executors/heartbeat` `{address:"<victim>"}` → 响应 `tokenHash` = 受害者回调 HMAC 密钥；用它可以对**任意 executionId** 现签 `v1.` 回调令牌（executionId 由 `GET /tasks/executions/all` 可读）→ `POST /api/executions/callback` 改写终态、`POST /api/executions/:id/logs` 注入日志。
   - `POST /api/executors/register` `{address:"<victim>", startupId:"attacker-1", ...}` → 响应 `perExecutorToken` = 受害者新令牌明文，受害者原令牌立即失效（原机 401，且 `pull` 真空 → 任务卡 RUNNING 直到 stale sweep）。

#### 影响与量级

- 这是一条**从「一个执行器被攻陷」到「全部执行器 + 全部任务 secrets + 全部回调通道」的横向移动链**：单台执行器（任务代码 `env` 白名单不含共享令牌，但执行器进程本身持有）即可拿到全机队。
- 与 A-2 红线（per-execution 回调令牌绑定单一 executionId）的关系：签名仍然绑定 executionId，但**签名密钥可被读走**，绑定就只剩形式。与 SEC-01（共享令牌不进任务子进程）的关系：子进程不持有，但执行器进程持有，A-1 的隔离被这一层绕过。
- 与 `docs/PLAN-CLAIMS.md` ARCH-36-R3 的关系（**必读**）：该条已登记「共享令牌是全机队单一密钥，本方案不提升对抗已持共享令牌攻击者的强度，属独立议题」。本 finding **不重复**那个「上限」判断，而是给出该上限的**具体可利用形态**（register 轮换回传明文 / heartbeat 回传 HMAC 密钥），并指出两处**不需要改动共享令牌模型就能收紧**的点——原条目只讨论「回调行身份归属」，未涉及「凭据外发」。

#### 最小修法（不动共享令牌模型，收益/风险最优）

1. `heartbeat` / `register` 的 `tokenHash`：仅当本次请求 `via === "per-executor"`（或 `resolvedBy === "fingerprint"` 且该行令牌已验证）时才回传；`via === "shared"` 一律回 `tokenHash: null`。兼容面可控：`G3` 修复（R32-A3）之前心跳响应的 `tokenHash` **长期恒为 null**，说明执行器侧对 null 的处理（保留本地既有密钥）是既有可达分支，不是新增协议状态。
2. `register` 的轮换：`via === "shared"` 且该行**已存在** `tokenHash` 时，**不轮换**，返回 `perExecutorToken: null`（让持共享令牌的调用方只能「续用旧身份」，拿不到新明文；真实重启场景由指纹路径覆盖）。
3. 加守卫：`scripts/` 里新增一条静态判据——`authenticateMachineRequest` 的返回值若用于**返回凭据类字段**的端点，必须消费 `via`（可用 spec 断言 `shared` 调用下响应不含 `tokenHash`）。

#### 可借鉴的 OSS 做法

- Kubernetes kubelet 的 `--bootstrap-kubeconfig` / TLS bootstrap：**引导凭据只能换取「自己的」长期凭据**，且 CSR 必须由节点用自己的密钥签名——引导令牌不是万能凭据。
- Nomad / Consul 的 `bootstrap token` 与 `node identity token` 分离：bootstrap 仅用于签发节点身份，节点身份绑定 NodeID，服务端按 NodeID 决定返回哪些数据（`nomad node status` 只回自己）。
- Vault 的「response wrapping」：凭据仅回传给**已通过身份验证的具体实体**，且一次性。

---

### SEC-R3-2（P1）pull 面用共享令牌即可收割他人队列中的明文任务 secrets

#### 现象

`POST /executors/pull`（`@Public` + `@WriteGuard(scope:"token")`）用同一个入口认证，然后**只**看 `authz.ok` 与 `authz.executor`：

```ts
// executor.controller.ts:586-600
    const authz = await this.svc.authenticateMachineRequest(body.address, token, {...});
    if (!authz.ok) { throw new AppError("INVALID_EXECUTOR_TOKEN"); }
    if (!this.pullService) { throw new AppError("EXECUTOR_PULL_UNAVAILABLE"); }
    const executor = authz.executor;
    if (!executor) { throw new AppError("EXECUTOR_NOT_FOUND"); }
```

`authz.via` 未被检查 → 共享令牌通过 → 行由 `body.address` 解析 → 队列键是 `executor.id`：

```ts
// executor-pull.service.ts:499
    const taskKey = this.queueKey(executorId);
// executor-pull.service.ts:585, 604
      const raw = await client.rpop(taskKey);
      ...
        return payload;            // 原样返回入队载荷
```

而入队载荷里就带着**已解密**的任务密钥：

```ts
// executor.service.ts:6025（pull 分支入队）
          await this.pullService.enqueue(executor.id, {
            executionId: execution.id, task: dispatchTask, params: dispatchParams,
            secrets: dispatchSecrets,
// executor.service.ts:1458-1460
  private buildDispatchSecrets(task: Task) {
    return this.secretsCrypto.decryptForDispatch(task.secrets) ?? null;
```

#### 触发路径

1. 同 SEC-R3-1 的 1~2 步：拿到共享令牌 + 目标 address。
2. `POST /api/executors/pull`，`Authorization: Bearer <shared>`，body `{ "address": "<victim>", "freeSlots": 1, "waitMs": 0 }`。
3. 响应 `{ task: { executionId, task:{...glueSource/gitRepo...}, params, secrets:{...} } }`——`SEC-02` 加密存储的任务级密钥在**传输面明文**落到攻击者手里；同时 `RPOP` 已把载荷**从队列移走**，受害者那笔派发永久丢失（执行行停在 PENDING/RUNNING，直到 stale sweep 或永不执行）。

#### 影响与量级

- 直接抵消 SEC-02（`tasks.secrets` 静态加密）与 A-2（回调令牌绑定）两条红线：加密在库里成立，在「谁能取到派发载荷」这一层失守。
- 量级：每次 `pull` 取走一条（`takeTask` = 单次 `RPOP`，无租约、无回滚），**重复调用即可把目标执行器整条队列搬走**；单执行器队列按派发窗口可达数十条，每条含该任务的完整 secrets 与源码引用。
- 在 Ha/多执行器形态下不需要任何受害者配合（受害者无感，只是任务迟迟不跑）。

#### 最小修法

1. **优先**：`pull` / `agent-collab/poll` / `terminal-states` 这类「读某行私有数据」的端点，要求 `via === "per-executor"`；`via === "shared"` 一律 403（错误码复用 `INVALID_EXECUTOR_TOKEN`，不引入新可枚举面）。共享令牌只保留给 register/heartbeat/offline 这些「不返回他人私有数据」的面。
2. 若必须保留共享令牌兜底（旧执行器兼容）：把「队列出队」与「凭据类别」绑定——共享令牌只允许取 `commands`，不允许取 `task`（`wantTask && via === "shared"` → 拒绝并 warn）。
3. 测试：`executor.controller.rbac.spec` 同目录新增 `pull.shared-token.spec`，断言共享令牌 + 他人 address 返回 403 且队列长度不变。

#### 可借鉴的 OSS 做法

- AWS IoT Core / Greengrass：设备凭据（每设备唯一）才可订阅自己的 topic；group 共享证书无法订阅他人影子。
- Jenkins agent 的 `JNLP secret`：每个 agent 一个 secret，controller 按 secret 反查 agent，URL 里的 name 不作为身份。
- Temporal worker 的 task queue 用 **namespace + identity** 双键，服务端在 PollTaskQueue 时校验 identity 与 namespace 配额。

---

### SEC-R3-3（P2）`POST /api/executions/:id/logs` 的共享令牌兜底不校验执行归属

#### 现象

单执行写授权在 v1 令牌与非 v1 令牌两条分支，非 v1 分支的最后一步是**裸共享令牌**，且不再与 `execution` 行做任何绑定：

```ts
// execution-callback.controller.ts:479-497
    // 非 v1 令牌：per-address 校验（地址取自该执行行），失败退共享令牌。
    const address = await this.taskService.findExecutionAddress(executionId);
    ...
    const isValid = await this.executorService.validateTokenByAddressAnyRow(address, token);
    if (!isValid) {
      try {
        await verifyExecutorToken(auth, this.configService, this.systemConfigService);
      } catch (err) { ... throw err; }
    }
    this.callbackMetrics.recordAuthResult("ok");
```

`verifyExecutorToken` 只比字符串（`common/utils/verify-executor-token.util.ts:38-65`），**没有任何「这个 execution 属于谁」的判据**。对比同一文件里 `v1.` 分支会强制 `claims.executionId === executionId`（单执行绑定），共享令牌分支等于把这条绑定删掉了。

#### 触发路径

1. 持共享令牌（任一执行器 `.env`）。
2. 取 executionId：任何已登录用户可 `GET /api/tasks/executions/all`（读面开放）。
3. `POST /api/executions/<victim-execId>/logs`，body `{ fromLine: 0, lines: ["...伪造输出..."] }` → 200，行落 `execution_log_lines` 并由 SSE 实时推给正在看日志的用户。

#### 影响与量级

- 伪造排障/取证证据：日志是事故复盘的**唯一事实源**之一（F 域「观测即验证产物」），跨项目注入可让运维/审计把结论建立在他人伪造的文本上；也可注入超长行（受 512KB/条约束但可多条）造成行膨胀与磁盘占用。
- 与 `execution-callback` 的批量面不同，这条路径**不需要**知道/伪造 `executorAddress`，成本更低。
- 与 R3-B1（澄清注入）/A-2 的关系：那两条已收紧「谁能写某会话/某执行」，本条是同一族形态（机器面凭据 + 路径 id）在 RT-LOG 端点上的**新入口**（RT-LOG 是后加端点，未纳入 A-2 的「逐 item 校验 address 一致」判据）。

#### 最小修法

把共享令牌分支也纳入归属判据：`via === "shared"` 时，要求 `execution.executorAddress` 的解析结果与**请求方自报且能被行证明**的身份一致；由于共享令牌不绑定行，最简做法是——`/executions/:id/logs` **只接受 `v1.` 或该行的 per-executor 令牌**，共享令牌在 RT-LOG 面直接 403（执行器侧早就用 per-execution 令牌上报日志，兼容面只剩旧版本，回退到「终态回调一次性带 logs」仍可用）。

#### 可借鉴的 OSS 做法

- GitHub Actions 的 job logs 上传：runner 用**该 job 专属**的 token（`ACTIONS_RUNTIME_TOKEN`），不接受仓库级共享令牌。
- Loki 的 push API 在多租户模式下强制 `X-Scope-OrgID`，缺失即 401——共享凭据不能隐式跨租户。

---

### SEC-R3-4（P2）入站 webhook 只有时间戳窗、无 nonce/幂等键 → 5 分钟窗口内可重放

#### 现象

三个入站 webhook（任务触发 / Alertmanager 告警 / 应用 CI）共用同一判定函数，签名覆盖 `${timestamp}.${rawBody}`，时间窗 ±5 分钟，**没有**用过的签名缓存：

```ts
// webhook-hmac.util.ts:65-80
  if (!input.signature) return "missing_signature";
  if (!input.timestamp) return "missing_timestamp";
  const timestampMs = Number(input.timestamp);
  const windowMs = opts?.windowMs ?? WEBHOOK_TIMESTAMP_WINDOW_MS;   // 5 分钟
  if (!Number.isFinite(timestampMs) ||
      Math.abs((opts?.nowMs ?? Date.now()) - timestampMs) > windowMs) {
    return "stale_timestamp";
  }
```

校验通过后直接触发执行，无任何去重：

```ts
// task-webhook.service.ts:279-292（验签）→ :306（触发）
    const failure = verifyWebhookSignature({...}, this.resolveSecret(task.webhookSecret));
    if (failure) { ... throw authFail(); }
    ...
    const exec = await this.taskService.trigger(task.id,
      dto.params !== undefined ? { params: dto.params } : {}, null, "webhook");
```

#### 触发路径

1. 攻击者在任意能看到该请求的环节（反代 access log 只记路径但**请求体/头可能进 WAF、APM、抓包、CI 日志**，或本机 `tcpdump`）取到一次完整请求（`X-Hub-Signature-256` + `X-AutoCodeFlow-Timestamp` + body）。
2. 在 5 分钟内原样重放 ≥N 次：每次都是新 `executionId`，`trigger` 无幂等键 → **任务被重复执行 N 次**（对「清理/发布/对账」类任务即数据损坏风险）。
3. 同样的重放对 `POST /api/alerts/webhook` 是**告警外发放大**（每重放一次全渠道扇出一次）。

#### 影响与量级

- 触发面：单次抓包 → 5 分钟内任意次重复执行（受 `WEBHOOK_THROTTLE` 60/min 限速，但 5 分钟仍有 ~300 次额度）。
- 与 A-2/E-2 的关系：A-2 管的是回调令牌（有 `.meta` 重试与 dead-letter），本条是**入站触发**面，既有账里只有「反枚举」「payload 体积门」，没有重放账目。

#### 最小修法

1. 加一个**签名去重键**：`SETNX webhook:{taskId}:{signature} 1 EX 600`（与时间窗同刻度），命中即 200/409 幂等返回首次结果（Redis 已是强依赖，`executor-pull` 与 throttler 都在用）。
2. 或（无 Redis 依赖的部署）在 `task_executions` 加唯一列 `webhookSignature`，`trigger` 落库时撞唯一键即返回既有 execution（与 ADR-003 幂等签发同款思路）。
3. 契约：`X-AutoCodeFlow-Delivery` 可选头（GitHub 惯例），提供时以其为主键去重。

#### 可借鉴的 OSS 做法

- GitHub webhooks：`X-GitHub-Delivery` UUID 由投递方生成，接收方按它去重（官方文档明确要求「用 delivery ID 做幂等」）。
- Stripe webhooks：`Idempotency-Key` + 事件 id 双保险，且文档要求「收到即持久化，处理可重放」。

---

### SEC-R3-5（P3）`@WriteGuard` 的「授权证据」与「授权判定」解耦：落证在判定之前，主体缺失即放行

#### 现象

证据在函数**第一行**无条件落，判定在其后；因此「进过这个函数」就等于「校验过」：

```ts
// task.service.ts:1088-1097（assertCanWrite）
  assertCanWrite(row, user): void {
    // A2-B: 先落证再判定——「判定过」本身就是证据（ADMIN 放行同样是授权决策），
    recordOwnershipAssertion("task", "write");
    if (user?.role === UserRole.ADMIN) return;
```

`assertCanOperate` 更直接——主体缺失时它**不判定就返回**，但证据已经落了：

```ts
// task.service.ts:1153 → :1165 → :1176
    recordOwnershipAssertion("task", "operate");
    ...
    if (this.isOperateScopeOwner() && principalId !== undefined) { ... }
    ...
    if (!this.projectAccess || principalId === undefined) return;   // 放行
```

而拦截器只看证据是否存在：

```ts
// write-guard-enforcement.interceptor.ts:73-85
        next: () => {
          if (hasOwnershipAssertion(resource, required)) return;
          ... throw new AppError("WRITE_GUARD_ASSERTION_MISSING");
```

#### 触发路径

生产代码里确实存在「以 null 主体调用」的路径：`task-webhook.service.ts:306` 的 `this.taskService.trigger(task.id, {...}, null, "webhook")` → `trigger` 内部 `assertCanOperate(t, null)` → 落 `task:operate` 证据 + 直接放行。当前 webhook 路由声明的是 `scope:"public"`（不需要该证据），所以**今天不可利用**；但只要有一条 `scope:"project-role"` 的路由复用 `trigger(...)` / 复用 `assertCanOperate` 而漏传 `user`（R-02 已记录过两次真实漏传），拦截器会**判绿**，缺省拒绝的强制点失效。

#### 影响与量级

- 这是「防线对**未来**同类缺陷免疫力的缺口」，不是当前利用链：R-02 的两次漏传正是该类缺陷的历史证据，而 A2-B 的拦截器正是为了防它。
- 与 A2-B 的关系：拦截器把「声明 → 强制执行」补上了，但证据的**语义**还是「调用过」而不是「判定为允许」。

#### 最小修法

1. `recordOwnershipAssertion` 只在**明确放行**的分支调用（ADMIN 放行、属主命中、项目 editor 命中、viewer 之外的放行兜底各一处），把三处「先落证」移到判定之后。
2. `assertCanOperate` 的 `principalId === undefined` 分支加 `adr-026-exempt` 风格的显式标记：要么抛 403（机器面不该走这条），要么显式 `recordOwnershipAssertion("task","operate", {principalMissing:true})` 并在拦截器里拒绝该证据。
3. 加单测：`write-guard-enforcement.spec` 增一条——`assertCanOperate(task, null)` 之后 `hasOwnershipAssertion("task","operate") === false`。

#### 可借鉴的 OSS 做法

- OPA / Cedar 的 `decision log`：只有 `allow/deny` 的**结论**被记为证据，请求「进过策略引擎」不算证据。
- Django `user_passes_test` / DRF `permission_classes`：只有返回 `True` 才继续，无「已检查」副作用。

---

### SEC-R3-6（P3）供应链：镜像可变 tag + Python 依赖无 hash + 一个浮动版本区间

#### 现象

```dockerfile
# apps/executor-python/Dockerfile:5
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt
```
```text
# apps/executor-python/requirements.txt:5
tenacity>=8.2.0
```
```yaml
# docker-compose.yml（13 处 image 引用，无一按 digest 钉死；示例 3 处）
      image: postgres:16-alpine
      image: redis:7-alpine
      image: node:24-alpine
```

CI 侧本身是硬的（`npm-audit` + `pip-audit` + 豁免复查 `check-dependency-review.mjs` + lockfile↔manifest `npm ci --dry-run`），但**构建期完整性**没有任何判据：`pip install` 不校验 hash、镜像 tag 可被上游重新推送、`tenacity>=8.2.0` 允许任何未来版本（含 major）静默进入。

#### 触发路径

- 上游账号被攻陷 / 包被转移（PyPI 支持项目所有权转移）→ 在 `tenacity`（或任一 `==` 钉死但**未 hash** 的包）上发布同版本号的恶意重传（PyPI 允许 yank 后重传？不允许同版本覆盖，但**镜像层缓存 + 恶意新版**在 `>=` 区间下必然被解析到）→ 下一次 `docker build` 即把恶意代码装进执行器镜像，执行器以持有共享令牌的身份运行（直通 SEC-R3-1/2）。
- 镜像侧：`postgres:16-alpine` 等 tag 被重新指向（上游常规操作）→ 不重建代码即可换掉运行形态；`docker-compose.secure.yml` 的安全姿态随之失效。

#### 影响与量级

- 概率低、影响极高（构建期 = 供应链最高杠杆点）；且当前**无任何告警**（`pip-audit` 只查已知 CVE，查不到「新发布的恶意版本」）。

#### 最小修法

1. `pip install --require-hashes -r requirements.txt` 并生成 `requirements.lock`（`pip-compile --generate-hashes`）；把 `tenacity>=8.2.0` 改成 `tenacity==<实测版本>`。
2. 生产 compose 的 13 个镜像改 `image: repo@sha256:<digest>`（保留 tag 作注释），或至少对 `postgres/minio/verdaccio` 这几个「数据面 + 分发面」镜像钉 digest。
3. 加守卫：`scripts/check-image-digests.mjs`（判据：生产 compose 的 `image:` 必须含 `@sha256:`；豁免表显式列理由）并接入 `check-guards-wired`。

#### 可借鉴的 OSS 做法

- Kubernetes 官方镜像 + `cosign`/`kyverno` 的 `verifyImages`：镜像按 digest 部署。
- `pip-compile --generate-hashes`（pip-tools）/ `uv pip compile --generate-hashes`：本仓已依赖 `uv`（pinned `0.13.4`），用它产出 hash 锁成本极低。
- Sigstore `cosign verify-attestation` 在 CI 里对发布产物做来源校验。

---

### SEC-R3-7（P3）DR-01 残余：安装命令把集群共享令牌写进 shell argv

#### 现象

```ts
// executor.service.ts:7684
    const cmd = `curl -fsSL ${q(scriptUrl)} | bash -s -- --api-url ${q(adminApiUrl)} --secret ${q(sharedToken)}`;
```

A-4/DR-01 已把「脚本本体含凭据」修掉（`install.sh` 只从 `--secret` 读），但**命令字符串本身仍含明文令牌**，且它的使用方式是把整串粘到目标机 shell。

#### 触发路径

1. ADMIN 在 admin-web 复制该命令 → 粘到目标机 root shell。
2. 令牌进入三处可见面：目标机 `~/.bash_history`（默认 600 但 root 下多用户可读场景存在）、`/proc/<pid>/cmdline`（`bash -s -- --secret ...` 存续期间任何本机用户 `ps aux` 可见）、以及 ADMIN 自己的终端历史/剪贴板。
3. 拿到令牌 = SEC-R3-1/2 的入口凭据。

#### 影响与量级

- 单机本地信息泄露（低概率、需要本机其他用户或历史文件外泄），但泄露物是**集群级**凭据，故仍值得收。

#### 最小修法

1. 改为「一次性安装凭据」：`POST /executors/install-token` 签发 TTL 10min、单次消费的 bootstrap token（服务端存 hash，`register` 首用时兑换成正式 per-executor token），命令里只放 bootstrap token。
2. 兼容最小步：命令改为从 stdin 读 secret（`read -s`），或 `--secret-file <(printf %s '<token>')` 并文档化「不要粘贴到共享历史」；同时在 `install.sh` 里 `history -d`/提示 `HISTCONTROL=ignorespace`。
3. 审计面已具备（`executor.install_cmd_viewed`），可一并记录「签发了 bootstrap token」。

#### 可借鉴的 OSS 做法

- `kubeadm join --token`（24h TTL、单次使用、可 `--discovery-token-ca-cert-hash` 绑定）——引导凭据短命且一次性，是这类「一条命令装一台机器」的标准形态。
- Tailscale `auth key`：可设 ephemeral + single-use + 标签，安装命令只带它。

---

## 5 建议实施顺序（收益 ÷ 风险）

| 序 | 条目 | 收益 | 风险/成本 | 依赖 | 建议动作 |
|---|---|---|---|---|---|
| 1 | **SEC-R3-1**(a) heartbeat/register 在 `via==="shared"` 时不回传 `tokenHash`、不轮换令牌 | 切断「共享令牌 → 他人回调 HMAC 密钥 / 明文令牌」这条最短链，且**不改凭据模型** | 低：执行器侧已有 `tokenHash:null` 的容忍分支（G3 注释）；需回归 `executor.service.spec` / `register` 幂等用例 | 无 | 先做，单独提交 |
| 2 | **SEC-R3-2** pull/poll/terminal-states 要求 `via==="per-executor"`（或共享令牌仅可取 commands） | 直接堵住「明文 secrets 收割 + 队列耗尽」，是数据面最重的一刀 | 中：旧执行器（仅共享令牌）在 pull 面会 403 → 需一回退开关 `EXECUTOR_ALLOW_SHARED_TOKEN_READ_FACES`（默认 false）+ 升级说明 | 1 的同一文件 | 与 1 同批设计、分两次提交 |
| 3 | **SEC-R3-3** `/executions/:id/logs` 移除共享令牌兜底 | 止损日志伪造（取证可信度） | 低：执行器早已用 per-execution 令牌；旧版本回退到终态回调带 logs | 无 | 一行判定 + 两条 spec |
| 4 | **SEC-R3-4** 入站 webhook 幂等/去重键 | 把「抓一次包 → 重复执行/重复告警」关掉；顺带修掉「网络重试即重复触发」的可用性缺陷 | 低-中：需要 Redis 键或一列唯一索引 + 迁移；对「同一签名重复投递」的语义要写进 api-reference | 迁移编号需串行 | 幂等键优先（Redis SETNX），DB 列作为下一轮 |
| 5 | **SEC-R3-6** `--require-hashes` + 镜像 digest + `tenacity` 钉死 | 构建期供应链完整性，成本最低的一档 | 低：`uv` 已在仓内，`pip-compile --generate-hashes` 产出锁文件；compose 改 digest 需同步 `check-compose-sandbox` 基线 | 无 | 独立提交，跟一个守卫脚本 |
| 6 | **SEC-R3-7** 安装命令去令牌（bootstrap token） | 收掉「集群凭据进 argv/历史」的残余面 | 中：新增端点 + 一次性兑换逻辑 + 契约变更 | 建议在 1/2 之后（那时共享令牌的价值已下降） | 独立 feature 级提交 |
| 7 | **SEC-R3-5** 落证移到判定之后 + `principalId===undefined` 显式化 | 提升强制点对未来漏传的免疫力（R-02 同族） | 低-中：触碰 6 处落证与 44 条 declared-owner 路由的证据断言，需整模块 jest | 无 | 最后做，配合「反证用例」一起提交 |

**排序理由**：1→2 是同一条根因（共享令牌等价于 per-executor），且 1 不需要任何兼容开关就能落地，先把「凭据外发」关掉；3 是同一凭据面的第三个入口，改动最小；4/5 与凭据链正交、可并行；6 依赖 1/2 先降权；7 是防线自身的健壮性，收益随前六项下降而上升（避免把「守卫绿」当结论）。
