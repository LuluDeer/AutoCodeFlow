# 两个过时的 agent 检查脚本（已修复 + 双向验证）

> 日期：2026-10-08 · 基线 commit：`cf2f82ee`
> 起因：提交 CLI/MCP 修复前跑仓库守卫，发现 `agent-boundary-check` 与
> `agent-sop-check` 两项红。用 `git stash` 取基线确认**在 HEAD 即失败、与本轮改动无关**。
> 结论：**两者都不是产品缺陷，而是服务演进后未同步的检查脚本**。均已修复。
>
> ⚠ **本文含一处重要更正**：初稿把第 1 项定性为「未纳管的工具有绕过边界闸的风险」。
> **该定性是错的** —— 复核闸门源码后确认它是 **fail-closed**（未知工具一律拒绝）。
> 详见 §1 的更正说明。

---

## 0. 修复结果

| 检查 | 修复前 | 修复后 |
|---|---|---|
| `test:agent`（runtime + boundary + trigger） | ✘ 2 项失败 | ✅ 254 断言全绿（100 / 66 / 88） |
| `test:sop` | 未捕获异常 `exit=1` | ✅ 148 断言全绿 |

两者均已做**负向验证**（故意破坏 → 必须变红），确保断言不是摆设。

---

## 1. `agent-boundary-check`：断言前提腐烂（非安全缺口）

### 1.1 ⚠ 更正：边界闸是 fail-closed，不存在"绕过"

初稿写「9 个工具不在 agent 工具集内，意味着这些面若经 agent 触达，**不经过边界闸的
tier 判定与速率限制**」。**这是错的**。闸门源码 `agent-boundary.service.ts:134-142`：

```ts
const spec = AGENT_TOOL_BY_NAME.get(toolName);

// ── ① 工具存在性 + 会话白名单 ──────────────────────────────────
if (!spec) {
  return this.deny(
    "not_in_toolset",
    `未知工具 ${toolName}——不在 Agent 工具集内。`,
  );
}
```

未注册的工具走 `deny("not_in_toolset")` —— **拒绝**，不是放行。而且该性质**早已有
红队断言覆盖**（`agent-boundary-check.mjs` §3）：

```js
const v4 = gate.check(makeSession(), "rm_rf_everything", {}, 0);
check("红队：未知工具被拒", v4.kind === "DENY" && v4.reason === "not_in_toolset");
```

所以这**从来不是安全缺口**：不在工具集里的工具，agent 根本调不动。初稿把「功能上
不可用」误读成了「安全上未校验」，方向正好相反。

### 1.2 真正的根因：硬编码 + 错误前提

原断言（`agent-boundary-check.mjs:133-150`）写死了三个数字，其隐含前提是
**「agent 工具面 == mcp 工具面」**：

```js
check("43 个收编工具全部登记", AGENT_TOOL_SPECS.length === 43, ...);
check("mcp-server 侧解析到 43 个工具名", mcpNames.length === 43, ...);
check("Agent 工具集覆盖 mcp-server 全部工具（无遗漏）", missing.length === 0, ...);
```

但两个面**本就是刻意不同的**，实测数据：

| 集合 | 数量 | 说明 |
|---|---|---|
| `AGENT_TOOL_SPECS`（LLM 可见） | 43 | 喂给模型 function-calling 的工具 |
| `AGENT_INTERNAL_TOOL_SPECS` | 6 | `sop_list` `sop_get` `sop_draft` `sop_publish` `sop_assign` `sop_reply_clarification` |
| `ALL_AGENT_TOOL_SPECS`（闸门全集） | 49 | 上面两者之和 = 闸门认识的工具 |
| `mcp-server` 工具 | 52 | — |

- MCP 比 agent 多出的 9 个里，`sop_list` / `sop_get` **其实已被内部工具覆盖**（同名）；
  真正两边都没有的是 **7 个**：`export_task`、`import_task`、`list_task_templates`、
  `sop_assignments_pending`、`agent_session_list`、`agent_session_get`、
  `sop_clarification_reply`。
- agent 侧另有 MCP 没有的：`sop_draft` / `sop_publish` / `sop_assign`
  （且 MCP 叫 `sop_clarification_reply`，agent 叫 `sop_reply_clarification`——**命名
  也不同**，说明这是两条独立设计的通路，不是同一份清单的镜像）。

**硬编码 `=== 43` 是漂移根源**：mcp-server 从 43 涨到 52 的整个过程中，没有任何机制
提醒这个脚本。

### 1.3 修法（已实施）

把「必须镜像」换成**两条真正该成立的不变量**，并让"排除"成为显式决定：

1. **每个 MCP 工具要么被闸门纳管、要么在显式排除清单里** —— 新增 MCP 工具时若两者
   都不满足即红，**迫使做一次显式决定**，而不是静默漏掉。
2. **排除清单本身受双向约束**：无过期项（MCP 已删的工具要移除）、与纳管集合不重叠
   （声明排除却又登记 = 自相矛盾）。

去掉了全部硬编码计数，断言改为动态解析。显式排除清单（含理由）落在脚本内：

```js
const MCP_TOOLS_EXCLUDED_FROM_AGENT = [
  // 任务流转的导入导出与模板面：面向人的搬运/脚手架，非 Agent 运行时职责
  // （import_task 会真的创建任务，交给 Agent 自主创建属扩权）。
  "export_task", "import_task", "list_task_templates",
  // SOP 协作面（执行器侧经 /api/agent-collab 走自己的令牌通道），
  // 与 Agent 的中台侧工具面是两条不同的通路。
  "sop_assignments_pending", "sop_clarification_reply",
  // Agent 会话自省：ADMIN 在中台查看 Agent 的推理轨迹用，
  // 让 Agent 读自己的会话列表没有运行时用途。
  "agent_session_list", "agent_session_get",
];
```

