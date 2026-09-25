# 09 · 企业场景下的权限与授权模型（可配置权限档）

> 你的指示：**基于企业场景考虑，或者提供可选的权限选项。**
>
> 本文把这四个待决策项从「一个是/否」变成「一组可配档位」——因为企业环境差异极大（个人办公机 vs 受控券商终端 vs 内网跳板机），**一个硬编码答案必然有一半人不能用**。

## 1. 设计原则：能力档位化 + 默认最保守 + 可审计的显式升级

```
核心思想：不要问「允不允许」，要问「允许到哪一档」
         —— 每一档都有明确的代价说明，选择权交给部署方
```

三条原则：

| 原则 | 说明 |
|---|---|
| **默认最保守** | 开箱即用的档位是「什么都不能做」。要用高级能力，必须**显式**开启。 |
| **档位有代价说明** | 每个档位必须写清「你会失去什么保护」，而不是只写「更强大」。企业 IT 才能做判断。 |
| **升级留痕** | 从低档升到高档，是一次**配置变更事件**——记审计、可追溯是谁在什么时候放开的。 |

**这与项目既有姿态一致**：`EXECUTOR_REQUIRE_ENCRYPTED_TOKEN`、`AI_ALLOW_PRIVATE_NETWORK`、`EXECUTOR_ALLOW_PRIVATE_NETWORK` 都是「默认关闭、显式开启」的部署级开关。本设计沿用同一模式。

## 2. 四个待决策项 → 能力档位

### 2.1 项 1 · 任意代码执行 → `codeExecution` 档位

| 档位 | 行为 | 适合的企业场景 | 代价（必须明示） |
|---|---|---|---|
| **`off`** | Agent 不能执行任何生成的代码，只能产出代码文本供人审阅 | 高合规环境（金融、医疗）；SOP 仅作建议 | Agent 无法自验证，SOP 交付变成「给人看」 |
| **`sandbox`**（默认） | 生成的代码只能在受限 workspace 内试跑：无网络、仅限工作目录、无系统命令、有超时与资源上限 | **绝大多数企业**——能自验证，且爆炸半径可控 | 部分场景跑不通（需要真实网络的、需要访问内网系统的） |
| **`host`** | 生成的代码可在本机正常运行（仍受白名单与超时约束） | 需要操作内网系统 / 已登录软件的场景 | **等于在该主机上开启任意代码执行**（[07 §3](./07-executor-agent.md)） |

**配置：**
```
EXECUTOR_AGENT_CODE_EXECUTION=off|sandbox|host   # 默认 sandbox
```

> ⚠️ **重要**：`sandbox` 档在「需要访问内网系统」的场景**天然跑不通**——这正是矛盾所在。企业要么选 `host` 并接受风险，要么选 `sandbox` 并接受功能受限。**没有两全的选项，这个 trade-off 必须由部署方知情决定。**

### 2.2 项 2 · 沙箱强度 → `sandboxBackend` 档位

| 档位 | 实现 | 强度 | 前提 | 适合场景 |
|---|---|---|---|---|
| **`none`** | 仅靠进程隔离 + 白名单 | 弱 | 无 | 仅用于 `codeExecution=off` 时占位 |
| **`process`**（默认） | 受限子进程：env 白名单（复用 SEC-01）+ cwd 锁定 + 路径域校验（复用 `path-domain.ts`）+ 资源上限 | 低 | 无 | 防误操作，防不住恶意代码 |
| **`container`** | `docker run --network=none --read-only --memory=--cpus=` 等 | 中 | 本机有 Docker | 有 Docker 的企业开发机 |
| **`vm`** | Windows Sandbox / Firecracker / gVisor | 高 | 平台特定支持 | 高安全要求 + 有运维能力 |

**配置：**
```
EXECUTOR_AGENT_SANDBOX_BACKEND=none|process|container|vm   # 默认 process
```

**企业落地建议**：

| 企业类型 | 建议组合 |
|---|---|
| 普通企业办公机 | `codeExecution=sandbox` + `sandboxBackend=process`（默认，够用） |
| 有 Docker 的开发机 | `codeExecution=sandbox` + `sandboxBackend=container`（更稳） |
| 需要操作内网系统的业务机 | `codeExecution=host` + `sandboxBackend=process`（**接受风险，靠审批与留痕兜底**） |
| 金融/医疗高合规 | `codeExecution=off`（Agent 只产出代码，人工审阅后手动部署） |

### 2.3 项 3 · 操作本机已登录软件 → `hostAccess` 档位

这一项**最敏感**，因为它直接决定 Agent 是否拥有用户身份。

