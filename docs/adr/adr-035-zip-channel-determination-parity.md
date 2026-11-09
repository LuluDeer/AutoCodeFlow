# ADR-035: zip 渠道判定的两端对齐——歧义行归谁

状态：Proposed（设计已定稿；**本轮零实现改动**，只出 ADR）
- 日期：2026-11-06
- 决策来源：R75（承接 R74 中 W4 实测出的两端口径分叉）
- 相关 ADR：[ADR-020](adr-020-agent-boundary-model.md)（工具/渠道的显式信号优先）、[ADR-026](adr-026-conditional-state-writes.md)（条件化写）
- 契约事实源：`docs/design/python-task-upload-and-multiversion/CONTRACT.md` §2.1 / §2.4；`packages/executor-protocol/protocol.json` 的 `task.codeSource` 段（`:1398`）

## 1. 动机

### 1.1 两处判定（不是「一处对一处错」，而是**同一个问题的两个答案**）

| 端 | 位置 | 判定条件 |
|---|---|---|
| admin（中台，**派发时**决定走不走 zip） | `apps/admin-api/src/modules/executor/executor.service.ts:5465`–`:5467`（`resolveDispatchTask` 的 `isZipChannel`） | `codeSource === 'application_zip'` **或**（`codeSource == null` **且** `applicationId` 非空） |
| python（执行器，**接单时**决定走不走 zip） | `apps/executor-python/routers/execute.py:2318`（`_zip_channel_enabled`） | `codeSource === 'application_zip'` **或**（无 `codeSource` **且** `applicationId` **且** `packageUrl` 三者同时存在） |

⇒ 差在**第三个条件**：`packageUrl`。歧义行 =「**无 `codeSource`** + **有 `applicationId`** + **无 `packageUrl`**」：

- admin 判**是** zip ⇒ 去 `applications` 解析 `packageUrl` ⇒ **解析不到 ⇒ 派发失败**（`PACKAGE_URL_NOT_CONFIGURED` 一类，见 `executor.service.ts` 的 `resolveDispatchTask` 失败分支）；
- python 判**否** ⇒ 按普通任务照常跑（不下载、不建 venv）。

### 1.2 现场后果（为什么这不是「纸面差异」）

1. **admin 派发失败 / python 照常跑**：同一行任务，admin 侧在**派发期**就拒了（用户看到的是「派发失败 + 指向 application 的消息」），而若该任务绕过 admin 直接进 python（pull 队列的历史积压、队列重投、admin 重启后恢复），python 会**照常执行**。
2. **错误消息指向错误的实体**：admin 的失败消息说「应用不存在 / packageUrl 未配置」，而真实原因是「这一行**根本不是** zip 任务」（歧义列 `applicationId` 是残留弱引用）。这与 `executor.service.ts:5456`–`:5460` 那段注释里已经警惕过的「存量 git/glue 行的 applicationId 弱引用未清 ⇒ 误进 zip 路径」是**同一个坑的两端**。
3. **「静默按普通任务跑」也不安全**：python 判非 zip ⇒ 不下载 zip ⇒ 但 `applicationId` 非空的任务**本就该**是 zip 渠道（`CONTRACT.md:245` 的存量回填优先级：`applicationId NOT NULL → application_zip`）⇒ python 侧那条「无 packageUrl 就不是 zip」的规则**与契约的存量回填语义相反**。

### 1.3 为什么 admin 侧**不**带 `packageUrl` 条件（这是关键，不能想当然）

admin 的判定发生在**派发时刻**：`packageUrl` **不在任务行上**，它在 `applications` 表上（`executor.service.ts:5420`–`:5422` 的注释：任务实体只持 `applicationId` 弱引用，执行器拿到 task 后无法自行查库）。⇒ admin 在判定时**手上还没有** `packageUrl` —— 它是**判定之后**才去解析出来的。

⇒ 所以「admin 多一个 `packageUrl` 条件」在 admin 侧**物理上不成立**：那会导致**先有鸡还是先有蛋**（要判 zip 才知道要查 packageUrl，要查 packageUrl 才知道是不是 zip）。**这直接决定了对齐方向：admin 侧是对的，python 侧需要改。**

## 2. 方案

### 2.1 判定哪一侧是正确语义

**admin 侧（`executor.service.ts:5465`）是正确语义**，依据三条：

