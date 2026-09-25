# ADR-022: 执行器 Agent 与「受控的任意代码执行」信任模型变更

- 状态：Accepted（agent-and-deployment P7a；`standard` 为默认档的最终确认见 §6）
- 日期：2026-09
- 关联：设计文档 docs/design/agent-and-deployment/07-executor-agent.md、08-executor-agent-scope.md、09-permission-profiles.md、ADR-020（边界模型）、ADR-021（SOP 契约）

## 背景

执行器 Agent 的核心循环是「观察环境 → 决定方案 → **写代码 → 执行 → 看结果 → 改代码** → 回到执行」。这与平台既有安全模型的核心假设正面冲突：

| 既有假设（SEC-01 / env-whitelist / shell 校验 / zip 校验） | Agent 需要 |
|---|---|
| 代码是预先审查过的打包产物 | **运行时生成**，无人预先看过 |
| entrypoint 由 admin 派发载荷决定（包内 manifest 不可信） | Agent 既写包又定入口 |
| 依赖在上传时声明 | 运行时决定并安装 |

这不是"加固一下就行"，而是**把「执行器上可以跑运行时生成的代码」变成合法状态**——与平台反复加固的方向相反。因此必须 ADR 显式决策，不能以实现既成事实的方式悄悄发生。

## 决策

1. **信任模型变更成立，但 Agent 的"自由"被限制在生成阶段**：生成的代码**不直接在主机上长期运行**，而是打包为候选应用走既有 `executor-package`（zip bomb/病毒检查）→ `deploy.ts`（shell/路径校验）→ env 白名单边界内运行。既有校验链一字不动。
2. **试跑（迭代验证）是唯一新增的执行能力，且必须沙箱化**：默认 `process` 后端（受限子进程：env 白名单 + cwd 锁定 agent-workspace + 路径域校验 + 超时与输出上限）。
3. **能力档位化 + 默认最保守**（09）：`codeExecution`（off/sandbox/host）、`sandboxBackend`（none/process/container/vm）、`hostAccess`（none/app-scoped/session）、`taskExecution`（deploy-only/isolated-runner）四个轴，预设五档；**P7a 只实现 `minimal` + `standard` 两档**（off/sandbox + process + deploy-only）。
4. **企业集中管控**：`最终档位 = min(客户端本地配置, 中台下发的上限)`（经 poll 通道随 `sopPolicy` 下发）；离线沿用最近一次策略缓存，**不回落成无限制**。
5. **来源标记由平台代码打，不由 Agent 自称**：Agent 生成的候选应用走显式路径（P7e 的 isolated-runner），绝不在已加固的 `/execute` 上开"trusted 来源"分支——**不提供 `shared-runner` 档**（把已知破坏安全属性的选项做成配置项 = 给企业一个自伤按钮）。
6. **分工（08 定案）**：Agent 只内置进 executor-desktop；executor-node/python 保持纯净，零行为变化。Agent 是 desktop 托管的**独立子进程**，爆炸半径与任务执行主链隔离。
7. **硬闸门常置**（07 §7.1）：单次迭代 ≤15 轮、会话墙钟 ≤2h、试跑 ≤30 次、依赖安装 ≤10 次；任一触顶终止并如实上报。
8. **诚实的固有属性声明**：若开启 `hostAccess=session`，Agent 天然拥有该用户的全部权限——这不是设计缺陷，是需求属性。可做的是档位化 + 白名单 + 全程留痕 + 关键动作审批，而不是假装它被沙箱关住了。

## 后果

- 正向：声明式 SOP（目标 + 验收）+ 现场自主实现成立；既有执行器安全资产零改动。
- 代价：接受「客户端机器上存在受控的生成代码执行」这一事实；档位与闸门必须**每一档都有代价说明与审计留痕**（09 §5），运维负担上升。
- 验收（P7a）：desktop selftest（权限档位合并/沙箱路径域/试跑硬闸门/循环闸门）；P7d 端到端反向用例（SOP 植入恶意指令 → 执行器拒绝并上报）。

## 替代方案（被否）

- 直接在主机上跑生成代码（无沙箱）：爆炸半径不可接受。
- 独立 `apps/executor-agent` 包：多一个部署单元，放弃 desktop 已有的子进程托管/IPC 白名单/Playwright 依赖（08 §1.2 已否）。
- 在 `/execute` 上加 trusted 来源分支：破坏已验证的 manifest 劫持防护（08 §2），被显式拒绝。

## 关联

- 计划项：agent-and-deployment P7a–P7e
- 相关 ADR：ADR-019、ADR-020、ADR-021
