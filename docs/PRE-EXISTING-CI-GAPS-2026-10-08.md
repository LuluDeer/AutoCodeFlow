# 预存在的 CI 未覆盖缺陷（2026-10-08 提交前侦察发现）

> 背景：在提交 CLI/MCP 修复前，本地跑了仓库守卫以排查「本地绿、CI 红」的风险。
> 发现两项**与本次改动无关、且在 HEAD 即失败**的缺陷。CI **不会**捕获它们
> （原因为 `test:agent` / `test:sop` 不在 CI 任何 job 的调用清单里），所以不会阻塞
> 本次提交——但它们是真缺陷，登记于此以免丢失。
>
> 验证方法（基线）：`git stash push -u` 后跑同一脚本，失败完全一致。

---

## 1. `agent-boundary-check` 红 2 项：agent 边界闸未覆盖 9 个 MCP 工具

**脚本**：`scripts/agent-boundary-check.mjs`（`npm run test:agent` 的第二段）

**失败输出**：

```
✘ mcp-server 侧解析到 43 个工具名 — mcp=52
✘ Agent 工具集覆盖 mcp-server 全部工具（无遗漏） —
   missing=export_task,import_task,list_task_templates,sop_list,sop_get,
           sop_assignments_pending,agent_session_list,agent_session_get,
           sop_clarification_reply
```

**实测基线**：

| 事实 | 值 | 来源 |
|---|---|---|
| `scripts/agent-boundary-check.mjs:144` 期望 | `=== 43` | 硬编码断言 |
| `packages/mcp-server/src/tools.ts` 实际 | **52**（HEAD 时已是 52） | `git show HEAD:...tools.ts` 计数 |
| agent 工具注册表条目 | 49 | `tool-registry.ts` 的 `name:"` 计数 |

**为什么是真缺陷（而非测试过时）**：该脚本的**意图**是「agent 边界闸（tier / 白名单 /
熔断 / 速率）必须纳管 mcp-server 的每一个工具」——即任何 agent 能调用的工具都要过闸。
现在 9 个工具（export/import/templates/SOP/agent sessions/clarification reply）
**不在** agent 工具集内，意味着这些面若经 agent 触达，**不经过边界闸的 tier 判定与
速率限制**。其中：
- `sop_clarification_reply` 是 `dangerous` 级语义（会改线上 SOP）；
- `import_task` 会创建任务；
- 其余为读面（export/list/get），风险较低但同样属"未纳管"。

**建议修法**（两条路，需产品裁定）：
1. **补齐**：把 9 个工具加入 `AGENT_TOOL_SPECS`（给 tier + parameters），并把断言
   的 43 改为从 mcp-server 动态解析（去掉硬编码，让守卫自身不再漂移）；
2. **显式排除**：若产品决定这些面**不应**给 agent 调用，则把断言改为
   「agent 工具集 ⊆ mcp-server 工具集」+ 一份显式的 `AGENT_EXCLUDED_TOOLS` 白名单，
   并断言两者互补覆盖全部 52 个——这样"排除"是**有记录的决定**而非沉默缺口。

我倾向 **方案 2**：`sop_*` / `agent_session_*` 面向 ADMIN-only 端点，与
`registerProjectTools` 既往「成员写面刻意不进自动化面」的口径一致；但必须有显式
排除清单，否则下次加工具又会静默漏掉。

**⚠ 注意**：断言 `mcpNames.length === 43` 这种**硬编码计数**是本次漂移的根因——
mcp-server 从 43 涨到 52 时，没有任何机制提醒该脚本。修法应一并去掉硬编码。

---

## 2. `agent-sop-check` 抛未捕获异常退出

**脚本**：`scripts/agent-sop-check.mjs`（`npm run test:sop`）

**失败输出**：

```
✔ boost patch/minor/major 递增正确
✔ 版本快照独立（各自 contentHash）
✔ 已发布版本不受工作副本编辑影响（不可变真身）
[Nest] LOG [SopService] SOP published: slug=daily-report version=1.0.0
apps/admin-api/.sop-check/src/modules/sop/sop.service.js:446
    throw new common_1.ForbiddenException("指派不属于该执行器");
ForbiddenException: 指派不属于该执行器
    at SopService.ingestClarification (...sop.service.js:446:19)
    at async .../scripts/agent-sop-check.mjs:426:16
Node.js v24.21.0
exit=1
```

**性质**：脚本自身**未捕获**该 403，于是以裸 Node 异常退出（打印转译产物的绝对路径
堆栈），而非走它自己的断言汇总。这既是**被测逻辑的问题**（`ingestClarification` 对
「指派不属于该执行器」的判定与脚本构造的数据不符），也是**脚本健壮性问题**
（一个预期内的 403 不该让整个检查以未捕获异常崩掉）。

**为什么 CI 没抓**：`test:sop` 同样不在任何 CI job 的调用清单里。

**建议修法**：先把脚本第 426 行那个调用包进 try/catch 并转成一条 `check()` 断言
（让失败可读），再判断断言本身期望什么——是"应当 403"还是"数据构造有误"。

---

## 3. 附带发现：CI 未覆盖的 `test:agent` / `test:sop`

上面两个脚本属于根 `package.json` 的 `test:agent` 与 `test:sop`，但：
- `npm run test:unit` **不含**它们（只列 api/node/python/web/cli/mcp/pypi/sdk/lib*）；
- CI 的 `selftests` job 用**显式脚本清单**（`test:arch31-*` / `pull-dispatch` /
  `control-plane-pull` / `qa05-callback-tier` / `oidc-sso` / `nginx-sse` /
  `ha-compose` / `registry-npm`），**不含** `test:agent` / `test:sop`。

这正是 `ci.yml` 顶部注释里记过的那类风险（"6/6 develop push 全 skip、长期无人发现地
腐烂"）——建议把 `test:agent` / `test:sop` 纳入 `selftests` job（或新建 agent job），
否则它们会继续腐烂。

---

## 与本次提交的关系

以上**均非本轮改动引入**：基线验证在本轮改动 stash 后跑出完全相同的失败。
本轮 CLI/MCP 修复**不触碰** `apps/admin-api/src/modules/agent/**` 与
`modules/sop/**`，故未一并修改（避免把无关的架构裁定绑进一个修复提交）。