1. **契约字面**：`CONTRACT.md:355`「若 `task.codeSource === 'application_zip'` **或** `applicationId` 非空，则查 `applications` 表解析 `packageUrl` 并附加到下发 task」；`CONTRACT.md:430`「zip 渠道（`codeSource=='application_zip'` **或** `applicationId` 非空）」——**两处都是 admin 口径，没有 `packageUrl` 条件**。
2. **存量回填语义**：`CONTRACT.md:245`「`applicationId NOT NULL → application_zip`」⇒ 「有 applicationId」**就是** zip 渠道的判据；`packageUrl` 是 zip 渠道的**下游产物**，不是它的判据。
3. **物理可行性**：如 §1.3 所述，admin 在判定时还没有 `packageUrl`。

⇒ **python 侧 `_zip_channel_enabled` 的 `packageUrl` 条件应当去掉**，与 admin 逐字对齐。

### 2.2 python 侧如何对齐

`_zip_channel_enabled(task)` 的判定改为：

```python
if code_source == 'application_zip':
    enabled = True
elif not code_source and application_id:
    enabled = True
else:
    enabled = False
```

**并连带修正它自己的 docstring**（`execute.py:2328` 那一段「刻意改看 `packageUrl` 这个 admin 生产出来的正向信号」的说法**随本次改动作废** —— 它与契约 §2.1/§2.4 冲突）。

**但有一个必须保留的差异**：python 侧仍需要知道「**要不要下载**」。去掉 `packageUrl` 条件后，python 判 zip 但**载荷里没有 `packageUrl`**（歧义行本来就没有）⇒ 下载环节必须**明确失败**而不是「静默按普通任务跑」。⇒ python 的下载前置检查（`execute.py:2222` 的 `application_zip 任务必须提供 packageUrl`）保持并让它是**那条路径的必然结果**：走 zip 渠道 ⇒ 载荷必须带 `packageUrl` ⇒ 不带 ⇒ 400。

⇒ **对齐后的语义**：两端**都**把「无 codeSource + 有 applicationId」判为 zip 渠道；区别只在**载荷缺 `packageUrl` 时怎么办**：
- admin：派发期解析不到 ⇒ 派发失败（消息指向 application）；
- python：accept 期载荷缺 `packageUrl` ⇒ 400（消息指向载荷）。

两者都是**显式拒绝**，不是「照常跑」⇒ 歧义行在两端**同结论**（都拒），且**拒绝原因各自指向本层能验证的事实**。

### 2.3 「消息指向」要不要也统一

**本轮不统一**（见 §6.4）：admin 说「应用不存在/packageUrl 未配置」、python 说「缺 packageUrl」，两者都诚实。要统一成一个跨端错误码需要协议加字段 ⇒ 属协议级变更，不在本轮。

## 3. 影响面

### 3.1 受影响的任务类型

| 任务形态 | 改前（python） | 改后 | 说明 |
|---|---|---|---|
| `codeSource='application_zip'` + 有 `applicationId` | zip | zip | 无变化 |
| 无 `codeSource` + 有 `applicationId` + **有** `packageUrl` | zip | zip | 无变化（歧义行的**正常**形态） |
| 无 `codeSource` + 有 `applicationId` + **无** `packageUrl` | **非 zip（照常跑）** | **zip ⇒ 400** | **唯一的行为变化**（歧义行） |
| 有 `gitRepo`/`glueSource`（写面互斥本应保证） | 非 zip（优先级让位 + ERROR 日志） | 非 zip（不变） | 优先级逻辑不动 |

⇒ **行为变化面 = 歧义行一种形态**。

### 3.2 失效半径（若改 python 侧）

- 受影响：**无 `codeSource` + 有 `applicationId` + 无 `packageUrl`** 的任务行。
  - 典型来源：① 迁移期回填遗漏（`applicationId` 有值而 `codeSource` 仍 NULL 且应用已被删 ⇒ `packageUrl` 查不到）；② 应用行被删但任务行的弱引用残留；③ 外部直写任务表。
- 改后这类任务**在 python 侧从「照常跑」变成「400」**。
- **风险方向**：这是**收紧**（少跑一个本该走 zip 却没包的调用），不是放宽。但它会让「admin 侧已经拒了的任务，python 侧也拒」⇒ 两端一致 ⇒ **消除**了「admin 派发失败但 python 照跑」的现场。
- **反向风险**：若某部署里 python 侧**绕过 admin**直接收单（pull 队列的历史积压），这类任务改前能跑、改后 400。⇒ 需要在灰度期观察 400 的量。

### 3.3 既有测试

