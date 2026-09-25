# 08 · 执行器 Agent 的最终分工（已确认）

> 你的决策：**python 执行器 + node 执行器只运行自动化应用，不加 agent 功能；agent 功能只加在客户端执行器（executor-desktop）上。且客户端 Agent 不只「造」，也能直接执行任务。**
>
> 本文确认这个分工，并指出它在安全模型上碰到的一个**具体冲突**——需要你知情后再决定怎么处理。

## 1. 分工确认

```
┌──────────────────────────────────────────────────────────────┐
│ 中台（admin-api）                                             │
│  · modules/agent —— 中台 Agent（运维 + SOP 编排 + 代码生成）  │
└──────────────────────────────────────────────────────────────┘
        │ SOP 指派                     │ 任务派发（既有链路）
        ▼                              ▼
┌───────────────────────┐   ┌──────────────────────────────────┐
│ ★ 客户端执行器         │   │ executor-node / executor-python  │
│  executor-desktop      │   │                                  │
│                        │   │  ★ 保持纯净：只跑自动化应用       │
│  · 内置 Agent          │   │  · 不加任何 agent 功能            │
│  · 探测本机环境        │   │  · 既有安全边界原样保留          │
│  · 写代码 / 试错       │   │  · 行为零变化                    │
│  · 打包候选应用        │   │                                  │
│  · ★ 也能直接执行任务  │───┤  （两者同机部署，共享 WORK_DIR）  │
└───────────────────────┘   └──────────────────────────────────┘
```

### 1.1 这个分工的三个好处（我认同你的判断）

| 好处 | 说明 |
|---|---|
| **保住既有安全边界** | `executor-node` / `executor-python` 是你已经用 SEC-01/env-whitelist/shell 校验加固过的资产。**不动它们 = 不重新论证它们的安全性**。这是很务实的判断。 |
| **爆炸半径最小** | Agent 是新的、行为不可完全预测的组件。放在客户端意味着：它失控时，**服务端执行器集群不受影响**。 |
| **符合「谁需要谁装」** | 只有需要「AI 造应用」的机器才装带 Agent 的桌面端。服务器集群不需要。 |

### 1.2 我原设计的问题（你纠正得对）

我在 [07](./07-executor-agent.md) 里提议新增独立的 `apps/executor-agent`，由 desktop 托管。你这版更好：

- 少一个部署单元
- 复用 desktop 已有的**子进程托管能力**（`executor-process.ts` 已经会 spawn/监控/重启 `executor-node`，Agent 可以走同一套模式）
- 复用 desktop 已有的 **IPC 白名单 + 路径域校验**（`ipc-and-security.md` 里那套）
- 用户能在托盘看到 Agent 状态（透明性）

**采纳你的方案。** 我把 [07 §4.2](./07-executor-agent.md) 的建议改为「内置进 desktop」。

## 2. ⚠️ 一个必须你知情的冲突

你说「Agent 也能直接执行任务」。这个范围放大触碰到了一条**你项目里刻意加固过的安全属性**，我必须指出来。

### 2.1 既有防御：manifest 劫持防护

`apps/executor-node/src/routes/execute.ts` 第 1355-1372 行有一段**位置纪律**注释，写得非常明确：

```
位置纪律：**git clone 之后、zip 解压之前**。
  · 放在 zip 解压**之前** —— 此刻 workDir 还是空的，于是 zip 渠道读不到
    任何 manifest，包内自带的 manifest.yaml 无法把"包内数据"提权成
    "任务配置"（劫持 entrypoint / runtime / requirements / timeout）。
```

同文件 1392-1397 行再次强调：

```
包内自带的 manifest.yaml 因此永远不会被合并——否则它就能劫持
entrypoint/runtime/requirements（把"包内数据"提权成"任务配置"），
那是 zip 渠道独有的攻击面（P0-3，与 executor-python 同序）。
```

并且有专门的回归测试守卫它（`execute.python-multiversion.spec.ts` 第 723 行「a package-supplied manifest.yaml cannot hijack the entrypoint」）。

**这条防御的语义是：上传的代码包**不能**通过包内 manifest 决定自己怎么被执行。**

### 2.2 冲突在哪

客户端 Agent 的工作方式是：

```
Agent 生成代码 → 打包 → ★ 自己决定 entrypoint → 执行
```

**Agent 生成的包，天然「自带 manifest」**——而 Agent 既是包的作者，又是执行的决定者。这与上面那条防御的**信任前提**正好相反：

| 场景 | 包内 manifest 的角色 | 信任状态 |
|---|---|---|
| 正常任务 | ⚠️ 不可信（上传者可能塞恶意 manifest） | admin 派发载荷才是权威 |
| Agent 生成的包 | 它就是权威（Agent 自己写的入口） | 作者 = 执行者 |

### 2.3 我的判断：这不是漏洞，但必须显式处理

**不要悄悄绕过那条防御。** 那条注释是有人踩过坑之后写的，绕过它会破坏一个已验证的安全属性。

正确的做法是**让来源可区分**：

```
Agent 生成的候选应用 → 走一条独立的、显式的执行路径
                     → 在代码里明确标注 "trusted: agent-generated"
                     → 仍然走 env-whitelist / 路径校验 / 沙箱
                     → 但允许其 manifest 决定 entrypoint
```