> **注意措辞**：脚本断言的是「要么纳管、要么**显式声明排除**」，而不是断言某组工具
> "应该"被排除。它不替产品做决定，只**强制决定被记录下来**。若产品后续要开放
> `import_task` 给 Agent，正确动作是把它加进 `AGENT_TOOL_SPECS`，此时"重叠"断言会
> 提醒把排除清单里的同名项删掉。

### 1.4 负向验证

向 `mcp-server/src/tools.ts` 注入一个既未纳管也不在排除清单的
`brand_new_ungated_tool`：

```
[CAUGHT] guard exit=1
   ✘ 每个 mcp 工具要么被闸门纳管、要么在显式排除清单里（新工具必须做决定）
     — 未纳管且未声明排除=brand_new_ungated_tool
restored: guard exit=0
```

还原后 `dev` 侧工具数回到 52、无注入残留。

---

## 2. `agent-sop-check`：脚本未跟上服务契约演进

### 2.1 根因（两个叠加）

**(a) `ingestClarification` 新增归属断言，脚本没传 `executorId`**

服务层加了 B-1 越权闸（`sop.service.ts:574-576`）：

```ts
if (a.targetExecutorId !== input.executorId) {
  throw new ForbiddenException("指派不属于该执行器");
}
```

脚本的 9 处 `ingestClarification` 调用**都没传 `executorId`** → `undefined !== UUID_A`
→ 403 → 未捕获 → 整个检查以裸 Node 异常中断（打印转译产物绝对路径堆栈）。

修法：按各自指派的执行器补参（`a2` → `UUID_B`，其余 → `UUID_A`）——**逐调用点推导而
非一律填 `UUID_A`**，否则会静默削弱 `a2` 那个不同执行器用例的覆盖。

**(b) `pendingReplyItems` 改用 QueryBuilder，脚本假 repo 没实现**

修完 (a) 后暴露下一个同类问题：B-11 把「只拉已落定且晚于游标的行」下推到 SQL，
`pendingReplyItems` 改用 `clarifications.createQueryBuilder()`，而脚本的 `makeRepo`
替身没有该方法 → `TypeError: this.clarifications.createQueryBuilder is not a function`。

修法：给替身加最小 QueryBuilder（`where` / `andWhere` / `orderBy` / `getMany`）。
**关键细节**：服务侧的内存兜底过滤只重复了 `resolution !== null` 与游标比较，
**没有重复 `assignmentId` 收窄**（它假定 SQL 已按指派范围拉过数据）。所以替身**必须
自己实现 assignmentId 谓词**——否则会把别的工单的澄清回复一起投递。

### 2.2 补的 4 条断言（不止于"让它变绿"）

`ingestClarification` 的 403 正是本脚本崩溃的根因，但**此前没有任何断言覆盖它**。
补上：

- `B-1：澄清通道校验指派归属（别的执行器不能塞澄清）` —— 正向覆盖崩溃根因。

再加一个独立块覆盖上述 QueryBuilder 盲区：

- `A 的 poll 只拿到自己指派的澄清回复（不跨指派投递）`
- `A 的 poll 不含 B 的澄清 id`
- `B 的 poll 只拿到自己指派的澄清回复`

**这 3 条的负向验证**（去掉替身里的 assignmentId 过滤）：

```
✘ A 的 poll 只拿到自己指派的澄清回复（不跨指派投递）
✘ A 的 poll 不含 B 的澄清 id
✘ B 的 poll 只拿到自己指派的澄清回复
=== 3 项失败 ===
```

即：**在补这 3 条之前，去掉该过滤是没有任何断言会红的**——它们专为那个盲区存在。

---

## 3. 为什么 CI 一直没抓：`test:agent` / `test:sop` 不在任何 job 里

- `npm run test:unit` **不含**它们（只列 api/node/python/web/cli/mcp/pypi/sdk/lib*/desktop）；
- CI `selftests` job 用**显式脚本清单**（`test:arch31-*` / `pull-dispatch` /
  `control-plane-pull` / `qa05-callback-tier` / `oidc-sso` / `nginx-sse` /
  `ha-compose` / `registry-npm`），**不含** `test:agent` / `test:sop`。

这正是 `ci.yml` 顶部注释里记过的那类风险（"6/6 develop push 全 skip、长期无人发现地
腐烂"）。**现在两者都已转绿，具备纳入条件**——建议加入 `selftests` job（或新建 agent
job），否则它们会再次腐烂。

> 初稿曾写「不能直接把这两个红脚本加进 CI」。该顺序要求现已满足：先修红、再纳入。

---

## 4. 证据边界

- 闸门 fail-closed 的结论来自**源码直读**（`agent-boundary.service.ts:134-142`）+
  脚本内既有红队断言（§3 的 `rm_rf_everything`）；未做真机 HTTP 往返（admin-api 未起）。
- 「7 个真正两边都没有」由脚本机械比对 `ALL_AGENT_TOOL_SPECS` ↔ `mcp-server` 的
  `server.tool(` 解析结果得出，非人工清点。
- 排除清单里的**理由**是依据各工具的语义与既有口径推断的（如 `registerProjectTools`
  的"成员写面刻意不进自动化面"），属**记录现状**；脚本断言不依赖这些理由成立，
  仅要求"有决定"。
- 两处修复均做负向验证（破坏 → 必红），避免产生"恒真断言"。
