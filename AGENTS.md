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

## 4. 其他 agent 工具链

- Claude Code：MCP 已在 `~/.claude.json` 注册（`codegraph serve --mcp`，带 `alwaysLoad: true`，否则工具会被 deferred 到工具搜索之后）。
- Hermes Agent：MCP 在 `~/.hermes/config.yaml` 的 `mcp_servers.codegraph`，`command` 用绝对路径 `/home/yongsheng/.local/bin/codegraph`，避免 PATH 命中 `/www/server/nodejs/*/bin` 下的旧版。
- 其他编码 CLI（Codex / Cursor / Gemini CLI / opencode / Kiro / Copilot 等）：如未配置 MCP，执行 `codegraph install -y` 自动注册；只想看配置片段用 `codegraph install --print-config <id>`。注意 `install` 会往 agent 指令文件里写一段 `<!-- CODEGRAPH_START -->` 标记块，本文件已自带等价规则，重复写入只会冗余。
