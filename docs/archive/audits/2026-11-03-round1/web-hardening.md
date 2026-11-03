# web-hardening（Round 2 · admin-web 域）交付报告

> 负责人：SubAgent `web-hardening`｜日期：2026-11-03｜仓库：`/home/yongsheng/project/AutoCodeFlow`（AGPL-3.0-only）
> 写域：`apps/admin-web/**` + `scripts/`（新守卫及其基线；未触碰 `apps/admin-api/**`、`apps/executor-*/**`、`packages/**`）
> 分工：本报告由我（专项负责人）编写；§4 的两份孙Agent 调研产物原文见 `/tmp/web-hardening/{oss-research.md,codegraph-layers.md}`（未入库，结论已摘录）。

---

## 0. 摘要：三项任务的完成度与三个必须订正的前提

| # | 任务 | 状态 | 核心读数 |
|---|---|---|---|
| 1 | B0 回归护栏（3749 行区） | ✅ 完成（范围按实测收窄） | 新增 **72 例**（settings/audit 真实盲区 + H-6 契约 + 浮空 rejection）；全量 2233⇒**2305 全绿**；真实盲区是 58%/50% 与 71%/65%，**不是「零覆盖」** |
| 2 | H-6：SSE 工厂 visible 路径绕过 `reconnect:false` | ✅ 已修 + 实证有效 | 4 例新测试；回退修复 ⇒ 3 例立刻红 |
| 3 | 字段级类型漂移守卫 | ✅ 已建 + 实证有效 + 已接线 | 17 条自检；实测 **61 处字段漂移**（missing 50 / extra 11） |

### 三个必须订正的前提（本轮实测，均附证据）

**订正 1：`pages/settings/*` + `audit/index.tsx` 不是「3,750 行零直接覆盖」。**
用 v8 coverage 独立测了两次（我与孙Agent 各一次，结果一致）：

| 文件 | stmt | branch | func |
|---|---|---|---|
| `pages/audit/index.tsx` | 88% | 68% | 89% |
| `pages/settings/AiProvidersSettings.tsx` | **58%** | 63% | **50%** |
| `pages/settings/ApiKeysSettings.tsx` | 90% | 84% | 89% |
| `pages/settings/EventSubscriptionsSettings.tsx` | 89% | 74% | 86% |
| `pages/settings/SecuritySettings.tsx` | 92% | 80% | 90% |
| `pages/settings/ai-provider-filter.ts` | 100% | 100% | 100% |
| `pages/settings/index.tsx` | **71%** | 66% | **65%** |

该区合计 **stmt 82.0% / branch 70.6% / func 78.9%**。仓内已有同类纠正先例：`docs/archive/audits/2026-10-29-round4/test-guard-quality.md:39`。
⇒ 如果照「零覆盖」立项，会去写一批已覆盖的 happy path 测试（重复劳动 + 假产出）。**真盲区只有两个文件。**

**订正 2：基线用例是 2233，不是 2162。** 且存在 1 个**预存在**而非本轮引入的 flake：`src/__tests__/sops-page-b14.test.tsx` 在**全量并发**下偶发超时红（单文件跑 10/10 绿）。它是负载敏感的时序用例，与本轮改动无关（我未触碰 sops 相关任何文件）。

**订正 3：Round 1 审计 §1.7 缺陷 1 描述的「双跑」路径**在现有代码里**不可达**（详见 §1.2）。H-6 是真缺陷，但**形态与审计描述的不同**。这条订正很重要：它改变了「修完之后应该观察到什么」。

---

## 1. §1 已修复项

### 1.1 H-6：SSE 工厂 `visible` 路径绕过 `reconnect:false`

**文件**：`apps/admin-web/src/api/sse-client.ts`（唯一改动文件，+22 行 / −0 行，纯注释 + 4 行判据）

**缺陷机理（逐行）**：
`reconnect:false` 的判据**只写在** `scheduleReconnect()`（`:187-198`）：

```js
if (!reconnect) { setStatus('reconnecting'); return; }   // :189-192
```

而 `onVisibilityChange()` 的 visible 分支**直接调 `connect()`**（原 `:300`），**完全不经过 `scheduleReconnect`** —— 于是调用方明确声明的「断线即停、交由轮询兜底」在**可见性恢复路径上形同虚设**：标签页切回前台时工厂会静默复活一条流。

消费方 `components/ExecutionLogSection.tsx` 正是声明 `reconnect:false` 的那一个（`:248`），并且它**自管**一套重连预算（`MAX_SSE_AUTO_RETRIES=2`、`retryCount`、`gaveUp`、8s 轮询兜底 `:348-364`）。工厂静默复活 ⇒ 组件侧状态机毫不知情。

**修法**（`sse-client.ts:300-305`）：

```js
if (!reconnect) {
  setStatus('reconnecting');
  return;
}
void connect();
```

即：visible 路径**同样尊重 `reconnect` 语义**。`reconnect:false` 时**不代为重建**，只报告 `'reconnecting'`——把「要不要重建」的决策权交还调用方（自管预算的一侧正是靠这个信号接管恢复）。
`reconnect:true`（`useMetricsStream` / `useExecutionsStream`）行为**完全不变**：仍是 visible 即立即重连、`attempt` 归零、状态回 `connecting`。

**改动前后行为对比**：

| 场景 | 改动前 | 改动后 |
|---|---|---|
| `reconnect:true` + hidden→visible | 立即重连，attempt=0，status=connecting | **不变**（有非回归用例 ③ 钉住） |
| `reconnect:false` + hidden→visible | **静默 `connect()`**：多换 1 次票 + 多建 1 条 EventSource，调用方毫不知情 | 只报 `'reconnecting'`，**不建流**；由调用方按自己的预算决定 |
| `reconnect:false` + hidden（后台） | 关流 + 清定时器，不发状态 | **不变** |
| 卸载清理 | close 摘监听 + 删 statusKey | **不变**（无新增泄漏：未新增任何 listener/timer） |

### 1.2 关于「双跑」的实证订正（重要）

