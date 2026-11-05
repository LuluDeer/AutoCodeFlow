# ADR-034: 网络类别表收敛到契约——三份手抄表 + 一层运行时别名，改为编译期同源

状态：Proposed（设计已定稿；**本轮零代码、零契约改动**）
- 日期：2026-11-06
- 决策来源：R70（承接 R67-W5 的可行性勘察 `artifacts/autonomy/R67-node/parity-plan.md`）
- 前置：[ADR-029](adr-029-metadata-addresses-outbound-deny.md)（恒拒表**已**用「契约 → 三端生成物」这套做法跑通，本 ADR 把同款做法推广到**类别表**）、[ADR-032](adr-032-python-switch-posture-parity.md)、[ADR-033](adr-033-admin-webhook-posture-parity.md)（两轮把三端的**决策**拉齐）
- 契约事实源：`packages/executor-protocol/protocol.json:2994`（`networkPolicy` 段起点）

## 1. 动机

### 1.1 三份类别表（各自一套标签体系）

| 端 | 类别定义位置 | 标签体系 |
|---|---|---|
| 契约 | `packages/executor-protocol/protocol.json:2994`（`networkPolicy`）——`:2997` loopback / `:3008` privateIPv4 / `:3018` linkLocal / `:3029` cgnat / `:3038` unspecified / `:3055` reserved / `:3063` ipv4Mapped | `loopback / privateIPv4 / linkLocal / cgnat / unspecified / multicast / reserved` |
| node | `apps/executor-node/src/lib/ssrf-guard.ts:205`（`RestrictedCategory` 联合）、`:245`（`classifyRestrictedIpv4`）、`:281`（`classifyRestrictedIpv6`）；**另一份重复声明**在 `apps/executor-node/src/git-repo-network-policy.ts:67` | 与契约逐字一致 |
| admin | `apps/admin-api/src/common/utils/safe-http.util.ts:483`（`AddressRisk`）、`:547`（`IPV4_DENY_SEGMENTS`）、`:610`（`IPV6_DENY_SEGMENTS`） | **粗标签**：`public / private-lan / loopback / link-local / restricted / reserved` |
| python | `apps/executor-python/network_policy.py:67`（`RestrictedCategory`）、`:108`（`classify_restricted_ipv4`）、`:348`（`category_allowed`） | 与契约逐字一致 |

### 1.2 已知的命名不一致（实测）

- **admin `restricted` = 契约 `cgnat`(100.64/10) + benchmark(198.18/15) 合并**（`apps/admin-api/src/common/utils/safe-http.util.ts:555` 的 `ipv4-cgnat` 段与 `:591` 的 `ipv4-benchmark` 段**共用** `risk: "restricted"`）；
- **admin `reserved` = 契约 `unspecified`(0/8) + `multicast`(224/4) + `reserved`(240/4) 合并**（`:549` / `:583` / `:599` 三段共用 `risk: "reserved"`）；
- node/python 的标签与契约**逐字一致**，所以 `198.18/15` 在 node（`ssrf-guard.ts:269`）与 python（`network_policy.py:144`）都归 `reserved`，在 admin 归 `restricted`。

**关键事实（决定了本 ADR 的性质）**：三端的**决策**今天已经逐格一致 —— `check:ssrf-three-way-matrix` 实跑「25 个地址 × 两端开关态、零豁免」，只有 **4 条标签不同而行为相同**。⇒ 本 ADR 的收益**不是修行为**，而是把「运行时归一」升级成「**编译期同源**」。

### 1.3 为什么会漂（改名/新增类别只改一处就漂）

现在同一个知识（「有这么几类、每类能不能被开关解锁、哪类算元数据」）被抄了 **4 份**（契约 + 三端）+ **1 层运行时翻译**（`scripts/ssrf-category-matrix.mjs:53` 的 `CATEGORY_ALIASES`，把 `private-lan→privateIPv4`、`link-local→linkLocal` … 归一后喂给三向比对）。

于是：