关键是**来源标记必须由平台代码打**，不能由 Agent 自己声明（否则就是"上传者自己说我是可信的"，防御直接归零）。

### 2.4 处理方式：已定案 → 配置档 `taskExecution`

**（原 A/B/C 三选一已按「企业场景 + 可选权限选项」定案，详见 [09 §2.4](./09-permission-profiles.md)）**

| 档位 | 做法 | 是否提供 |
|---|---|---|
| **`deploy-only`**（默认） | Agent 只产出候选应用包，交给既有 `deploy.ts` 通道跑 | ✅ 零冲突 |
| **`isolated-runner`** | 新增**独立执行端点**，与 `/execute` 分开，各自安全论证独立 | ✅ 满足「Agent 能直接执行」 |
| ~~复用 `/execute` 加来源分支~~ | 在已加固的路径上开分支，风险耦合 | ❌ **故意不提供** |

**关键判断**：企业场景需要「可配置」，但不是「什么都能配」。把已知会破坏安全属性的选项做成配置项，等于给企业一个自伤的按钮。**安全的可配置性 = 只在安全选项之间选择。**

来源标记必须**由平台代码打**，不能让 Agent 自己声明——否则就是「上传者自称可信」，manifest 劫持防护直接归零。

## 3. 更新后的架构

### 3.1 executor-desktop 的新结构

```
apps/executor-desktop/src/main/
├── index.ts                    ← 加 Agent 生命周期管理
├── executor-process.ts         ← 不变（继续托管 executor-node 子进程）
├── ★ agent-process.ts          ← 新增：托管 Agent 子进程（复用同一套模式）
├── ★ agent/                    ← 新增：Agent 逻辑
│   ├── runtime.ts              推理循环（感知→规划→试跑→诊断）
│   ├── perception.ts           环境探测（本机有什么、目标系统什么形态）
│   ├── workspace.ts            沙箱化工作区（限定目录）
│   ├── boundary.ts             工具封闭枚举 + 路径/域名白名单
│   ├── codegen.ts              代码生成
│   ├── trial-run.ts            试跑（沙箱内）
│   └── reporter.ts             回报中台 / 发起澄清
├── ipc-handlers.ts             ← 加 Agent 相关的只读视图通道
└── config-store.ts             ← 加 Agent 配置（启用开关 / 中台地址 / 预算）
```

### 3.2 关键设计：Agent 与 executor-node 同机协作

```
用户电脑
├── executor-desktop（Electron 壳）
│   ├── 托管 executor-node 子进程   ← 既有，不变
│   │     └── 跑任务 / 跑部署的应用
│   └── 托管 Agent 子进程           ← 新增
│         ├── 探测本机环境
│         ├── 生成候选应用 → 打包
│         ├── 直接执行任务（方案 A 的独立端点）
│         └── 回报中台
└── 共享 WORK_DIR
```

**为什么 Agent 需要同机的 executor-node**：因为 Agent 生成的候选应用要「跑起来」，而 `executor-node` 已经会跑应用（`.venv` 隔离、env 白名单、daemon 重启）。**复用比新造好。**

### 3.3 待你决策项的变化

**全部 4 项已解决**——按「企业场景 + 可选权限选项」转为配置档（[09-permission-profiles.md](./09-permission-profiles.md)）：

| # | 决策 | 状态 |
|---|---|---|
| 1 | 是否接受「执行器上开启任意代码执行」 | ✅ 配置档 `codeExecution`（默认 `sandbox`） |
| 2 | 沙箱强度 L1 / L2 / L3 | ✅ 配置档 `sandboxBackend`（默认 `process`） |
| 3 | Agent 可否操作本机已登录软件 | ✅ 配置档 `hostAccess`（默认 `none`） |
| 4 | ~~交付形态~~ | ✅ **已定：内置 executor-desktop** |
| 5 | Agent 直接执行任务方式 | ✅ 配置档 `taskExecution`（默认 `deploy-only`） |

**唯一请你确认**：默认预设 `standard` 是否符合预期——它意味着开箱即用时 Agent 能自己试跑验证，但**不能操作你已登录的系统**（需显式升到 `ops-assist` 档）。

## 4. 对路线图的影响

P7 需要调整（[06 §9](./06-roadmap.md)）：

| 原 | 新 |
|---|---|
| P7a 骨架（独立 agent 进程） | P7a 骨架（**desktop 内置**，desktop 托管 Agent 子进程） |
| P7b 浏览器能力 | 不变（desktop 已有 Playwright 依赖，**更顺了**） |
| P7c 桌面 GUI 能力 | 不变 |
| P7d 端到端 | 不变 |
| — | **P7e 新增**：Agent 直接执行任务（方案 A 的独立执行路径 + 信任来源标记） |

**注意**：P7b 现在明显更容易了——desktop 本来就是 Electron，Chromium 内嵌，`@playwright/test` 已在 `devDependencies`。

## 5. 我的建议

1. **采纳你的分工**（已写入本文）——它确实比我原方案好。
2. **§2 的冲突请选方案 A**——独立执行端点，不污染既有加固路径。
3. **§3.3 剩余 4 项决策**建议一起过一遍，因为它们是 P7a 开工的前提。

如果你想先看到进展而不是继续决策，我建议**先开工 P0 部署脚本**（与 Agent 完全无关，独立可用），同时你慢慢考虑这 4 项。