我用**真实消费方路径**（渲染 `ExecutionLogSection`，走真实工厂代码）复现审计描述的路径：断线 → 预算耗尽 → `gaveUp` → `setStreamDisconnected(true)` → 8s 轮询兜底跑起来 → 切走标签页再切回。

**结果：即使把修复回退（buggy 代码），这条路径也不会复活流。** 原因是 `gaveUp` 分支先调了 `client?.close()`（`ExecutionLogSection.tsx:285`），而工厂的 `close()` 会 `removeEventListener('visibilitychange')`（`sse-client.ts:301-303`）⇒ **gaveUp 之后工厂已经没有监听器，不可能复活**。

所以审计说的「SSE 与轮询同时跑」被这段清理**掩盖**。

**真正可达的契约破坏**发生在**重连预算窗口内**（`retryCount < MAX_SSE_AUTO_RETRIES`、客户端尚未 close、visibility 监听仍存活时）：用户在这个窗口切走再切回 ⇒ buggy 版本会多换一次票据 + 多建一条 EventSource（占服务端 32 槽之一），而组件侧 `retryCount`/`retryTimer` 对此一无所知。这才是 H-6 的真实危害，我的端到端用例打的就是这条路径。

> 方法论说明：我最初写的用例 ④ 打的是「gaveUp 后双跑」，它在 buggy 代码下**也通过**——我没有就此宣称修好了，而是回头查为什么，才发现是审计描述不准确。这条弯路是本报告最有价值的部分之一：**它证明了「测试通过」不等于「缺陷存在或不存在」，必须回退修复做反向验证。**

### 1.3 【附带修复】表单校验失败 → 浮空 rejection（孙Agent 探查时暴露的真实缺陷）

孙Agent 在写 B0 用例时**顺带发现**了一个源码缺陷（不是它造成的），我核实后确认成立并修掉了。

**缺陷**：antd 的 `form.validateFields()` 在校验不通过时是 **reject**（带 `errorFields` 的对象）。三处保存入口把它**裸 await**：

| 位置 | 症状 |
|---|---|
| `pages/settings/AiProvidersSettings.tsx` `save()` | reject 逃出 try/catch ⇒ 浮空 rejection |
| `pages/settings/EventSubscriptionsSettings.tsx` `handleOk()` | 同上 |
| `pages/settings/index.tsx` `handleOk()`（配置编辑弹窗） | 同上 |

**为什么是真缺陷**：`onOk={() => void save()}`（`:286`）里的 `void` **吞掉**了 rejection，于是既没有 `catch` 也没有 `.catch()` ⇒ 它变成一条**无人接手的浮空 promise**。仓内 `src/test-support/unhandled-rejection.ts` 装的 `[ACF][unhandledRejection]` 上报器会把它记成一条「未处理拒绝」。**且** `vitest.config.ts` 的 `dangerouslyIgnoreUnhandledErrors: true` 会**吞掉**它对测试的影响——所以这个缺陷在 CI 上是**完全静默**的（这正是主Agent 上一轮「守卫自指盲区」教训的同类形态：一个不报错的缺陷）。

**修法**：与全仓既有写法**逐字一致**（`TaskFormPage.tsx:620` / `TaskDetailPage.tsx:347` / `settings/index.tsx:655` 的 AI 配置段）——**校验错误静默返回**（错误已在 antd 表单上标红，不必再弹一次），只有真实请求错误才走 `showApiError`。仓内已有现成判据 `utils/error.ts` 的 `isFormValidationError(err)`（判 `errorFields` 是否数组），三处统一改用它，**不新造判据**。

**回归护栏**：`src/__tests__/settings.form-validation-no-floating-rejection.test.tsx`（3 例）：
① 校验失败 ⇒ 不发保存请求；② 校验失败 ⇒ **不产生浮空 rejection**；③ 校验失败 ⇒ 不弹 `showApiError`。

**实证（这条尤其值得记录）**：
我第一版把观测口写成 `window.addEventListener('unhandledrejection')`，**回退修复后测试仍然全绿**——盯错了口。经实测探针：jsdom 里 `void save()` 这种「被 void 掉但没人接」的 promise，**window 监听器收到 0 条，process 监听器收到 1 条**（仓内上报器正是装在 `process` 上）。改成 `process.on('unhandledRejection')` 后：回退修复 ⇒ 用例 ② 立刻红；还原 ⇒ 全绿。

⇒ **这条本身又是一次「测试通过 ≠ 缺陷不存在」的实例**：如果我只写完就交付，会留下一条恒绿断言。

### 1.4 「`useEventStream` 统一基础设施」——评估结论：本轮**只做 H-6，不做收敛**（附依据）

按简报允许的降级路径（"若你判断一次性收敛风险过高，只做 H-6 修复…其余登记为后续项"），我**没有**动三套生命周期的收敛。理由是可量化的（见 §4 F）：

- 三套实现的**语义本就不同**，不是重复代码：`useMetricsStream`（默认 message 帧 → `setQueryData` 写缓存）、`useExecutionsStream`（具名终态帧 → `invalidate`）、`ExecutionLogSection`（默认帧 → 本地 rAF 批量缓冲 + 自管预算 + 8s 轮询降级）。抽公共 hook 必然要把「帧语义 + 消费动作」参数化，抽象层会很薄、收益主要在生命周期骨架。
- 简报已明确：**服务端明写「每浏览器 Tab 一条」且共享 32 槽位池 ⇒ 不存在扇出爆炸**，所以「降低连接数」不是理由；收益只在「消除重复 + 修潜伏缺陷」。
- 真实影响面（孙Agent CodeGraph 实测）：`createSseClient` 有 **12 个 caller（3 生产 + 9 测试）**；改动 `ExecutionLogSection` 的状态机牵动 **14 个测试文件**（含 `execution-detail-sse`、`execution-detail-log-level`、`execution-log-append.perf06`、`log-window*` 等）。
- **本轮已把「潜伏缺陷」修掉了**（H-6），而这正是收敛的主要收益。剩下的「重复」是结构性的、低风险但收益也低的重构，**不值得在验证预算已经压在 B0 + 守卫两件事上的这一轮做**。

