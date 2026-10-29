# 实施轮 #15（2026-10-28）：让「成功」不再说谎

> 本轮由三路只读审计（admin-web 数据层 / packages acf-cli+mcp-server /
> executor-python）驱动，主控逐条**回读源码复核**后才动手。四条修复的共同主题是
> **「看起来成功、实际没发生」**：总数越翻越小、心跳谎报健康、审批单缺执行时刻、
> Windows 上 prepare 阶段直接崩。

## 1. 修了什么

### 1.1 keyset 翻页的「共 N 条」越翻越小（admin-api）

`executeCountQuery` 只清 orderBy/groupBy/offset/limit/skip/take，**WHERE 原样保留**
（typeorm 1.1.2，SelectQueryBuilder.js:1856 实测）。而 `getExecutionsByKeyset`
先 `andWhere(游标)` 再 `getCount()`，`findAllByKeyset` 先 `andWhere(游标)` 再
`getManyAndCount()` —— total 因此是「剩余条数」：11 条数据、pageSize=2 时第 1 页
「共 11 条」、第 2 页「共 9 条」。原注释「不含游标下界」与实现相反。

修法：两处都改成「先 count（只有过滤条件）→ 再加游标/投影/take → 最后 getMany」，
仍保持串行（getMany 会改写 expressionMap.queryEntity）。

**为什么它能活过一轮**：两个测试桩都比生产「更正确」——
tasks 侧 mock 的注释写着「真实的 COUNT 也不含游标」并用 `getManyAndCount` 模拟
「取数套游标、计数不套」；executions 侧 mock 的 `getCount` 恒用 `cursorParams=null`。
现在两个 mock 都如实建模（getCount 用**调用时刻已加的** WHERE），缺陷谁回退谁红。

### 1.2 executor-python 心跳把「失联」报成健康

`@retry(retry_error_callback=_heartbeat_retry_exhausted)` 的回调 `return None`：
tenacity 耗尽重试后**不抛异常**，`_send_heartbeat` 正常返回 → `record_heartbeat(True)`
执行。于是 admin 不可达（ConnectError）/心跳恒 401（HTTPStatusError）时，`/health`
报 `adminApiReachable: true` 并刷新 `lastHeartbeat` —— 运维盲区。

修法：删掉 `retry_error_callback`（RetryError 自然上抛，落到既有 except →
`record_heartbeat(False)`），并把循环体抽成可测的 `_heartbeat_once()`：原实现的
测试只能把 `_send_heartbeat` 整体替换成「会抛错的假函数」，永远走不到重试耗尽分支。

同文件另修：`_prepare_rlimit_pre_exec` 的 `import resource` 写在 try **之外**
（注释还写着 "ImportError guarded below"），Windows 上第一句就 ModuleNotFoundError
→ `except ImportError: return None` 是死代码，而 gitRepo / uv 建 venv 两条 prepare
路径都无条件调它。

### 1.3 审批单补「执行时刻」并纳入 retention

审批单只记 `decidedBy/decidedAt`（谁批准），没有「真的执行了没有」：
批准后领取失败（并发已用 / 崩溃在领取与副作用之间）与「刚批准还没跑」在表面上
完全一样。迁移 068 补 `consumedAt TIMESTAMPTZ NULL`（存量不回填——历史执行时刻只在
日志里，近似值等于伪造审计事实），`consume()` 状态与时刻同一条 UPDATE 落库，
前端审批单页签新增「执行时刻」列。

同轮把 `agent_approvals` 纳入 B-10 retention：只删「已处置（granted/consumed/denied）
+ 会话已终态 + 超 180 天」，**pending 永不删**（待办工作项，删掉等于静默抹掉一个
还在等人点头的请求）。

## 2. 反证（每条都实测改回旧行为会红）

| 修复 | 反证动作 | 结果 |
|---|---|---|
| keyset total（tasks） | 换回游标之后的 `getManyAndCount` | 2 条用例红 |
| keyset total（executions） | 把 `getCount()` 挪到 `getMany()` 之后 | 「total 仍是真实总数」红 |
| 心跳健康 | 把 `retry_error_callback=lambda st: None` 加回装饰器 | 真路径用例 + 重试耗尽用例红 |
| resource 守卫 | 在 try 之前加回裸 `import resource` | `ModuleNotFoundError`，用例红 |
| 审批执行时刻 | 删掉前端「执行时刻」列 | consumed 行时间格 3→2，用例红 |
| 审批单 retention | 删掉审批单清理段 | 3 条用例红 |
| 包列表轮询 silent | 轮询改回 `load()` | 3 条用例分别红 |