| 档位 | 能力 | 说明 |
|---|---|---|
| **`none`**（默认） | 只能做无状态操作（HTTP 调用、纯计算） | 不需要任何本机登录态 |
| **`app-scoped`** | 只能操作**被显式授权**的应用/域名清单 | ✅ **推荐的企业档**——最小权限，可控 |
| **`session`** | 可使用当前用户的登录态操作任意本机软件 | ⚠️ **Agent 拥有该用户全部权限** |

**配置：**
```
EXECUTOR_AGENT_HOST_ACCESS=none|app-scoped|session   # 默认 none
EXECUTOR_AGENT_ALLOWED_APPS=chrome,excel             # app-scoped 时的白名单
EXECUTOR_AGENT_ALLOWED_DOMAINS=erp.corp.com,crm.corp.com
```

> ⚠️ **必须向企业 IT 明示的诚实结论**：选 `session` 就等于把这个员工的账号权限交给 Agent 使用。对企业的实际含义是——**Agent 能做的事，这个人也能做；出问题时，审计日志里两者难以区分**（这也是 [03 §7](./03-agent-tools-and-boundary.md) 建议 Agent 用独立身份的原因之一）。
>
> **`app-scoped` 是推荐档**：企业通常能列出「这个自动化任务只该碰 ERP 和 CRM」，白名单化后风险大幅收敛。

### 2.4 项 4 · 直接执行任务 → `taskExecution` 档位

| 档位 | 行为 | 安全分析 |
|---|---|---|
| **`deploy-only`**（默认） | Agent 只产出候选应用包，交给 executor-node 的既有部署通道跑 | ✅ 零冲突（[08 §5 方案 C](./08-executor-agent-scope.md)） |
| **`isolated-runner`** | Agent 用**独立执行端点**直接跑任务（不经过 `/execute`） | ✅ 满足「直接执行」，且不污染既有 manifest 劫持防护（[08 §2.4 方案 A](./08-executor-agent-scope.md)） |
| **`shared-runner`** | Agent 复用既有 `/execute` 端点 | ❌ **不提供此档**——会破坏已验证的安全属性 |

**配置：**
```
EXECUTOR_AGENT_TASK_EXECUTION=deploy-only|isolated-runner   # 默认 deploy-only
```

> **注意**：这里我**故意不提供 `shared-runner` 档**。企业场景需要的是「可配置」，不是「什么都能配」——把已知会破坏安全属性的选项做成配置项，等于给企业一个自伤的按钮。**安全的可配置性 = 只在安全选项之间选择。**

## 3. 权限档位的组合矩阵

企业实际要选的是一个**组合**。给出推荐预设：

| 预设名 | codeExecution | sandboxBackend | hostAccess | taskExecution | 适用 |
|---|---|---|---|---|---|
| **`minimal`**（默认） | `off` | `none` | `none` | `deploy-only` | 高合规；Agent 仅辅助 |
| **`standard`** | `sandbox` | `process` | `none` | `deploy-only` | 普通企业；能自验证 |
| **`developer`** | `sandbox` | `container` | `app-scoped` | `isolated-runner` | 有 Docker 的开发机 |
| **`ops-assist`** | `host` | `process` | `app-scoped` | `isolated-runner` | ★ 需要操作内网系统的业务机 |
| **`full-trust`** | `host` | `process` | `session` | `isolated-runner` | ⚠️ 单体可信环境；**需企业书面确认** |

**配置方式**：
```
EXECUTOR_AGENT_PERMISSION_PROFILE=standard    # 选预设
# 或用细粒度覆盖（优先级高于 preset）
EXECUTOR_AGENT_HOST_ACCESS=app-scoped
EXECUTOR_AGENT_ALLOWED_DOMAINS=erp.corp.com
```

**`full-trust` 预设的特殊处理**：选它时，Desktop 首次启动必须**弹出一个明确的确认界面**，逐条列出会失去的保护，要求用户勾选确认。这不是形式主义——**这是让"知情同意"真实发生的地方**。同时写入审计。

## 4. 与既有配置体系的对齐

### 4.1 配置存放位置（遵循既有模式）

客户端 Agent 的配置应放在 **`config-store.ts`**，遵循 [该文件既有纪律](../atlas/01-apps/executor-desktop/)：

| 纪律 | 本设计如何遵守 |
|---|---|
| 新字段**全部可选**，`defaults` 补默认值 | `agentEnabled?: boolean` 等，旧配置文件升级后行为不变（兼容红线） |
| 渲染层可能送错的形状在 **`config-sanitize.ts`** 消毒 | 新增枚举字段的合法值校验（拒绝未知档位，回落默认） |
| 敏感值**掩码**返回（`getAllMasked`） | Agent 配置本身不敏感，但 `adminApiUrl`/token 已有掩码纪律，需一并走 |
| IPC 通道**入参白名单** + 路径域校验 | Agent 相关 IPC 走同一套 `path-domain.ts` |