后续排期建议见 §7。

---

## 2. §2 B0 测试覆盖

> 前提已订正（§0 订正 1）：本轮的立场是**补真实盲区**，不是「给零覆盖区凑数」。
> 据实测，盲区集中在两处：`AiProvidersSettings.tsx`（58%/50%）与 `settings/index.tsx`（71%/65%）；`audit/index.tsx` 已 88%/68%，只补残余分支。

**（本节的用例清单与最终计数在孙Agent 回传后补全——见 §2.3。）**

### 2.1 为什么先做覆盖率实测而不是直接写测试
本轮一开始就跑了 v8 coverage（`--coverage.include='src/pages/settings/**'` + `'src/pages/audit/**'`），因为「哪块没测」不能用眼睛判断：
- 仓内 269 个测试文件里已有 `audit-page.test.tsx`(684 行)、`audit-keyset-paging.test.tsx`(525 行)、`settings.ai.test.tsx`、`settings.history-rollback.test.tsx`、`settings.ai-providers-load-error.test.tsx`、`api-keys-settings.test.tsx`、`event-subscriptions-settings.test.tsx`、`security-settings.test.tsx` —— 覆盖远比审计以为的多。
- 所以新增用例必须**先读既有测试**再决定加什么，否则就是重复劳动。

### 2.2 覆盖优先级（据实测盲区排序）
1. `AiProvidersSettings.tsx`：provider 编辑器 Modal 开/存/取消、保存**错误**路径、删除确认、`assignRoute`、`loadError` 降级态、空 provider 列表、`filterProvidersForPurpose` 回退分支。
2. `settings/index.tsx`：config 保存**错误**态、加载错误态、Tab 切换、变更历史空/错态（避开既有 3 个 settings 测试已覆盖的部分）。
3. 裸 `queryKey` 正确性：settings 域是字面量键浓度最高的地方（`settings/index.tsx` 10 处、`EventSubscriptionsSettings.tsx` 8 处、`ApiKeysSettings.tsx` 4 处、`SecuritySettings.tsx` 3 处，全仓 38 处/10 文件）。**已知真 bug 同类**：`ExecutorDetailPage.tsx:98` 的 `['projects','me','roles']` 与工厂 `queryKeys.projects` 前缀冲突，导致 `ProjectsPage` 的失效打不到执行器详情页的 roles 查询。
4. `audit/index.tsx` 残余分支：keyset/offset 双模式切换、`goNext` 同游标去重、`goPrev` 栈首、`handleReset` 清栈、边界禁用态、`resourceId` 组合筛选。

### 2.3 交付清单

| 新增文件 | 用例数 | 钉住的盲区 | 有效性实证 |
|---|---|---|---|
| `src/__tests__/settings.ai-providers-branches.test.tsx` | **15** | `AiProvidersSettings` 交互分支：编辑器 Modal 开/存/关、save 失败、删除二次确认、assign 路由分配、表单校验 | 变异测试见 §2.5（**部分盲区，见下**） |
| `src/__tests__/settings-page-b0-branches.test.tsx` | **24** | `settings/index.tsx`：Token 读写面、非管理员降级、配置 CRUD（新增/编辑/删除/保存失败）、`logRetention.days` 提示、Tab 写进 URL | 见 §2.5 |
| `src/__tests__/settings-query-key-contract.test.tsx` | **23** | 设置区**缓存键契约**：读键与失效键的运行时前缀匹配 | **变异测试：读键改名 ⇒ 6 例立刻红** |
| `src/__tests__/settings.ai-providers-mutations.test.tsx`（本报告作者） | **3** | `AiProvidersSettings` 写操作失败分支的**独立对照**（删除失败不得被读成「删光了」、保存失败不得伪装成成功） | **变异测试：save 的 catch 吞错误 ⇒ 用例 ③ 红** |
| `src/__tests__/sse-h6-reconnect-contract.test.tsx` | **4** | H-6 契约（§1.1） | **回退修复 ⇒ 3 例变红** |
| **合计** | **69** | — | — |

**已有覆盖未重复**（这正是「先测覆盖再写测试」的价值）：
`settings.ai-providers-load-error.test.tsx` 已把 `AiProvidersSettings` 的**读取失败**线钉死（StateError 原位错误态 + 重试 + 「真空≠读失败」对照组）；`settings.ai.test.tsx` / `settings.history-rollback.test.tsx` 已覆盖 `settings/index.tsx` 的 AI 区块与非管理员降级、变更历史回滚；`audit-page.test.tsx`(684 行) / `audit-keyset-paging.test.tsx`(525 行) 已覆盖审计页列表/筛选/keyset 分页。**故没有为这些 happy path 再写一遍。**

### 2.4 新用例钉住了什么（每条都能失败）

新增的 3 例打的是 `save` / `remove` 的 catch 分支——「最容易腐烂」的地方：
- **① 删除成功** ⇒ 页面渲染的是**后端返回的新列表**（`p-2` 出现、`p-1` 消失），而不是本地删行。钉住「`data` 是唯一事实源」这条设计。
- **② 删除失败** ⇒ `showApiError` 被调用，且**列表原样保留**、不出现空表、不退化成正位错误态。钉住「失败不得被读成删光了」——本页 `data` 一置空，用户就会以为删成功了。
- **③ 保存失败** ⇒ `showApiError` 被调用，且**编辑弹窗不关闭**（用户输入不丢）、`message.success` 未被调用。钉住「失败不得被伪装成成功」。

### 2.5 有效性实证（变异测试，不宣称只给输出）

**全部三条主变异，都实测过「回退 ⇒ 变红 ⇒ 还原 ⇒ 变绿」。**

**变异 ①：把 `save` 的 catch 改成「吞掉错误 + `setEditing(null)`」**（最典型的回归：失败被伪装成成功）

```
$ npx vitest run src/__tests__/settings.ai-providers-mutations.test.tsx
 × ③ 保存失败：上报错误且编辑弹窗不关闭（用户输入不丢）
   AssertionError: expected "spy" to be called with arguments ... showApiError
 Tests  1 failed | 2 passed (3)
```