- **新增一类**（例如把 benchmark 从 `restricted` 拆成独立类）要改：契约 + 生成器（若有）+ node 的联合与分类器 + python 的联合与分类器 + admin 的 `AddressRisk` 与段表 + `CATEGORY_ALIASES` + 三端 spec —— **漏一处不报错**，只会在下一次跑 `check:ssrf-three-way-matrix` 时表现为一条新的标签差异，而那时已经很难判断「是这次改漏了，还是历史差异」。
- **改名**（例如 `linkLocal` → `link-local`）：契约改一处，三端全断（编译期不报，运行期落 `null`/`undefined`）。
- 现有的 meta 守卫（R68 的 `check:posture-matrix-tables`，见 `scripts/check-posture-matrix-tables.mjs`）只保证「三端各有一张**从契约读地址**的表、条数相同、不被硬编码」，**不校验类别定义本身**（它连放行/拒绝结论都不比对）。⇒ 覆盖的正是最不容易漂的那部分，而**最容易漂**的类别定义仍在三份手抄里。

**这正是 ADR-029 已经解决过的问题**：恒拒表当年也是三份手抄，后来收敛成「契约段 + 三端生成物（`apps/executor-python/generated/protocol_metadata_addresses.py` 等）」并跑到现在没再漂。本 ADR 只是把同一套做法推广到类别表。

## 2. 方案

### 2.1 契约新增 `networkPolicy.categories`（形状）

在 `networkPolicy` 下新增一段（**纯附加、只读消费**，不改任何线缆载荷形状）：

```json
"categories": {
  "$comment": "类别单一事实源。三端从此派生，不再各自手抄。endLabels 只解决历史标签命名，不参与判定。",
  "order": ["loopback", "privateIPv4", "linkLocal", "cgnat", "unspecified", "multicast", "reserved"],
  "allowedUnderPrivateNetwork": ["privateIPv4"],
  "metadataMembers": [],
  "endLabels": {
    "admin": {
      "loopback": "loopback",
      "privateIPv4": "private-lan",
      "linkLocal": "link-local",
      "cgnat": "restricted",
      "reserved": "reserved",
      "unspecified": "reserved",
      "multicast": "reserved"
    }
  }
}
```

三条设计要点：

1. **`allowedUnderPrivateNetwork` 是数组而不是每类一个布尔**：它与 `networkPolicy.switch.semantics` 是**同一句话的两种写法**（「开关的**唯一**效果是放行 privateIPv4」）。写成数组后，`switch.semantics` 里那句自然语言描述可以从它派生，**不再有第二处需要人同步的口径**。
2. **`endLabels` 只解决「历史标签命名」**，不做判定。它存在的唯一理由是 admin 的粗标签体系（§1.2）——**共享表不得强制 admin 拆细**，否则会改 `AddressRisk` 的语义，而那个字段被 `apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts` 与四向判据按标签读取。
3. **`metadataMembers` 先留空**：契约的恒拒表用「地址清单」（`networkPolicy.metadataAddresses`，`:3075`）而不是「类别」，因为**元数据不一定独占一类**（`100.100.100.200` 落在 cgnat 段里）。留这个字段是为了将来若出现「整类恒拒」时不必再加一段；**现在不填**，以免与 `metadataAddresses` 形成两套恒拒口径。

### 2.2 生成器如何产出（三端生成物）

沿用 **ADR-029 已验证的做法**：`scripts/generate-executor-protocol.mjs:589`–`:624` 那段「metadata 三端写出」是模板，照抄结构即可（同一份 `write()` 三次，TS 两份同文、Python 一份带 docstring）。

产出：

- `…/apps/executor-node/src/generated/protocol-categories.ts`
- `…/apps/admin-api/src/generated/protocol-categories.ts`
- `…/executor-python/generated/protocol_categories.py`

生成器必须先**校验**再落盘（与 metadata 块同款）：`categories.order` 非空、`allowedUnderPrivateNetwork` 的每个成员都在 `order` 里、`endLabels` 的每个键也在 `order` 里 —— 任一不成立就 `throw`（**空表 = 判据被关灯**，这是 `metadataAddresses` 块留下的先例）。