> ⚠️ **一个必须注意的兼容点**：`config-sanitize.ts` 的注释明确说「conf 15 起 JSON schema 校验被移除，坏值现在**静默落盘**，消毒层因此从『改善报错』升级为『唯一防线』」。所以**新增的枚举档位字段必须加进消毒层**——否则一个拼错的档位名（如 `sandbox` 写成 `sandox`）会静默落盘，然后行为回落到某处未定义状态。这是真实的踩坑风险。

### 4.2 服务端侧（中台）的对应配置

企业 IT 通常需要**集中管控**而不是逐台配。因此中台侧应有：

| 中台配置 | 作用 |
|---|---|
| `agent.permissionPolicy` | 中台下发的**权限上限**——客户端不得超出 |
| `agent.allowedProfiles` | 允许客户端选择的预设白名单 |

**关键设计**：**客户端档位不能超过中台上限**。

```
最终生效档位 = min(客户端本地配置, 中台下发的上限)
```

这解决了企业管控的核心诉求：**IT 能保证即使员工在自己机器上改了配置，也不会突破公司策略**（客户端会定期从心跳/pull 通道同步策略）。

> 这是企业级设计的关键一笔——**没有这一条，"可配置"在企业里等于"不可管控"**。

## 5. 审计与可观测

每个权限档位的使用都要留痕：

| 事件 | 记录 |
|---|---|
| 首次启用高级档位 | 审计：谁、何时、选了哪档、确认页勾选项 |
| 单次代码执行 | `agent_tool_calls`：代码哈希、档位、耗时、退出码 |
| 单次 host 访问 | 目标域名/应用、档位、是否命中白名单 |
| 权限被中台策略下调 | 审计 + 托盘通知用户 |
| 越档尝试 | **安全信号**，计入 `autoflow_agent_denied_total` 并告警 |

## 6. 分阶段实现建议

不必一次做完所有档位：

| 阶段 | 实现 |
|---|---|
| P7a | 只实现 `minimal` + `standard` 两档（`off`/`sandbox` + `process` + `deploy-only`） |
| P7b | 加 `container` 沙箱后端 |
| P7c | 加 `hostAccess=app-scoped`（白名单化） |
| P7d | 加 `isolated-runner` 直接执行 |
| 后续 | `session` / `vm` / `full-trust`（**按真实企业需求再定**） |

**建议先不实现 `session` 与 `full-trust`**——它们是风险最高、需求最不确定的两档。等有真实企业提出需求时再做，届时也更清楚要加什么护栏。

## 7. 结论：这四个决策现在由谁定

| 原决策 | 现在的形态 | 默认值 |
|---|---|---|
| 1. 是否接受任意代码执行 | `codeExecution` 三档 | `sandbox` |
| 2. 沙箱强度 | `sandboxBackend` 四档 | `process` |
| 3. 能否操作已登录软件 | `hostAccess` 三档 + 白名单 | `none` |
| 4. 直接执行任务方式 | `taskExecution` 两档 | `deploy-only` |

**所以这四个问题你已经不用回答了**——它们变成了企业部署时的配置项，并有保守的默认值。真正需要企业 IT 做的是：**从 5 个预设里选一个**（或细粒度覆盖）。

我唯一请你确认的是：**这套档位划分与默认值是否符合你的预期**，尤其是 `standard` 作为默认档（`sandbox` + `process` + `deploy-only`）——它意味着开箱即用时，Agent 能自己试跑验证，但**不能操作你已登录的系统**（需要显式升到 `ops-assist` 档）。

如果你想开箱就能用完整能力（含操作内网系统），我把默认档改成 `ops-assist` 即可——但那意味着**默认配置就带有"Agent 能操作已登录系统"的能力**，我不建议，企业安全审计通常会挑这个。

## 8. 最后：一句关于企业的提醒

企业场景里，这类能力落地最大的障碍**往往不是技术，是审批**。所以设计上我建议附带：

- **一份给 IT 的说明文档**：每个档位做什么、代价是什么、怎么审计
- **默认档位的合规友好性**：`minimal` / `standard` 档应该能通过多数企业的安全评审
- **升级路径清晰**：企业能明确知道「要支持某个业务场景，需要开到哪一档」

这三样比多加两个配置项更有价值。需要我把这份「给企业 IT 的说明」也一并起草吗？
