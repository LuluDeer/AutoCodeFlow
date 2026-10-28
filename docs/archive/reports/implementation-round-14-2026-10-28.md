# 实施轮 #14 · 审批闭环「执行侧」（2026-10-28）

> 本轮是审计轮 #11 登记、实施轮 #12 只做完**申请侧**的那条缺陷的收口。
> 一句话结论：**「批准了就能执行」此前不成立**——批准的只是一行数据库状态，
> 闸门下次照样返回 NEED_APPROVAL，5 个 `approvalRequired` 工具至今不可执行。

## 1. 缺陷链（修前实测，逐条读过源码）

| # | 事实 | 后果 |
|---|---|---|
| ① | `AgentBoundaryService.check()` 恒返回 `NEED_APPROVAL`，无「本次已批准」入参 | grant 只翻数据库行；下一轮推理重新撞同一道门 → 永久不可执行 |
| ② | `requestApproval()` 用 `apr-${session.id}-${Date.now()}` 拼审批键 | 幂等唯一索引（23505 分支）是死代码：每次重试都是新行，一次动作能堆出 N 张单 |
| ③ | 工具返回 NEED_APPROVAL 后仍 `return` 给循环，循环继续下一轮 | 会话已 `waiting_input` 但循环还在跑（与 B-8 的重复执行防线正面冲突） |
| ④ | 工具结果**从不落 step** | 恢复/重放时 messages 里有一串 assistant `tool_calls` 却没有任何 `tool` 应答 → 上游 400 |
| ⑤ | 拒绝后自动 `resume()` | 拒绝变成「立刻重试同一动作」，人工拒绝形同虚设 |
| ⑥ | 决策后 `agent_tool_calls` 行停在 `awaiting_approval` | 台账永远显示「等待中」，无法区分拒绝/超时/成功 |
| ⑦ | `hasPendingForSession()` 有实现、零调用 | `POST :id/resume` 可以绕过审批直接把会话推回运行 |

## 2. 修法（一次审批 = 一次执行）

- **确定性审批键**：`buildKey(sessionId, toolName, args)` =
  `apr-<sessionId>-<sha256(toolName + "|" + canonicalJson(args)).slice(0,16)>`。
  键只由「会话 + 工具 + 参数」决定：重试命中同一行（幂等真的生效），
  换参数则是另一次动作、需要另一张单。`canonicalJson` 排序键、数组保序、
  丢弃 `undefined`——否则 `{a,b}` 与 `{b,a}` 会算出两张单。
- **一次性消费**：新增 `consume(approvalKey)`，条件写
  `{approvalKey, status:'granted'} → {status:'consumed'}`（affected>0 才算领到）。
  执行体在**副作用之前**领取；领不到（并发已用）→ 拒绝执行并如实告知。
- **闸门接受通行证**：`check(session, tool, args, count, approvedApprovalKey)`。
  有通行证时跳过三处「需审批」分支，但**保留**策略级禁用、硬禁用、scope、
  速率、白名单等所有其它闸 —— 人工点头放行的是**这一次调用**，不是整个会话，
  更不能把 `allowDangerous=false` 这种「能力没开」当成「本次需点头」。
- **停轮**：执行体返回 `needsApproval:true`，运行时立即以
  `{status:'waiting_input', reason:'needs_approval'}` 收束（不落终态，grant 后可 resume）。
- **补 tool 应答**：`rebuildMessages` 现在按 `toolCallsJson` 逐条比对已有的
  `role='tool'` 步，缺的用台账（`listToolCalls`）合成 `{role:'tool', tool_call_id, content}`；
  内容如实区分「执行成功（结果已截断）」「等待人工审批」「已被拒绝」——让模型知道
  不能原样重试，而不是看到空响应乱猜。
- **拒绝不自动恢复**：`denied` 时把对应工具调用结算为 `denied` 并写入拒绝理由，
  会话保持在 `waiting_input`；恢复由人显式点。`resume` 在仍有 pending 单时
  → 409 `AGENT_SESSION_PENDING_APPROVAL`（新错误码，中英 + 生成物同步）。
- **台账收口**：`settleToolCallByApprovalId()` 把 `awaiting_approval` 行条件更新为
  `denied`/`error`，附带拒绝人。

## 3. 反证（每条都真的改回去看过红）