既有生成物的先例可直接引用：`apps/admin-api/src/generated/protocol-metadata-addresses.ts` 与 `apps/executor-python/generated/protocol_metadata_addresses.py`。

### 2.3 三端如何从生成物派生（**不许各抄一份**）

| 端 | 派生方式 |
|---|---|
| node | `RestrictedCategory` 由生成物的 `order` 派生（`typeof CATEGORY_ORDER[number]`）；`categoryAllowed()` 改为读生成物的 `allowedUnderPrivateNetwork`，**不再写死 `if (category === 'privateIPv4') return allowPrivate`**；`apps/executor-node/src/git-repo-network-policy.ts:67` 的**重复联合删掉**，改为从 `lib/ssrf-guard` 导入 |
| python | `RestrictedCategory` 由生成物派生（`Literal[...]` 或运行时校验）；`category_allowed()` 改为读生成物的 `allowedUnderPrivateNetwork` |
| admin | **保留粗标签**：`AddressRisk` 仍由 `endLabels.admin` 的**值集合**派生（`typeof ADMIN_LABEL_VALUES[number]`），段表的 `risk` 字段改用**契约键**再经 `endLabels` 反查（改的是「标签从哪来」，不是「标签是什么」） |

### 2.4 `CATEGORY_ALIASES` 如何退役

`scripts/ssrf-category-matrix.mjs:53` 的 `CATEGORY_ALIASES` 是**运行时翻译层**：把 admin 的 `private-lan` 译成契约的 `privateIPv4` 才能与另两端比对。

类别表进了契约、admin 的标签由 `endLabels` 声明之后，这层翻译就**没有信息量了**——它的内容恰好等于 `endLabels.admin` 的逆映射。⇒ 删掉 `CATEGORY_ALIASES`，改为「从生成物读 `endLabels` 再反查」。**这不是简化，是去掉第二份真理**：今天 `CATEGORY_ALIASES` 与 admin 的段表是两个人各写一遍同一件事，改一个不改另一个，比对脚本会静默算错。

## 3. 影响面

### 3.1 要改的文件（8 处，估算 +180 / −90 行）

| # | 文件 | 改动 | 估算 |
|---|---|---|---|
| 1 | `packages/executor-protocol/protocol.json` | 新增 `networkPolicy.categories` 段 | +35 |
| 2 | `scripts/generate-executor-protocol.mjs` | 照 `:589`–`:624` 的 metadata 块写三份类别生成物（含校验） | +40 |
| 3 | `apps/executor-node/src/lib/ssrf-guard.ts` | `RestrictedCategory` + `categoryAllowed` 改读生成物 | +8 / −18 |
| 4 | `apps/executor-node/src/git-repo-network-policy.ts` | 删 `:67` 的重复联合，改导入 | +2 / −12 |
| 5 | `apps/admin-api/src/common/utils/safe-http.util.ts` | `AddressRisk` 由 `endLabels` 派生；段表 `risk` 改契约键 + 反查 | +25 / −25（行为零变化） |
| 6 | `apps/executor-python/network_policy.py` | `RestrictedCategory` + `category_allowed` 改读生成物 | +8 / −15 |
| 7 | `scripts/ssrf-category-matrix.mjs` | 删 `:53` 的 `CATEGORY_ALIASES`，改读生成物 | +5 / −20 |
| 8 | 三端「表与契约逐字一致」自检各 1 条：`apps/admin-api/src/common/utils/posture-matrix.spec.ts`、`apps/executor-node/src/lib/posture-matrix.spec.ts`、`apps/executor-python/tests/test_posture_matrix.py` | 复用 R68 的表驱动位置 | 3 × 15 |

合计约 **+180 / −90**，其中 3 个生成物文件（约 60 行）不需人手维护。

### 3.2 受影响的既有断言/判据