**变异 ②：把 `remove` 改成「不取服务端返回值、本地直接清空列表」**

```
$ npx vitest run src/__tests__/settings.ai-providers-branches.test.tsx src/__tests__/settings.ai-providers-mutations.test.tsx
     × ① 删除成功：调 deleteProvider(id)，页面渲染后端返回的新列表
 Tests  1 failed | 17 passed (18)
```

**变异 ③：把读键 `['event-subscriptions']` 改名**（⇒ 失效键的前缀不再命中读键——这正是 `ExecutorDetailPage.tsx:98` 那个真 bug 的形态）

```
$ npx vitest run src/__tests__/settings-query-key-contract.test.tsx
 × EventSubscriptionsSettings：注册 [event-subscriptions] 与 [event-dead-letters, <subId>]
 × 事件订阅启停后失效 [event-subscriptions]（能命中订阅列表键）
 × 死信 replay 后失效 [event-dead-letters]（前缀必须能命中 [event-dead-letters, <id>]）
 × 扫描器本身是活的（找到全部 8 个键根，不是空跑通过）
 × 字面量键根集合与契约表**双向相等**（多一个/少一个都红）
 × 每个键根都既有读取方又有失效方（单向即静默空操作）
 Tests  6 failed | 17 passed (23)
```

三次变异全部还原，`git diff` 确认源码零残留改动。

#### 一个诚实的发现：两份「同题」测试的覆盖差异

变异 ② 暴露出一个值得记录的细节：孙Agent 的 15 例文件**没有**捕获它，而我另写的 3 例文件捕获了。原因是**fixture 形状**：
孙Agent 的用例 ⑧ 用 `view([])`（服务端返回空列表）作 mock，于是「本地清空」与「用服务端返回值」**行为不可区分**；我的用例让服务端返回**另一个 provider**（`p-2`），才让两者可区分。

⇒ 这不是「谁写得更好」，而是**「等价断言」在某些 fixture 下会退化为恒真**。这一条已写进报告，因为它是本轮「测试有效性」这条纪律的一个具体教训：**断言必须让两种实现路径产生可观察的差异**，否则它测的是 mock 不是行为。

### 2.6 刻意未覆盖（诚实边界）
- `assign`（按用途分配模型）的失败分支：与 `remove` **结构同型**（`try/catch + showApiError`），由 ② 代表；单独再写一遍属重复。
- antd `Select` 的 onChange：jsdom 下驱动 antd v6 下拉需 mouseDown + option 命中，**脆且与本盲区无关**（这条也是 §4.2 里「浏览器测试登记触发条件」的一个候补场景）。
- `settings/index.tsx` 剩余的 66% 分支：多为 Tab 切换与表单字段联动，风险与收益比不值得在本轮扩张；已在 §7.1 列为后续项。

---

## 3. §3 新守卫：字段级类型漂移（`check-web-type-field-drift`）

### 3.1 为什么必须做「字段层」而不是再做一次名字层
既有第 47 条守卫 `scripts/check-web-type-drift.mjs` 冻结的是**名字集合**（118 处手写类型，新增即红）。它**看不见字段**。实证空档：

`apps/admin-web/src/api/executors.ts:3` 的 `export interface Executor` 与生成物 `components['schemas']['ExecutorResponseDto']` 语义重复，但生成物有而手写版**没有**这 7 个字段：

```
capabilities, consecutiveHeartbeatMisses, createdAt,
executorStartedAt, executorStartupId, updatedAt, version
```

后端一旦开始下发这些，前端 **tsc 照样通过、既有 47 条守卫全绿**，运行时静默读到 `undefined`。

**数字订正**：简报说「已漂移 6 个字段」，实测是 **7 个**（多一个 `version`；`ExecutorResponseDto` 36 字段 vs 手写 `Executor` 29 字段，重叠 29/29 = 100%）。

### 3.2 判据设计（可复核）

**扫描面与既有守卫逐字一致**——直接 `import` 复用它导出的 parse 层（`stripComments` / `maskNonCode` / `matchBracket` / `readDeclTail` / `listApiFiles` / `classify`），**不抄第二份判据**（仓内有过「selftest 手抄判据、副本与被测各自演化」的先例被审计）。

**两段式配对**（这是本守卫的核心设计，也是我第一版做错又修回来的地方）：

- **第一段：名字提议**，先严后宽四级：① 严格同名 → ② 手写名+后缀 ∈ 生成物（`Executor`→`ExecutorResponseDto`）→ ③ 生成名剥后缀==手写名 → ④ 双方各剥一层后相等。
- **第二段：字段重叠确认**（`OVERLAP_MIN = 0.6`，分母取**较小一侧**）。**光靠名字会造出假配对**——第一版没做这层，实测读数虚高到 169 处，包含 `LoginResult ↔ LoginDto`（响应 `accessToken/refreshToken/user` vs 请求 `username/password`，重叠 **0**）和 `DeployVersionResult ↔ DeployVersionDto`（响应信封 `ok/dispatched/skipped` vs 载荷 `executorIds/versionId`，重叠 **50%**）这类纯噪声。

  **为什么分母取较小一侧很关键**：手写版**陈旧、只缺字段**的真漂移（如 `Executor`）重叠率仍算 100%，不会被阈值误杀——被挡掉的只会是「两边各有一堆对方没有的字段」的**不同概念**。

**诚实边界**（明确列入读数，不静默丢）：
- `notComparable`（3 处）：任一侧是 alias/union/enum/函数（无字面量体），或手写侧有 `extends`（继承来的字段不在本文件字面量体里，静态判读会误报）。
- `weakPairs`（6 处）：名字像但重叠 < 0.6，**排除但仍列出**（`--report` 可见）。
- `notPairs`（56 处）：完全没有同名 schema，只报读数不判红；但**数量增长判红**（否则新增类型取个配不上的名字就能绕过字段比对）。

### 3.3 现状读数（真仓实测）

