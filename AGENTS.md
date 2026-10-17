# AGENTS.md — AutoCodeFlow 协作规则

本仓库是 monorepo（`apps/*` 控制面与执行器、`packages/*` 共享 SDK、`interpreters/*` Python 环境），已用 **CodeGraph** 建立代码知识图谱索引（`.codegraph/`，根目录）。所有在本仓库工作的 agent（主会话、子 agent、任何 CLI 编码工具）都必须遵守以下规则。

## 1. 探查代码：CodeGraph 优先（硬规则）

在需要**理解、定位、追踪或修改**任何代码之前，禁止先 grep / find / 逐个 Read 文件。先查 CodeGraph，按以下优先级：

1. **MCP 工具（首选）**：`codegraph_explore`
   - 一次调用即可拿到相关符号的逐字源码 + 调用路径（含 grep 跟不到的动态分发）。
   - 若工具存在但处于 deferred 状态，先用工具搜索按名字 `codegraph` 找到它，再加载调用，不要因为没在默认工具列表里就跳过。
   - `projectPath` 固定传 `E:\softwareData\coding\AutoCodeFlow`（或其下任意子目录，会自动向上找到最近的 `.codegraph/`）。
   - 它返回的源码视为已 Read，不要重复打开同一文件。
2. **CLI 兜底（MCP 不可用时，始终可用）**：在仓库根目录执行
   - `codegraph explore "<符号名/文件名/自然语言问题>"` — 与 MCP 同输出
   - `codegraph node <符号>` — 单符号源码 + caller/callee 链
   - `codegraph callers <符号>` / `codegraph callees <符号>` — 调用关系
   - `codegraph impact <符号>` — 修改影响面
   - `codegraph affected <改动的文件...>` — 受影响的测试
3. 只有 CodeGraph 无法覆盖时（非代码文件、配置、全文检索）才用 Grep / Read。

## 2. 保持索引新鲜

- 大规模改动、删文件或切换分支后，执行 `codegraph sync`（增量）；索引损坏时用 `codegraph index` 全量重建。
- 开工前若怀疑索引过期，先 `codegraph status` 确认 `Index is up to date`。
- `.codegraph/` 是本机索引，**不要提交**（已被 `.codegraph/.gitignore` 忽略）。

## 3. 子 agent 派发要求

- 主 agent 派发涉及代码的子任务时，必须在任务指令中显式写明「先用 CodeGraph MCP 探查；MCP 不可用则用 `codegraph` CLI」，并给出 `projectPath`，不得假设子 agent 会自动发现本文件。
- 子 agent 同样遵守第 1 条的工具优先级。

## 4. 其他 agent 工具链

- Claude Code：规则已在全局 `~/.claude/CLAUDE.md`（CodeGraph 安装时写入）；MCP server 为 `codegraph serve --mcp`，全局注册。
- 其他编码 CLI（Codex / Cursor / Gemini CLI 等）：如未配置 MCP，执行 `codegraph install -y` 自动注册，CLI 本身已在 PATH 中。