| 判据 | 现状 | 影响 |
|---|---|---|
| `check:ssrf-three-way-matrix`（`scripts/ssrf-category-matrix.mjs` 的输出消费方，见 `scripts/check-ssrf-three-way-matrix.mjs:28` 的注释） | **25 地址零豁免**、4 条标签不同 | 标签改了来源，**4 条差异应当消失**（admin 经 `endLabels` 反查后与另两端同标签）。**这是本 ADR 的验收信号**：差异从 4 条变 0 条。若变多，说明 `endLabels` 写错 |
| `scripts/protocol-four-way-allowlist.json` | 按**标签**登记豁免（scope 带侧名 + `review_by`） | 标签换源后，按标签写的条目要逐条复核。该表的腐烂检测是「格变一致 ⇒ 要求删除条目」——**本 ADR 会让若干格变一致 ⇒ 那些条目必须同批删除**，否则守卫红。**这是预期的红灯，不是回归** |
| `check:protocol-sync` / 生成物 drift（CI 的 `executor-protocol-drift` job 重跑生成器并 `git diff --exit-code`） | 三个 metadata 生成物已在此机制内 | 三个新生成物**必须与生成器同 commit**；`apps/executor-node` 的 bundle `source-digest` 会再漂一次（历史规律，需同批回填） |
| `apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts` | 按 `AddressRisk` 标签断言 | admin 保留粗标签 ⇒ **断言不变**（这是选 `endLabels` 反查而非拆细的直接理由） |
| R68 `check:posture-matrix-tables` | 只查表存在/同量/不硬编码 | 不受影响（本 ADR 不新增/删除地址） |

### 3.3 失效半径（生成物与手写表不一致时）

| 失效形态 | 行为 |
|---|---|
| 生成器漏跑（代码改了生成物没更新） | CI 的 `executor-protocol-drift` job `git diff --exit-code` **红**（该机制已在 metadata 上跑了一年多） |
| 生成物与手写表**同时**存在且不一致 | 不允许：§2.3 要求三端**只**从生成物派生、删掉手写表。若实现时保留了手写副本 ⇒ 又回到今天的问题；判据是三端 spec 里那条「表与契约逐字一致」（§3.1 #8） |
| `endLabels` 写错（映射到不存在的标签） | 生成器校验 `throw`（§2.2）⇒ 构建期失败，**不进运行时** |
| 契约 `categories` 缺失/为空 | 生成器 `throw`（沿用 metadata 块的先例：「空表 = 判据被关灯」） |
| 运行时读到陈旧生成物 | 与今天读陈旧手抄表**同等风险**，不因本 ADR 变差；且生成物带「⚠️ 生成物，勿手改」头注，且 drift job 盯着 |

**结论**：失效半径没有扩大——所有新失效形态都落在**已有的** drift/校验判据内，且都表现为**构建期或 CI 红**，不是静默降级。

## 4. 回滚

1. **单次 `git revert`**：本轮改动**不含数据迁移、不含线缆协议变更**（§2.1 是纯附加的判定规则段），`git revert <sha>` 即回到「三份手抄表」状态。三端行为**本来就一致**（§1.2），所以回滚**不改变任何运行期行为**——这正是把「行为已一致」这件事先说清楚的价值：**它让回滚变成零风险操作**。
2. **生成物可重生成**：`node scripts/generate-executor-protocol.mjs` 是**幂等**的（既有 metadata 生成物的行为已证明：drift job 每天重跑并 `git diff --exit-code`）。回滚后重跑一次即恢复一致；若生成物被手改而漂移，重跑即修复——**不存在「生成物丢了就无法恢复」的情形**（`protocol.json` 是唯一事实源）。
3. **不需要特性开关**（明确取舍）：
   - 引入开关的目的是「让行为可以二选一」；而本 ADR 的**行为增量为零**（§1.2：三端决策已逐格一致，改的只是标签来源）。**没有两种行为可选，开关就是空转**。
   - 更重要的反例：本仓已两次裁决「双轨开关 = 制度化的两种承诺」（ADR-032 §4.3 / ADR-033 §4.3）。给一张**纯标签表**加开关，会重演同一形态，而且这次连「两种行为」都不存在。
   - 若生成物出问题，正确的处置是**回滚 + 重生成**（上面 1、2 条），不是「运行时切回手抄表」——后者意味着仓库里同时存在两套类别事实源，恰好是本 ADR 要消灭的东西。