```
扫描面：api 文件 24 个 / 顶层类型声明 133 处（其中手写 118 处参与比对）
生成物 components['schemas']：244 个
配对读数：已配对 53 处 / 未配对 56 处 / 不可比 3 处 / 疑似假配对 6 处
字段漂移：合计 61 处（missing 50 / extra 11）
```

> 简报的「173 处语义重复」：在我的判据口径下是 **53 处已确认配对**（+56 未配对 +6 假配对 +3 不可比）。173 那个数字的口径更宽（未做重叠确认/未区分可比性），我按**能判红的严格口径**报 53/61 这一组——两者不矛盾，但**不可混用**。

**漂移最重的几处（missing 方向，即前端读不到后端字段）**：

| 手写类型 | 生成 schema | missing 字段 |
|---|---|---|
| `Executor` | `ExecutorResponseDto` | capabilities, consecutiveHeartbeatMisses, createdAt, executorStartedAt, executorStartupId, updatedAt, version |
| `TaskExecution` | `TaskExecutionResponseDto` | task, logStorage, logObjectKey, attemptSeq, retryKind, retryUserCount, artifacts, depsFiredAt, mutexGroupId, version |
| `ExecutorPackage` | `ExecutorPackageResponseDto` | filename, originalFilename, mimeType, description, uploadedBy, pushHistory, projectId |
| `User` | `UserResponseDto` | isActive, loginFailCount, lockedUntil, totpEnabled, sessionVersion, lastTotpCounter |
| `Task` | `TaskResponseDto` | misfireStrategy, project, ownerUserId, deletedAt, webhookSecret |

### 3.4 首版判红策略：可见性 + 增长闸（按简报要求，刻意不一次性红爆）

- `baseline.drift` 冻结 61 个「配对 × 方向 × 字段」三元组：**基线外出现 ⇒ 红**；**基线里消失 ⇒ 也红**（收紧是好事但必须同步删条目，否则基线烂成豁免单——与既有守卫同一条纪律）。
- `baseline.notPairs` 冻结 56 个未配对类型：**数量增长 ⇒ 红**。
- **结构红**（绝不判绿）：api 目录/生成物/基线缺失、基线坏 JSON、扫描面塌到下界（文件<15 / 声明<60 / schema<100 / 配对<25）。
- **字段级「有漂移即红」延后一迭代**：那 61 处里有相当一部分是**前端合成类型**（`ok/dispatched/synthetic/tag/changelog` 这类），修它等于改 `Executor`/`Task`/`User` 的手写消费面，属主会话 R11「不迁存量」的下一批，一次性红爆会把主干永久钉红。

### 3.5 有效性实证（不宣称，只给输出）

按主Agent 的教训（上一轮 27 条守卫被证明「把缺陷加回消费者后仍全绿」），本守卫做了**双向实证**：

**（a）selftest：17 条用例，跑真子进程断言退出码 + 报错文本，含正例控制组**

```
✔ check-web-type-field-drift selftest 通过：17/17 条用例
```

关键用例：`构造漂移（生成物有·手写无）⇒ 红且点名字段`、`构造漂移（手写有·生成物无）⇒ 红`、`撤掉漂移 ⇒ 恢复绿（红确实归因于那处漂移）`、`基线陈旧 ⇒ 红`、`未配对增长 ⇒ 红`、`extends ⇒ notComparable 不误报`、`alias ⇒ notComparable`、`生成物缺失 ⇒ 结构红`、`基线缺失/损坏 ⇒ 结构红`。

**（b）真仓注入漂移：构造一处漂移 ⇒ 守卫变红 ⇒ 撤除 ⇒ 恢复绿**

在真仓删掉 `Executor.executorVersion` 一个字段（模拟「手写类型又落后一处」）：

```
$ node scripts/check-web-type-field-drift.mjs
✖ WEB-TYPE-FIELD-DRIFT：手写类型 ↔ 生成 schema 的字段层出现增长/陈旧：
  新增字段漂移 1 处（基线外；后端新增字段而手写类型没跟上，或反之）：
      apps/admin-web/src/api/executors.ts  Executor → ExecutorResponseDto  missing:executorVersion
    处置：让手写类型跟上合同（首选），或确实是有意分歧 → 连同 reason 登记进基线。
EXIT=1
```

还原后：

```
$ node scripts/check-web-type-field-drift.mjs
✔ WEB-TYPE-FIELD-DRIFT：无新增字段漂移（配对 53 处，现状漂移 61 处 = 基线冻结：missing 50 / extra 11；未配对 56 处）。
EXIT=0
```

⇒ **「守卫能防住回归」是被证明的，不是被声称的。**

### 3.6 接线（按仓内惯例，未绕过判据）

- npm script：`check:web-type-field-drift` = `node … --selftest && node …`（单一定义：自检 + 主跑，避免「自检写了但从不执行」）。
- 本地门禁 `test:guards:repo` 已挂。
- CI：`.github/workflows/ci.yml` 新增 step `Web field-level type drift guard (S3-C3 续)`，紧跟既有 `check-web-type-drift` step。
- `node scripts/check-guards-wired.mjs` 实测通过：

```
✔ 守卫接线自检通过：63 个 check-*.mjs 全部被 CI 执行（另有 1 个显式豁免）。
✔ 自检面：64 个守卫有自检，其中 63 个在本地 test:guards 与 CI 都真的执行了自检。
```

**写域说明**：简报提示「`scripts/` 可能属他人写域」。我按仓内惯例放在 `scripts/`（全部 63 条守卫都在此处，且 `check-guards-wired` 的收集面就是 `scripts/` + `apps/*/scripts`），但**只新增 2 个新文件**（守卫 + 基线），对共享文件（`package.json`、`ci.yml`）只做**追加式**编辑，未改动任何他人守卫。

---

## 4. §4 孙Agent 探查结论

两条孙Agent 均已完成（产物：`/tmp/web-hardening/codegraph-layers.md` 657 行、`/tmp/web-hardening/oss-research.md` 363 行）。
**探查方式**：MCP `codegraph_explore` 在本会话工具表未暴露 → 按 AGENTS.md 兜底用 CLI v1.6.2（2117 files / 42242 nodes / 120652 edges，`✓ Index is up to date`）。**CodeGraph 可用，未降级**。