## 3. 验证矩阵

- `apps/admin-api` 全量：**356 suites / 6259 tests 全绿**（task 1531、agent 228）。
- `apps/admin-web` 全量：**252 files / 2111 tests 全绿**；`tsc -b` 0 错；i18n 双绿。
- `apps/executor-python`：pytest 全绿，覆盖率 **87.31%**（门槛 86%）。
- 守卫：`check-migrations`（113 迁移全注册，下一可用 069）、`check-atlas-counts`、
  `check-docs`、`agent-boundary-check`（含 4 条执行侧断言）、`test:guards` 全绿。

## 4. 三路审计的其余发现（已登记，未在本轮修）

均已回读源码确认为真，按「影响 / 成本」排进 `docs/audit-playbook.md` §5：

- **E1（P1）** 部署页把「当前页 20 行」当全量：升级覆盖面低报、第 21 台起占用校验失效、
  翻到全 failed 页时「升级所有」消失（`upgradeAll` 实际全行执行）。
- **F1（P1）** MCP 三个写工具的 zod shape 缺后端合法字段，SDK strip 未知键 + 后端
  空 patch 仍 200 → 「调用了、成功了、什么都没发生」；`create_application` 漏
  `approvalRequired` 会静默取消第二人审批。
- **G1（P1）** executor-python 停机排水闸 `_shutting_down` 在生产启动路径无人置位
  （置位者在 `if __name__ == '__main__'` 内，而镜像是 `uvicorn main:app`）。
- P2/P3：E2 部署页 loading 被轮询抢序号、E3 SSE 换票失败 toast 风暴、E4 webhook
  状态误读为「未启用」（再启用会轮换密钥）、F2 `acf app deploy` 把「待审批」当成功
  exit 0、F3 脱敏哨兵 `[redacted]` 与后端 `******` 不一致、F4 executorId 静默改投、
  G2/G3 停机丢日志分片与回调批次、G4 config reload 部分生效。

## 5. 判定「不是问题」（防后人重跑）

- `ExecutionsPage` / `ExecutionDetailPage` 的「终止」按钮**已**按执行态收敛
  （含 KILL-WAITING 对 waiting 的补齐），不是「恒可点」。
- `traceparent` 写进回调 JSON 体不会 400：`ParseArrayPipe` 只 whitelist 不 forbid。
- 杀端点与终态回调的「双发」窗口有互斥标记 + admin 终态守卫，不构成重复终态。

## 6. 一次自伤事故（如实记录）

本轮用 `git add -A` 提交 executor-python 修复时，把**另一并发会话**正在编辑的
「推理质量轮」工作树（`agent-context.ts` / `agent-llm-retry.ts` + `agent-runtime.service.ts`
改写）一起卷进了提交；那份 WIP 的配套改动（`agent-tool-call.entity` 的 `toolCallId`、
`agent-budget.service` 的 `resolveContextWindow`、`configuration.ts` 的 `agent.context`
段）当时还没落盘，于是 **HEAD 一度不可编译**：

```
agent-runtime.service.ts(218,27): error TS2339: Property 'resolveContextWindow' does not exist
agent-runtime.service.ts(309,13): error TS2353: 'toolCallId' does not exist in type 'RecordToolCallInput'
```

处置：新增一个 revert 提交，把 `agent-runtime.service.ts` 恢复成 d249b5c2 的版本，
并把那两个模块与其 spec 从库里移除（**文件保留在工作区**，交给正在做这件事的会话
按完整形态提交）。随后在干净 worktree（`git worktree add --detach c78f241d`）里验证：
`tsc --noEmit` 0 错、agent 模块 14 suites / 230 tests 全绿。

纪律已写进 `docs/audit-playbook.md` §0：**多会话共用工作区禁止 `git add -A`**，
提交前用干净 worktree 验证 HEAD 自洽。