| 反证动作 | 结果 |
|---|---|
| 闸门忽略第五参（删 `approvedApprovalKey` 短路） | `agent-boundary.service.spec.ts` 3 条新用例红（通行证放行 / scope 不放行 / 速率·硬禁·策略不放行） |
| `consume` 改回无条件 `update` | `tool-executor.service.spec.ts`「并发领不到 → 拒绝执行且不调工具」红 |
| 审批键改回 `Date.now()` | `agent-approvals.spec.ts` `buildKey` 确定性用例红（键序无关、参数敏感） |
| 循环不停轮（去掉 `if (waitingForApproval) break`） | `agent-runtime.service.spec.ts`「needsApproval → waiting_input，LLM 只调一次」红 |
| `rebuildMessages` 不补 tool 应答 | 同文件「补 tool 消息 / 拒绝如实说明 / 已有应答不重复」3 条红 |
| `resume` 不查 pending | `agent.controller.spec.ts`「仍有 pending → 409，不入队」红 |
| 守卫脚本 `escapeRe` 替换串写坏 | `scripts/check-interface-maps.mjs` 的 escapeRe 自检立即红（exit 1） |
| `check-guards-wired` 只扫根 `scripts/` | 临时移除豁免项 → 立刻报 `apps/admin-api/scripts/check-route-authz-matrix.mjs` 未接线 |
| 包列表轮询改回非 silent | 新增 `executor-packages-polling-silent.test.tsx` 三条分别红（加载态闪现 / 错误块插入 / 失焦仍轮询） |

## 4. 验证数字

- `apps/admin-api` 全量：**355 suites / 6252 tests 全绿**（agent 模块 228）。
- `apps/admin-web` 全量：**252 files / 2110 tests 全绿**；`tsc -b` 干净。
- `node scripts/agent-boundary-check.mjs`：全部断言通过，**新增 4 条执行侧闭环断言**
  （确定性键 / 闸门消费通行证 / 副作用前领取 / 遇审批停轮）。
- 错误码：405 个中英齐备，生成物无漂移（`check:error-i18n`、`check:error-migration`）。
- 根守卫套件 `npm run test:guards`：见提交信息（同一轮内跑通）。

## 5. 顺带修掉的「守卫自身的假绿」

1. **`scripts/check-interface-maps.mjs` 的 `escapeRe` 被写坏**：替换串里塞进了
   一整行 JS 源码（`"\\  const absent = [...].filter(...)"`）。语法仍合法，所以
   从来没人发现；含 `.` `(` 等正则元字符的路由前缀会被替换成垃圾串 → 该前缀
   永久匹配不上 → 缺失检查静默失效。现在恢复为 `"\\$&"`，并加了**运行时自检**
   （转义结果不对就红，不再依赖「当前恰好没有元字符」的运气）。
2. **`scripts/check-guards-wired.mjs` 只扫根 `scripts/`**：子项目守卫
   （`apps/*/scripts`、`packages/*/scripts`）完全不在判据内 —— 新增一个子项目
   守卫，这道闸不会提任何要求。现在三处都扫，并加规模下界（<20 个即红，防
   扫描面收窄后静默全绿）；唯一豁免项 `check-route-authz-matrix.mjs` 写明
   理由（判据本体是该包被 jest 收集的 spec，脚本只是 CLI 外壳）。

## 6. 前端：包列表 30s 轮询不再打断用户

`ExecutorPackagesPage` 的定时器直接调 `load()`，而 `load()` 无条件
`setLoading(true)`：用户读行/勾选时每 30s 整表闪一次加载态，失败还会弹 toast 并把
页面推进错误态。现在 `load({silent:true})`：不动 loading、不弹错、保留旧数据，
并按 `document.visibilityState` 失焦暂停（对齐 `AgentSessionsPage` 先例）。

## 7. 未收口（如实）

- **B 系列（安全面）**：B1 工具参数脱敏的按键名清单是否覆盖 `password/secret/token`
  之外的形态（如 `*_pwd`、`credential`）；B2 executor 侧 SSRF 与 admin 侧矩阵的
  差异段；B3 `agent_notifications` 投递失败的重试语义；B4 会话保留策略与审计留存的冲突。
- **C3**：`ExecutorDetailPage` 的 kill/inspect 按钮恒可点（后端会 409，前端没先拦）。
- **审批 UI**：`consumed` 只做了展示，没有「已执行」时间列（`consumedAt` 未落库）——
  要展示得先加列，属下一轮的数据模型改动。

## 8. 下轮建议

1. 给审批单补 `consumedAt/decidedBy` 落库 + 审批列表时间线（当前只能看到结论）。
2. B 系列按「可反证」的标准逐条收：每条先写一个会红的断言，再改代码。
3. 前端 C3：把「后端会拒」的状态前置到按钮 disabled，并补一条交互测试。