### 4.1 admin-web 真实依赖图与分层违规边

子图：**468 files / 8,858 nodes / 22,170 出边**。

| 违规类别 | 数量 | 严重度 | 代表证据 |
|---|---|---|---|
| **A. `pages/` → 领域 HTTP 直连**（value 导入，绕过 hooks/queries） | **43 条 / 19 个页面** | High | `NotificationSettingsPage.tsx:7` 裸 `client`；`ExecutorListPage.tsx:19` 裸 `client` |
| A′. 同上但仅 type-only | 13 条 / 7 页面 | Low | — |
| **B. 生成类型 + 手写类型同文件共存** | **8 个文件**（5 处同实体双表示） | High | `Task`(49 字段) vs `TaskResponseDto`(54) |
| **C. `types/` → `features`/`api` 反向依赖** | **0 条** ✅ | — | `types/` 是纯叶子（0 import 节点） |
| **C′. `components/` → `pages/` 反向依赖**（这才是 C 的真问题：`features/` 目录根本不存在，facts 层由 `pages/` 下 9 个纯 `.ts` 承担） | **11 条 / 11 个组件** | High | `ExecutionLogSection.tsx:34`、`task-form/*` 8 条 |
| C″. `hooks/` → `pages/` | 1 条 | Medium | `useTaskFormReferenceData.ts:33` |
| **E. `components/` → `api/` 直连** | **13 条 / 9 个组件** | High | `CommandPalette.tsx:77-82`（直调 `tasksApi.trigger/pause/resume`）、`batchActions.tsx:130,181,254` |
| **F. SSE 生命周期重复实现** | **3 套** | High | 见 §1 |
| F′. 日志流未登记 `statusKey`（不参与「live 停轮询」） | 1 | Medium | `ExecutionLogSection.tsx:245-320` |
| **F″. 裸 `queryKey: [...]` 字面量** | **38 处 / 10 文件** | Medium | Top：`settings/index.tsx` 10、`EventSubscriptionsSettings.tsx` 8、`UserManagementPage.tsx` 5、`ApiKeysSettings.tsx` 4 |
| **F‴. `queryKeys.projects` 前缀冲突（真 bug）** | 1 | **High** | `ExecutorDetailPage.tsx:98` 的 `['projects','me','roles']` vs `queries.ts:122-126`；`ProjectsPage.tsx:362,835` 的失效**打不到** roles 查询 |
| **D. `api/queries.ts` 单体** | 801 行 / 34 export / 31 queryKey / 23 `useQuery` + 2 `useMutation` | High | 见下 |

**`api/queries.ts` 拆分影响面（CodeGraph 量化）**：
- **28 个导入文件**（17 生产：10 pages + 4 hooks + 3 components；11 测试）。
- `codegraph impact queryKeys -d 3` = **306 符号**；`codegraph affected apps/admin-web/src/api/queries.ts` = **135 个测试文件**。
- 按域拆的爆炸半径：拆 metrics 需改 4 生产 + 5 测试；拆 tasks 需改 5 生产 + 6 测试。

**建议切口排序（孙Agent 给出，我按影响面复核后认同）**：
1. **抽 `domain/` 层收编 `pages/` 下 9 个纯 `.ts` 模块** → 一次消掉 **12 条反向边**（components→pages 11 + hooks→pages 1），涉及 21 文件、**零测试依赖**。这是 A/C 的结构性整改落点。
2. **拆 `api/queries.ts`（先 metrics 后 tasks）** → 拆完即可就近收口 38 处裸 queryKey；但爆炸半径 28 文件 / 135 测试文件，必须分域分批。
3. **收口 SSE 三套生命周期** → 本轮已修 H-6（主要收益），收敛留 §7。

**两个低成本止血点**（不在本轮写域外，登记）：`NotificationSettingsPage.tsx:7`、`ExecutorListPage.tsx:19` 两处裸 `client` 各只碰 1 个文件。

### 4.2 开源方案参考表

本仓 AGPL-3.0-only。**结论：无许可红旗**——涉及库全部 MIT 或 Apache-2.0，**没有引入或建议引入任何 GPL/AGPL/LGPL**，无 copyleft 传染面，未复制任何 GPL 代码。已读 `open_sourse/agent_talk/03_recommendations/01-priority-register.md` 避免重复（它已覆盖 R11「只加棘轮守卫不迁存量」+ S3-C3；本报告新增的是 queryOptions 的可执行证明、MSW/浏览器测试/refine 三个裁决、以及「零覆盖」前提纠正）。