## 5. 分步计划

**第一步只让一个端读生成物**（而不是三端一起换）——理由：三端里只要有一端先切换并跑绿，「契约段 + 生成器 + 生成物」这条链就被证明可用；此时其余两端仍是手抄表，**任何不一致都会被既有的三向检查立刻发现**（这是本仓现成的判据，不需要新写工具）。

### 步骤 1 · 加契约段 + 生成器 + 生成物，**只让 python 读**

- **做**：`protocol.json` 加 `categories`（§2.1）；生成器加三份生成物（§2.2，含校验）；`apps/executor-python/network_policy.py` 的 `RestrictedCategory` 与 `category_allowed` 改为读生成物。
- **红→绿判据**（机读）：先加一条「python 的类别集合 `==` 契约 `categories.order`」的自检（放进 `apps/executor-python/tests/test_posture_matrix.py`）⇒ **改前红**（现在 python 的类型是手写的联合，与生成物无关，断言取不到生成物 ⇒ 导入失败即红）；实现后 `python3 -m pytest apps/executor-python/tests/test_posture_matrix.py` ⇒ **exit 0**。
- **同批必须绿**：`node scripts/check-ssrf-three-way-matrix.mjs` ⇒ exit 0（python 换了来源但标签不变 ⇒ 4 条差异应当**仍是 4 条**，不是 0 条。**若不是 4 条 ⇒ 说明 python 派生写错了，停手**）。
- **失败如何退**：`git revert` 该 commit（纯附加段 + 一个端，无迁移）。

### 步骤 2 · node 两端（连带删重复类型）

- **做**：`ssrf-guard.ts` 的 `RestrictedCategory` / `categoryAllowed` 改读生成物；`git-repo-network-policy.ts:67` 的重复联合删掉、改导入。
- **红→绿判据**：先加「node 的类别集合 == 契约 `order`」自检（`apps/executor-node/src/lib/posture-matrix.spec.ts`）⇒ 改前红；改后 `npx jest`（node 侧定向）⇒ exit 0；`check:ssrf-three-way-matrix` 仍 exit 0 且**差异仍为 4 条**（此时只有 admin 的标签是粗的）。
- **失败如何退**：单 commit revert。

### 步骤 3 · admin 改「标签来源」（行为零变化）

- **做**：`AddressRisk` 由 `endLabels.admin` 的值集合派生；`IPV4_DENY_SEGMENTS` / `IPV6_DENY_SEGMENTS` 的 `risk` 字段改**契约键** + 经 `endLabels` 反查。
- **红→绿判据**：`apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts`（按标签断言）**逐条不变且全绿**——这是「行为零变化」的判据；再跑 `check:ssrf-three-way-matrix` ⇒ **差异从 4 条变 0 条**（本 ADR 的验收信号，§3.2）。
- **失败如何退**：单 commit revert（admin 回到手写标签，行为不变）。

### 步骤 4 · 删 `CATEGORY_ALIASES` + 清四向 allowlist + 三端自检收口

- **做**：删 `scripts/ssrf-category-matrix.mjs:53` 的 `CATEGORY_ALIASES`，改读生成物的 `endLabels` 反查；把 `scripts/protocol-four-way-allowlist.json` 里因「格变一致」而失效的条目**删掉**（该表的腐烂检测要求删除）；三端各加「表与契约逐字一致」自检。
- **红→绿判据**：`node scripts/check-protocol-three-way.mjs` ⇒ exit 0（allowlist 条目删干净）；`check:ssrf-three-way-matrix` ⇒ exit 0 且输出「差异 0 条」；三端 spec 全绿。
- **失败如何退**：单 commit revert（**注意**：allowlist 条目删除若与代码不同批回滚，守卫会因「格又变不一致」而红 —— 故本步骤的四件事**必须同一个 commit**）。

### 步骤 5 ·（可选，独立一轮）`switch.semantics` 文案从 `allowedUnderPrivateNetwork` 派生