| 位置 | 现状 | 影响 |
|---|---|---|
| `apps/executor-python/tests/` 里 `_zip_channel_enabled` 的用例（含 R74 新增的 accept 期闸用例、`test_application_id_with_package_url_enters_the_zip_channel` 等） | 以「有 packageUrl ⇒ zip」为正例 | **需新增**一条「无 packageUrl 的 applicationId 行 ⇒ 仍判 zip（并由下载前闸 400）」的用例；**既有正例不改** |
| admin 侧 `resolveDispatchTask` 的用例 | 已按 `applicationId` 判定 | **不改**（admin 侧是正确语义，本轮不动 admin） |
| `apps/admin-api/src/modules/task/task.service.ts:942`（写面 `isZip`） | 写面校验（`codeSource=application_zip` ⇒ applicationId 必填） | 不改（写面与派发面是两层） |

### 3.4 需要跨端对照判据（**本轮的关键产出之一**）

现状：**没有任何机器判据**比对两端对同一行任务是否走 zip 渠道 ⇒ 这个分叉能长期存活（R74 才被发现）。⇒ 需要一张**跨端表驱动判据**：

- 载荷形态取自**契约/写面枚举**（`codeSource` × `applicationId` × `packageUrl` × `gitRepo`/`glueSource` 的组合）；
- 两侧**各自真跑**（admin 的 `resolveDispatchTask` 走 ts-node 子进程、python 走 `python3`，与 `scripts/check-protocol-three-way.mjs` 的 admin 探针同款）；
- 逐组合比对「是否走 zip 渠道」，不一致 ⇒ 红。

## 4. 回滚

1. **单 commit `git revert`**：改动只在 python 侧的一个判定函数 + 一条用例；无迁移、无 schema 变更、无写库动作 ⇒ 无补偿动作。
2. **不需要特性开关**（明确取舍）：
   - 改的是**判定**，不是「两种行为可选」——改前后的语义**由契约裁定**（§2.1），不是二选一的产品口味；
   - 本仓已两次裁决「双轨开关 = 制度化的两种承诺」（ADR-032 §4.3 / ADR-033 §4.3）。给一个**契约已裁定**的判定加开关，是第三次犯同款错误；
   - 若真要灰度，正确的粒度是**先上判据**（§5 步骤 1：不改行为，只让分叉变红可测），而不是在代码里留两条判定路径。
3. **回滚的代价**：恢复「admin 拒 / python 跑」的不一致现场。⇒ 回滚窗口应尽量短（一次部署内），且回滚前最好已有 §3.4 的判据在跑（否则回滚后没人知道分叉回来了）。

## 5. 分步计划

### 步骤 1 · **先加跨端对照判据**（红→绿，但**不改任何行为**）

- **做**：新增一张**跨端表驱动判据**（§3.4）：载荷组合取自契约/写面枚举；两侧**各自真跑**（admin `resolveDispatchTask` 走 ts-node 子进程、python 走 `python3`），逐组合比对「是否走 zip 渠道」。判据落在 `scripts/`（**W1 域**）—— 本 worker 不改 `scripts/**`，故本步**需 Lead 代派**。
- **红→绿判据**：判据上线即**红**，且红点**恰好**是歧义行那一个组合（「无 codeSource + 有 applicationId + 无 packageUrl」）—— 若红点不止一个，说明还有别的分叉，先查清再动手。
- **失败如何退**：判据是纯新增（不改行为），失败就修判据本身。

### 步骤 2 · python 侧对齐（去掉 `packageUrl` 条件）

- **做**：改 `_zip_channel_enabled` 的判定（§2.2）+ 修 docstring + **新增**一条用例（「无 packageUrl 的 applicationId 行 ⇒ 仍判 zip」）。
- **红→绿判据**：python 定向 pytest ⇒ exit 0；**且**步骤 1 的跨端判据 ⇒ **由红转绿**（歧义行那格对齐）。
- **失败如何退**：单 commit revert。

### 步骤 3 · python 侧的「缺 packageUrl ⇒ 400」路径要显式

- **做**：确认歧义行进 zip 渠道后，**下载前闸**（`execute.py:2222`）给出 400 而不是任何降级；必要时补一条用例钉住「走 zip 渠道但载荷无 `packageUrl` ⇒ 400，不按普通任务跑」。
- **红→绿判据**：该用例先红（改后 python 已判 zip，但若下载前闸有降级分支则不红）⇒ 实现后绿。
- **失败如何退**：单 commit revert。