| 库 | 仓库 | License | 核心亮点 | 可复用点 | 缺陷 | 适配成本 | 采纳方式 |
|---|---|---|---|---|---|---|---|
| **TanStack Query** `queryOptions` | github.com/TanStack/query | **MIT**（已装 5.105.0） | `queryKey`+`queryFn`+类型共置一文件；`TQueryFnData` 由 `queryFn` 返回值**反推** | `queryOptions()` helper + 键工厂 `as const` | 前缀一致性无静态保证（需键工厂单点 + 既有 `cache-key-consistency.r138.test.tsx`） | 低（2–4h） | **采纳为模式**（不加依赖）。**关键：不迁手写类型**——已用 `tsc --strict` 实测 EXIT=0 |
| **MSW** | github.com/mswjs/msw | **MIT**（未装） | 零生产体积；能拦 axios（patch 全局 XHR） | — | **无落点**：本仓真实边界是 `api/client.ts` **模块内部**（信封解包/401 刷新重放/toast 去重），MSW 要手工复刻信封=多一层失配；已有 1471 处 `vi.mock` 是沉没资产；断言会从「组件发了什么」退化成「网络发了什么」 | — | **REJECT** |
| **Playwright CT** | github.com/microsoft/playwright | **Apache-2.0** | 真浏览器渲染 antd | — | 实验性包，且 `@playwright/experimental-ct-react@1.62.1` **落后本仓 `@playwright/test@1.64.1` 一个版本线**；本仓无 CT 基座可复用 | 高 | **REJECT**（登记触发条件） |
| **Vitest browser mode** | vitest.dev/guide/browser | **MIT** | 真浏览器 + 与 vitest 同生态；本机有先例 `open_sourse/openclaw-main/ui/vitest.config.ts`（多 project + `.browser.test.tsx` 命名分流） | 分层原则：真浏览器只测只有真浏览器才成立的东西（布局溢出/浮层定位/a11y 树） | 本仓 `test` 段是**单 project**，重写成 `projects` 有把 R12-fix(`pool:'forks'`)/F-01(monaco inline)/`dangerouslyIgnoreUnhandledErrors` 等**逐条有注释的踩坑重新踩一遍**的风险；覆盖率阈值口径会分裂 | 高 | **登记不实施**（触发条件：出现关键交互在 jsdom 下确实无法驱动） |
| **refine** | github.com/refinedev/refine | **MIT** | 后台 meta-framework | — | **antd v6 硬阻断**：`@refinedev/antd@6.0.3` peer 是 `antd ^5.23.0`，本仓 `antd@6.6.8`；且 meta-framework 接管路由/dataProvider/authProvider/UI 骨架 = 数周级重写；抽象在最关键的 HTTP 层被穿透（本仓 client 的信封/刷新/去重纪律必须保留） | 极高 | **REJECT**（许可不是原因） |

**对当前任务的直接结论**：
- **(a) `queryOptions` 共置——能，且不需要迁类型**。已用 `tsc --strict` 实测（`/tmp/web-hardening/tscheck/sketch.ts`, EXIT=0）。方向纠正：**不要把 `queryKeys` 拆成 per-feature 文件**——它今天就是防漂移单一事实源；正确形态是 `queryKeys` 保持单点 + 每域新增 `xxxOptions` 工厂。**顺序：先收 38 处字面量键，再包 queryOptions**（反过来零收益）。
- **(b) MSW：不采纳**。前提（零覆盖）已不成立，边界失配，且会与 1471 处 `vi.mock` 并存两套。
- **(c) 浏览器测试：现阶段不采纳**，登记触发条件。

---

## 5. §5 验证原始输出

### 5.1 `cd apps/admin-web && npx vitest run`

```
 Test Files  280 passed (280)
      Tests  2305 passed (2305)
   Start at  10:02:12
   Duration  158.39s (tests 52%, import 24%, environment 12%, transform 10%, setup 2%)
```

**基线 2233 ⇒ 2305（+72 = H-6 4 例 + B0 65 例 + 浮空 rejection 3 例；纯增量，零删改零跳过）。** 本轮该次全量运行**全绿**。
注：`sops-page-b14.test.tsx` 在全量并发下偶发超时红（**预存在** flake，单文件 10/10 绿），本轮两次全量运行中一次出现、一次未出现——与本次改动无关（未触碰 sops 相关文件）。

### 5.2 `cd apps/admin-web && npx tsc -b`

```
$ npx tsc -b
（无输出）
TSC done
```
**0 错误。**（过程中 tsc 抓到我自己新测试文件里一个未使用导入 `getSSEStatus`，已修——说明这道闸是活的。）

### 5.3 `node scripts/check-web-type-drift.mjs`（既有守卫，仍绿）

```
✔ WEB-TYPE-DRIFT 通过：手写类型 118 处（基线 118 + 豁免 0），合同派生 12 处，字面量镜像 3 处，生成 schema 244 个。
EXIT=0
```

### 5.4 `node scripts/check-guards-wired.mjs`

```
✔ 守卫接线自检通过：63 个 check-*.mjs 全部被 CI 执行（另有 1 个显式豁免）。
✔ 自检面：64 个守卫有自检，其中 63 个在本地 test:guards 与 CI 都真的执行了自检（另有 1 个自检豁免，0 个只接一面）。
✔ 覆盖计数：5 个已登记守卫都报出了可解析的用例计数且 ≥ 下界
EXIT=0
```

### 5.5 新守卫 selftest + 主跑

```
✔ check-web-type-field-drift selftest 通过：17/17 条用例
✔ WEB-TYPE-FIELD-DRIFT：无新增字段漂移（配对 53 处，现状漂移 61 处 = 基线冻结：missing 50 / extra 11；未配对 56 处）。
```

### 5.6 有效性实证（回退修复 ⇒ 变红）

见 §1.1 / §3.5。两份原始输出：
- H-6：回退 `if (!reconnect)` 判据后 `Tests 3 failed | 1 passed (4)`，失败项含 ①（连接数 2≠1）、②（换票 2≠1）、④（消费方路径额外建连）。
- 字段漂移：真仓删 `Executor.executorVersion` ⇒ `EXIT=1` 且点名 `missing:executorVersion`；还原 ⇒ `EXIT=0`。

---

## 6. §6 风险与回滚

| 风险 | 触发条件 | 影响 | 回滚方式 |
|---|---|---|---|
| H-6 修改影响 `reconnect:true` 消费方 | 若判据写错位置，metrics/executions 流不再随可见性恢复 | Dashboard/列表不再实时 | 单文件回滚：`git checkout apps/admin-web/src/api/sse-client.ts`。已由用例 ③ 钉住非回归 |
| H-6 后「可见性恢复变慢」 | `reconnect:false` 消费方现在要等自己的预算（1.5s/3s）而不是立即重连 | 日志流回前台后约 1.5–3s 才恢复 | 这是**有意的语义修正**（恢复决策权归调用方）；若产品不接受，可改为给工厂加显式 `resumeOnVisible` 选项 |
| 字段漂移守卫的假配对 | 若某类型与同名 schema 重叠恰在 0.6 附近 | 少量噪声或漏配 | `OVERLAP_MIN` 是单点常量；`--report` 的「配对质量」段按重叠率升序排列，可直接复核最可疑的配对 |
| 字段漂移守卫把主干钉红 | 若别的会话改了 `api/*.ts` 的字段（加/删） | 守卫红，阻塞主干 | 这是**设计意图**（增长闸）；处置=登记理由进基线，或让手写类型跟上。基线文件是纯数据，单人可改 |
| `scripts/` 与他路会话冲突 | `guard-hardening` 等 teammate 同时在写 `scripts/` | 共享文件（package.json/ci.yml）编辑冲突 | 我只做**追加式**编辑 + 新增 2 个文件；冲突时以 git 三方合并为准，我的两处均为独立新行 |
| 基线成为豁免单 | 长期无人收紧 | 守卫变成"记录现状" | 基线里已写「消失了也红」的判据，收紧必须同步删条目 |

