# AGENTS.md — AutoCodeFlow 协作规则

本仓库是 monorepo（`apps/*` 控制面与执行器、`packages/*` 共享 SDK），已用 **CodeGraph 1.6.x** 建立代码知识图谱索引（`.codegraph/`，根目录）。所有在本仓库工作的 agent（主会话、子 agent、任何 CLI 编码工具）都必须遵守以下规则。

## 1. 探查代码：CodeGraph 优先（硬规则）

在需要**理解、定位、追踪或修改**任何代码之前，禁止先 grep / find / 逐个 Read 文件。先查 CodeGraph，按以下优先级：

1. **MCP 工具（首选）**：`codegraph_explore`
   - 一次调用即可拿到相关符号的逐字源码 + 调用路径（含 grep 跟不到的动态分发）。
   - 1.6.x 默认**只向客户端暴露 `codegraph_explore` 一个工具**：`codegraph_node/search/callers/callees/impact/files/status` 仍然可用，但默认不列在工具表里（它们返回的内容已并入 explore）。确实需要单独工具时，用 `CODEGRAPH_MCP_TOOLS=explore,node,callers` 之类的环境变量按需放开，或直接用下面的 CLI 等价命令。
   - 若工具存在但处于 deferred 状态，先用工具搜索按名字 `codegraph` 找到它，再加载调用，不要因为没在默认工具列表里就跳过。
   - `projectPath` 传本仓库根目录的绝对路径（Linux 本机 `/home/yongsheng/project/AutoCodeFlow`，Windows 侧 `E:\softwareData\coding\AutoCodeFlow`），或其下任意子目录，会自动向上找到最近的 `.codegraph/`。
   - 它返回的源码视为已 Read，不要重复打开同一文件。
2. **CLI 兜底（MCP 不可用时，始终可用）**：在仓库根目录执行
   - `codegraph explore "<符号名/文件名/自然语言问题>"` — 与 MCP 同输出，**默认第一选择**
   - `codegraph node <符号>` — 单符号源码 + caller/callee 链；`codegraph node <文件> --symbols-only` 看文件符号表，`--offset/--limit` 按行号读文件
   - `codegraph query <关键字>` — 只定位符号（比 explore 便宜，适合确认拼写/路径）
   - `codegraph callers <符号>` / `codegraph callees <符号>` — 调用关系
   - `codegraph impact <符号>` — 修改影响面（`-d` 调遍历深度，默认 2）
   - `codegraph affected <改动的文件...>`，或 `git diff --name-only | codegraph affected --stdin` — 受影响的测试
   - 需要机器可读结果时统一加 `-j`（JSON）
3. 只有 CodeGraph 无法覆盖时（非代码文件、配置、全文检索）才用 Grep / Read。

## 2. 保持索引新鲜

- 1.6.x 带后台 watcher，文件落盘后约 2 秒自动增量同步，`codegraph status` 会列出 pending 文件。**不要再例行 `codegraph sync`**。
- 只在 watcher 不生效时手动同步：`CODEGRAPH_NO_DAEMON=1`、沙箱/只读文件系统、或 CI 脚本里需要前置同步。
  - `codegraph sync` — 增量；`codegraph index` — 全量重建（换 CLI 版本后若提示「built by an earlier version」就跑一次）。
- 开工前若怀疑索引过期，先 `codegraph status` 确认 `Index is up to date`；索引被锁住时用 `codegraph unlock`。
- 升级 CLI：`codegraph upgrade`（`--check` 只检查不安装）。升级后重启 MCP 客户端，否则仍在跑旧版服务。
- `.codegraph/` 是本机索引，**不要提交**（已被 `.codegraph/.gitignore` 忽略）。

## 3. 子 agent 派发要求

- 主 agent 派发涉及代码的子任务时，必须在任务指令中显式写明「先用 CodeGraph MCP 探查；MCP 不可用则用 `codegraph explore` CLI」，并给出 `projectPath`，不得假设子 agent 会自动发现本文件。
- 子 agent 同样遵守第 1 条的工具优先级。

## 4. 编排：主 agent 负责切分、串联与收口

这一条约束的是**怎么把活干完**，不是产品代码。适用于任何需要连续推进的开发、审计、验收任务；一次性小改动不必强行套用。

### 4.1 主 agent 不做「一个人干到底」