### 步骤 4 · 存量歧义行清账（运维面，独立一轮）

- **做**：一次性统计「无 `codeSource` + 有 `applicationId` + 无 `packageUrl`」的行数与形态（应用已删 / 回填遗漏 / 外部直写），决定是补 `codeSource`、清 `applicationId`，还是就地作废。
- **红→绿判据**：统计脚本的输出为空（该形态归零）⇒ 后续步骤 2 的收紧就不再影响存量。
- **为什么独立**：这是**数据面**变更（可能改任务行），与判定修正混在一次提交里会让回滚变复杂。

### 步骤 5 · 收口文档

- **做**：把「两端逐字同构 + 歧义行的处置口径」写回 `CONTRACT.md`（§2.4 那段现在只写了 admin 的口径，python 侧的偏离是**实现里的**、不是文档里的）；同步更新 `apps/executor-python/routers/execute.py` 的 docstring。
- **红→绿判据**：`npm run test:docs` ⇒ exit 0；且文档里不再有与实现不一致的描述。

## 6. 明确不做

1. **本轮不改任何实现**：admin 侧（正确语义）与 python 侧（待对齐）**都零改动**；本轮只出 ADR。
2. **不改 `scripts/**`**：§3.4 的跨端判据与 §5 步骤 1 需 Lead 代派（W1 域）。
3. **不改 `apps/executor-python/**`**：python 侧的实现改动排后续轮（步骤 2/3）。
4. **不统一两端的错误消息/错误码**：admin 说「应用/packageUrl」、python 说「缺 packageUrl」，各自诚实；统一要协议加字段 ⇒ 协议级变更，另立项。
5. **不改写面校验**（`apps/admin-api/src/modules/task/task.service.ts:942` 附近的 `isZip` 互斥校验）：写面与派发面是两层，写面已经保证「新行不会产生歧义形态」；歧义只存在于**存量**。
6. **不动 admin 的 `resolveDispatchTask`**：它是正确语义（§2.1），改它才是把契约改坏。

## 7. 替代方案（被否）

- **方案 B：改 admin 侧，加 `packageUrl` 条件**（即让 admin 也学 python）。否：① 契约 `CONTRACT.md:355`/`:430` 两处都写 admin 口径；② admin 在判定时**还没有** `packageUrl`（§1.3）⇒ 该条件物理上不可实现（要判才知道查、查了才知道判）；③ 会把「有 applicationId 但应用已删」的存量任务**静默降级**成普通任务跑完——那才是真正的「照常跑」。
- **方案 C：两端都改成「看 `packageUrl`」。** 否：同上，admin 侧不可实现；且 `packageUrl` 是下游产物，用它当判据是**因果倒置**。
- **方案 D：两端都改成「只看 `codeSource`，`applicationId` 不再参与判定」。** 否：会**放弃存量兼容**——`CONTRACT.md:245` 的回填优先级明确「`applicationId NOT NULL → application_zip`」，存量行的 `codeSource` 可能仍是 NULL；只看 `codeSource` 会让存量 zip 任务**静默退化成普通任务**（不下载包、跑错代码）。比现况更危险。
- **方案 E：只在 admin 侧修（让歧义行不再派发失败），python 不动。** 否：那是「让 admin 少拒」——把 §1.2 的现场**翻转到另一侧**（admin 照跑、python 也照跑，但跑的都不是 zip 渠道的语义）⇒ 依然是不一致，且更隐蔽（不报错 = 没人发现）。
- **方案 F：加一个 `AGENT_ZIP_CHANNEL_AMBIGUITY_*` 开关在 python 侧灰度。** 否：理由同 §4.2。

## 8. 关联

- 相关 ADR：[ADR-020](adr-020-agent-boundary-model.md)（显式信号优先）、[ADR-026](adr-026-conditional-state-writes.md)
- 契约与设计：`docs/design/python-task-upload-and-multiversion/CONTRACT.md`（§2.1 `tasks.codeSource`、§2.4 admin 派发与 python 下载）、`packages/executor-protocol/protocol.json:1398`（`task.codeSource` 的 schema 段）
- 既有实现：`apps/admin-api/src/modules/executor/executor.service.ts:5465`（admin 判定）、`apps/executor-python/routers/execute.py:2318`（python 判定）、`apps/executor-python/routers/execute.py:2222`（python 下载前闸）
- 计划项：R75（本 ADR）、R74（python 收单一入口时记录了本分叉）