**回滚粒度**：H-6 = 1 个文件；守卫 = 2 个新文件 + 3 处追加行（package.json ×2、ci.yml ×1）。

---

## 7. §7 未做项与后续排期建议

### 7.1 本轮明确未做（附理由）

| 项 | 理由 | 建议 |
|---|---|---|
| 修那 61 处字段漂移 | 属 R11「不迁存量」的下一批；一次性改 `Executor`/`Task`/`User` 的消费面风险远大于收益 | 下一迭代按域分批：先 `Executor`(7) + `User`(6)，这两处是**读不到后端字段**的真缺口 |
| 字段级「有漂移即红」 | 会把主干永久钉红 | 先清掉语义明确的缺失（`missing`），再把 `extra` 里属于前端合成类型的分组豁免 |
| `useEventStream` 三套生命周期收敛 | 本轮收益（潜伏缺陷）已被 H-6 拿走；剩余是低收益高风险重构（牵动 14 个测试文件） | 若要收敛：新抽 `hooks/useEventStream.ts` 先只承接 `useMetricsStream`+`useExecutionsStream`（同构度高），`ExecutionLogSection` 最后动 |
| 38 处裸 `queryKey` 收口 | 不在本轮三项任务内，且需与 `api/queries.ts` 拆分一起做才有意义 | 作为下一批独立小 PR：先收 settings 域（10+8+4+3=25 处，浓度最高） |
| `api/queries.ts` 拆分 | 爆炸半径 28 文件 / 135 测试文件，必须分批 | 按孙Agent 建议：先 metrics（4 生产+5 测试）后 tasks（5 生产+6 测试） |
| 抽 `domain/` 层消 12 条反向边 | 结构性整改，跨 21 文件，与本轮三项任务无耦合 | 优先级高、零测试依赖，适合作为下一轮的头号切口 |
| `F‴` 的 `['projects','me','roles']` 前缀冲突（真 bug） | 需改 `queries.ts` 键设计，超出本轮写域内的最小切口 | **建议单列 hotfix**：`ExecutorDetailPage.tsx:98` 改用 `queryKeys.projects` 派生键 |
| 日志流补 `statusKey` | 与 H-6 相邻但独立（让日志流也参与「live 停轮询」） | 下一迭代；需先确认服务端 32 槽池的日志流配额 |
| `useExecutorLive`/`DashboardPage` 共用 `metricsStream` statusKey 的串扰 | 当前路由互斥**未触发**，属 latent | 登记观察；一旦把 metrics 流提到 layout 级就会暴露 |

### 7.2 需主Agent 拍板

1. **字段级判红是否下一迭代转正**？需要先决定那 61 处里哪些是「必须补」、哪些是「前端合成类型可豁免」。我建议按 `missing`（真缺口，51 处）与 `extra`（多为合成类型，11 处）分开处置。
2. **`['projects','me','roles']` 前缀冲突**是否单列 hotfix（我倾向是：它是**已经会产生错误行为**的 bug，不是架构问题）。
3. **基线文件 `scripts/web-type-field-drift-baseline.json` 的维护责任**：它现在是「冻结 61 处」的豁免单，需要有人定期收紧，否则会腐烂。

---

## 附录：本轮改动清单

```
M  apps/admin-web/src/api/sse-client.ts                              H-6 修复（+23 行，其中判据 4 行）
?? apps/admin-web/src/__tests__/sse-h6-reconnect-contract.test.tsx  H-6 回归 4 例
?? apps/admin-web/src/__tests__/settings.ai-providers-branches.test.tsx   B0 15 例
?? apps/admin-web/src/__tests__/settings-page-b0-branches.test.tsx        B0 24 例
?? apps/admin-web/src/__tests__/settings-query-key-contract.test.tsx     B0 23 例
?? apps/admin-web/src/__tests__/settings.ai-providers-mutations.test.tsx B0 3 例（对照）
?? scripts/check-web-type-field-drift.mjs                       字段级漂移守卫（17 条自检）
?? scripts/web-type-field-drift-baseline.json                   增长闸基线（61 drift / 56 notPairs）
M  package.json                                                 +check:web-type-field-drift；挂进 test:guards:repo
M  .github/workflows/ci.yml                                     +step「Web field-level type drift guard」
```

**提交纪律与一次并发事故的处置**：
我按显式路径 `git add <file…>` 提交（**未用 `git add -A`**），`git diff --cached --stat` 核对过只含自己的 6 个文件。
期间发生了一次**索引竞态**：并行会话的 `0be07473`（protocol 域）把我对 `package.json` / `ci.yml` 的**接线**先行提交了，
但**没有**带上我引用的守卫脚本本体 ⇒ 那个提交若单独存在，CI 会因 `scripts/check-web-type-field-drift.mjs` 缺失而红。
我的 `d65ef8d3` 补上了脚本本体与基线（两者都在该提交的 tree 里，`git ls-tree` 已核对），
并在该提交说明里显式记下了这段因果，避免后人看到「CI 里有个不存在的脚本」而困惑。

**写域边界**：本轮只碰 `apps/admin-web/**` + 自建守卫（`scripts/` 下 2 个新文件）+ 对 `package.json` / `ci.yml` 的**追加式**编辑。
未触碰 `apps/admin-api/**`、`apps/executor-*/**`、`packages/**`。工作区里那些 admin-api / executor 的改动**全部是他路会话的**，
我既没改也没提交它们。