- **主 agent 承担**：目标拆解、写任务书、派发、跨 agent 传递信息、集成、最终验收与对外汇报。**亲自写代码是例外**，只用于串行强依赖、极小改动（如一行接线）或修复并行产出的集成问题。
- **上下文纪律**：主 agent 的上下文留给决策与证据，不拿去读大文件、不反复扫全量测试输出。大段实现与探查交给子 agent，子 agent 只回结论、改动点、验证命令与结果。
- **一个 slice 一个子 agent**：按**用户可验收的路径**切分（例如「提问 → 结果」「审批单定位」「队列去重」），不要按目录或按文件切，也不要让一个子 agent 从探查一路做到全量回归。
- **切片粒度**：一个子 agent 应能在一次返回里说清「做了什么、改了哪些文件、怎么验证、边界是什么」。做不到就是切大了。

### 4.2 子 agent 之间要能沟通

- 派发时给出**精确的文件边界**（拥有哪些文件、不得触碰哪些），写进任务书。
- 涉及跨切片契约的，**允许并把接口写清**：谁提供工具函数、谁消费、签名是什么、失败语义是什么。
- 子 agent 之间需要对齐时，用 `send_message` 直接传话；由主 agent 裁决冲突，不要让两个 agent 各自实现同一份契约。
- 同一 workspace 里并行改动会互相踩。任务书必须写明「只改你负责的文件」；主 agent 负责在集成时审阅最终 diff，不得以「各切片都自测通过」代替集成验证。

### 4.3 主 agent 也要和每个子 agent 对话

- **派发前**：用 CodeGraph 自行确认关键符号与边界，再写任务书；不把「去查一下」这种空任务丢给子 agent。
- **运行中**：主动接收子 agent 的中间反馈（发现的矛盾、跨切片契约、外部前提变化），据此调整其它子 agent 的任务书。
- **收口时**：逐个收集结果，区分**已实测**与「只读静态分析」「内存替身」「未覆盖」，再决定是否还需要验证。
- **发现子 agent 的结论与事实冲突**：先复核事实（源码/运行结果），再改任务书，不采信「自述通过」。

### 4.4 验收分级，不许越级上报

| 级别 | 含义 | 能证明什么 |
|---|---|---|
| 静态探查 | 只读源码/索引 | 只证明「代码看起来是这样」 |
| 单测/内存替身 | 假仓储、假队列、假模型 | 只证明该分支逻辑成立 |
| 真实进程内集成 | 真 PG/Redis + 真 Nest + 假传输层 | 证明持久化、约束、队列行为 |
| 浏览器/真机 | 真实构建产物 + 真实浏览器 | 证明用户路径可达 |

- 对外汇报时**注明最高一级**，不得用低一级结果代替高一级结论。
- 「接口返回成功」不是验收结论：**断言实际副作用**（新建了哪些行、步骤序号、队列 job 状态）。
- 低级别验证发现的高置信度缺陷，必须升到能复现它的最高级别再修。

### 4.5 流水线而不是串行长链

```text
举例3个子agent,实际可按情况启用具体数量的agent
主 agent：定位目标 → 切分 → 写任务书（文件边界/契约/验收级别）
   ├─ 子 agent A（切片 1）──┐
   ├─ 子 agent B（切片 2）──┼─ 运行中互相 send_message 对齐契约
   └─ 子 agent C（验收）────┘
主 agent：集成 diff → 定级验收 → 补齐缺口 → 汇报（注明覆盖边界）
```

- 独立切片**并行**派发；有依赖的切片等前置结果，不盲目排队。
- 验收类任务（真实环境、浏览器）可以和实现并行启动，提前暴露环境问题。
- 每轮结束前更新 `docs/AGENT_HANDOFF.md` 的「本次交接」段：可用路径、验收口径、发布前置、明确的后续项。

## 5. 其他 agent 工具链

- Claude Code：MCP 已在 `~/.claude.json` 注册（`codegraph serve --mcp`，带 `alwaysLoad: true`，否则工具会被 deferred 到工具搜索之后）。
- Hermes Agent：MCP 在 `~/.hermes/config.yaml` 的 `mcp_servers.codegraph`，`command` 用绝对路径 `/home/yongsheng/.local/bin/codegraph`，避免 PATH 命中 `/www/server/nodejs/*/bin` 下的旧版。
- 其他编码 CLI（Codex / Cursor / Gemini CLI / opencode / Kiro / Copilot 等）：如未配置 MCP，执行 `codegraph install -y` 自动注册；只想看配置片段用 `codegraph install --print-config <id>`。注意 `install` 会往 agent 指令文件里写一段 `<!-- CODEGRAPH_START -->` 标记块，本文件已自带等价规则，重复写入只会冗余。