- **做**：让契约里那句自然语言描述由 `categories.allowedUnderPrivateNetwork` 生成/校验，消除「同一句话写两遍」。
- **红→绿判据**：加一条自检「`switch.semantics` 提到的类别集合 == `allowedUnderPrivateNetwork`」⇒ 可机检。
- **不在步骤 1–4 内的理由**：它改的是**给人读的契约文案**，不影响任何端；独立成步可以把「代码收敛」与「文案收敛」分开评审。

## 6. 明确不做

1. **本轮不改契约**（`packages/executor-protocol/protocol.json` 零改动）、**不改三端代码**、**不改生成器**：本 ADR 只出设计与分步计划。
2. **不拆 admin 的粗标签**：`restricted`（cgnat + benchmark 合并）与 `reserved`（unspecified + multicast + reserved 合并）**保持现状**，靠 `endLabels` 反查。拆细会改 `AddressRisk` 的语义，而它被 `ssrf-deny-matrix.spec.ts` 与四向判据按标签读取 ⇒ 属独立立项。
3. **不 bump `versioning.currentProtocolVersion`**（仍是 9）：本段是**纯附加的判定规则**、只读消费、不改任何线缆载荷形状（与 ADR-029 的 `metadataAddresses` 同款）。但需在 `versioning.compatibilityMatrix` 补一句说明（§3.1 #1 的注记）。
4. **不把 `posture-matrix` 三张表的「结论比对」升级成跨端工具**：R68 已裁定「真跑发生在各端自己的 runner 里，探针只保表的存在与口径」，本 ADR 沿用该裁定、不改守卫。
5. **不解决 admin webhook 面与执行器面的策略分叉**：ADR-033 已收口；本 ADR 只动标签来源，不动任何 `allowedUnderPrivateNetwork` 的**值**。
6. **不引入运行时特性开关**（理由见 §4.3）。

## 7. 替代方案（被否）

- **方案 B：只在 `scripts/ssrf-category-matrix.mjs` 里加更多别名，把 4 条标签差异「归一」掉。** 否：那是把**第二份事实源**（`CATEGORY_ALIASES`）喂得更胖，让「标签不一致」这件事**更看不见**；本 ADR 要做的正是删掉它。
- **方案 C：让 admin 直接改用契约标签（拆细）。** 否：改 `AddressRisk` 语义会牵动 `ssrf-deny-matrix.spec.ts`（18 地址按标签断言）与四向判据，且**行为零收益**（三端决策本来就一致）——用 `endLabels` 反查能以零行为成本拿到「编译期同源」。
- **方案 D：把类别表放进 `packages/` 的一个 TS 包，三端 import。** 否：python 端**没有** TS 构建链；`packages/` 里放一份「运行时真相」会让 python 端只能靠生成或复制，而生成正是 ADR-029 验证过的做法。契约 + 生成物是目前唯一**三端都能消费**的形态。
- **方案 E：把三份手抄表用 lint/守卫「逐字比对」而不收敛。** 否：守卫只能发现「已经漂了」，不能阻止漂；且 R68 的 meta 守卫已经证明这类「只查形态不查内容」的判据会留出盲区（它不比对结论，也不比对类别定义）。

## 8. 关联

- 相关 ADR：[ADR-029](adr-029-metadata-addresses-outbound-deny.md)（**同款做法的先例**：契约段 → 三端生成物）、[ADR-032](adr-032-python-switch-posture-parity.md)、[ADR-033](adr-033-admin-webhook-posture-parity.md)（把三端**决策**拉齐的两轮）
- 计划项：R70（本 ADR）、R67-W5（可行性勘察 `artifacts/autonomy/R67-node/parity-plan.md`）、R68（meta 守卫 `check:posture-matrix-tables`）
- 判据：`scripts/check-ssrf-three-way-matrix.mjs`（真跑三端比对，25 地址零豁免）、`scripts/check-protocol-three-way.mjs`（契约向量 ↔ 真跑）、`scripts/protocol-four-way-allowlist.json`（分叉豁免账）、`scripts/docs/check-docs.mjs`（ADR 结构断言）
