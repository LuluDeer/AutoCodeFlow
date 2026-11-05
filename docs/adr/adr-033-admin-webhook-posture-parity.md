# ADR-033: admin webhook 出站面的开关姿态与契约同构

状态：Accepted（设计已落地；R66 实测执行）
- 日期：2026-11-06
- 决策来源：ADR-032（python 执行器出站闸姿态对齐）收口后的**最后一格**——admin 侧 webhook 面。
- 前置：[ADR-032](adr-032-python-switch-posture-parity.md)（python 侧已在 `4cf4ebdb` 收紧）、[ADR-029](adr-029-metadata-addresses-outbound-deny.md)（元数据地址恒拒，恒拒层**先于**风险分类）
- 契约事实源：`packages/executor-protocol/protocol.json` 的 `networkPolicy`（`switch` / `addresses` / `metadataAddresses`）
- 本轮范围：**只改 admin-api**；不改契约、不改 node/python、不改 `scripts/**`

## 1. 动机

契约 `networkPolicy.switch.semantics` 逐字写明：

> 开关开启 ⇒ 放行 privateIPv4；**其余五类（loopback / linkLocal / cgnat / unspecified / multicast / reserved）一律仍拒**。

且 `switch.$comment` 补充：「开关的**唯一**效果是放行私网。……loopback（打自己回环）、link-local（含云元数据）、CGNAT、unspecified、multicast、reserved 在**任何**开关状态下都拒。」

但 admin-api 的 **webhook 面**（`assertSafeHttpUrl` 与 `assertAndPinHttpUrl` 的 `policy: "webhook"` 姿态）在开关开启时放行的类别**多于**契约：

- `apps/admin-api/src/common/utils/safe-http.util.ts:91`（`allowedWebhook`）：`public` ∨ 开关 ∧ (`private-lan` ∨ **`loopback`** ∨ **`restricted`**)
- `apps/admin-api/src/common/utils/safe-http.util.ts:413`（`assertSafeHttpUrl` 内联的同名谓词）：同一形状

多放行的两类：

| admin 的 risk 类 | 覆盖地址 | 契约类别 | 契约 `allowedUnderPrivateNetwork` | 契约应有 |
|---|---|---|---|---|
| `loopback` | `127.0.0.0/8`、`::1` | `loopback` | `false` | **恒拒** |
| `restricted` | `100.64.0.0/10`（CGNAT/Tailscale）、`198.18.0.0/15`（benchmark） | `cgnat` / `reserved` | 均 `false` | **恒拒** |

⇒ **同一份契约、三端两种安全承诺**，且 admin 的 webhook 面是 OWASP SSRF 的头号目标（用户可自填回调 URL）。这正是 ADR-032 逐类对照表里那一行「admin webhook 放行 / 契约拒」的成因。

而**执行器面**（`safe-http.util.ts:111` 的 `allowedExecutor`）**早已**按契约收口（R05，2026-11-05）——**同一个文件里两个面两套口径**，正是本 ADR 要消灭的分裂。

### 1.1 元数据恒拒层的位置（ADR-029 的硬要求，本轮只核不改）

契约 `metadataAddresses.$comment` 要求②：「判定必须在**风险分类之前**先判元数据，否则开关仍能把它放行」。

admin 侧的实现是**两层**：

- `safe-http.util.ts:140` / `:164`（`assertAndPinHttpUrl` 的 IP 字面量分支与 DNS 答案分支）
- `safe-http.util.ts:428` / `:451`（`assertSafeHttpUrl` 的同两处）

**四处的位置本轮不动**（ADR-029 已裁决），本轮只补判据钉住它。

一个**实测得到的重要事实**（决定了判据怎么写）：admin 的分类表把两个契约元数据成员都归成 `reserved`——

```text
100.100.100.200 → risk=reserved   metadata=true
192.0.0.192     → risk=reserved   metadata=true
```

而 `reserved` 在契约里**任何开关状态都拒** ⇒ **两层防御**：即便把恒拒层短路掉，这两个地址仍会因分类而拒。**后果**：只断言「被拒」的用例**测不出**任何短路（这正是「双层防御」的盲区）。本 ADR 的判据因此必须断言**分类层的具体归类**，见步骤 1。

## 2. 方案

### 2.1 逐类对照表（契约七类 → admin risk 类 → 开关开/关）

契约类别 → admin risk 类的映射（依据 `safe-http.util.ts` 的 `IPV4_DENY_SEGMENTS` / `IPV6_DENY_SEGMENTS`）：

| 契约类别 | admin risk 类 | 代表地址 | 开关关（旧） | 开关关（新） | 开关开（旧） | 开关开（新） | 变化 |
|---|---|---|---|---|---|---|---|
| `public` | `public` | `93.184.216.34` | 放行 | 放行 | 放行 | 放行 | 无 |
| `privateIPv4` | `private-lan` | `10.0.0.5` | 拒 | 拒 | 放行 | 放行 | 无 |
| `loopback` | `loopback` | `127.0.0.1` | 拒 | 拒 | **放行** | **拒** | **收紧** |
| `linkLocal` | `link-local` | `169.254.1.1` | 拒 | 拒 | 拒 | 拒 | 无 |
| `cgnat` | `restricted` | `100.64.0.1` | 拒 | 拒 | **放行** | **拒** | **收紧** |
| `unspecified` | `reserved` | `0.0.0.0` | 拒 | 拒 | 拒 | 拒 | 无 |
| `multicast` | `reserved` | `224.0.0.1` | 拒 | 拒 | 拒 | 拒 | 无 |
| `reserved` | `reserved` | `240.0.0.1` | 拒 | 拒 | 拒 | 拒 | 无 |
| `ipv4Mapped`（按内嵌 IPv4） | 同内嵌 | `::ffff:10.0.0.5` / `::ffff:127.0.0.1` | 拒 | 拒 | 放行 / **放行** | 放行 / **拒** | **收紧**（loopback 形态） |
| 恒拒表 `metadataAddresses` | 独立层 → `reserved` | `100.100.100.200` / `192.0.0.192` | 拒 | 拒 | 拒 | 拒 | 无（ADR-029 已如此） |

### 2.2 改动（两处谓词，形状对齐执行器面）

`safe-http.util.ts:91`（`allowedWebhook`）与 `:413`（`assertSafeHttpUrl` 内联）**都**改成与 `:111` 的 `allowedExecutor` 同构：

```ts
risk === "public" || (allowPrivateNetwork && risk === "private-lan");
```

判据顺序保持不变：**恒拒表 → 分类 → 开关**（ADR-029 的 ①②③）。

### 2.3 面清点（本仓 webhook 相关面的完整清单）

| 面 | 入口 | 文件:行号 | 姿态来源 | 本轮是否改动 |
|---|---|---|---|---|
| **入站**：事件订阅 URL 写入校验 | `assertSafeHttpUrl` | `apps/admin-api/src/modules/event-subscriptions/event-subscription.service.ts:133`、`:222` | webhook 面（`ssrfOpts()`） | ✅ 随谓词收口 |
| **入站**：事件订阅出站派发 | `assertAndPinHttpUrl` | `apps/admin-api/src/modules/event-subscriptions/outbound-event-dispatcher.service.ts:319` | webhook 面 | ✅ |
| **通知**：通用 webhook 渠道 | `assertAndPinHttpUrl` | `apps/admin-api/src/modules/notification/channels/webhook.channel.ts:76` | webhook 面 | ✅ |
| **通知**：dingtalk 渠道 | `assertAndPinHttpUrl` | `apps/admin-api/src/modules/notification/channels/dingtalk.channel.ts:69` | webhook 面 | ✅ |
| **通知**：slack 渠道 | `assertAndPinHttpUrl` | `apps/admin-api/src/modules/notification/channels/slack.channel.ts:68` | webhook 面 | ✅ |
| **通知**：wecom 渠道 | `assertAndPinHttpUrl` | `apps/admin-api/src/modules/notification/channels/wecom.channel.ts:67` | webhook 面 | ✅ |
| **通知**：feishu 渠道 | `assertAndPinHttpUrl` | `apps/admin-api/src/modules/notification/channels/feishu.channel.ts:101` | webhook 面 | ✅ |
| AI 供应商出站 | `assertAndPinHttpUrl` | `apps/admin-api/src/modules/ai/ai.service.ts:990`、`:1088`、`:1189` | webhook 面（默认 `policy`） | ✅ 随谓词收口 |
| OIDC issuer / discovery | `assertAndPinHttpUrl` | `apps/admin-api/src/modules/auth/oidc.service.ts:200`、`:308` | webhook 面 | ✅ |
| 执行器面（dispatch/broadcast/package/gitRepo） | `assertAndPinExecutorUrl` / `assertSafeExecutorUrl` / `assertSafeGitRepoUrl` | `apps/admin-api/src/modules/executor/executor.service.ts:2024` 等 | **executor 面**（R05 已按契约收口） | ❌ 不动 |
| 入站 HTTP（客户端打进来） | — | — | 不走 SSRF 闸（是**入站**，不是出站） | ❌ 不适用 |

⇒ 结论：webhook 姿态**只有一个实现**（`safe-http.util.ts` 的两个谓词），但它被 **11 个调用点**共享；改这两个谓词即覆盖全部 11 个面。上表「本轮是否改动」列的 ✅ 都是**同源改动**，不是逐处打补丁。

### 2.4 主机名解析到 linkLocal 的那条路

webhook 面对主机名做真实 DNS 解析（逐答案判定），契约 `resolution.mode = "dns-resolve"`。契约 §2 的逐类口径对**解析后的地址**同样成立：本轮改的是谓词，**解析路径与逐答案判定逻辑不变** ⇒ 主机名解析到 `linkLocal`/`cgnat`/`loopback` 的答案，在开关开启态**同样被拒**（与 IP 字面量同格）。

`ipv4Mapped` 形态由 `normalizeIpForClassification`（`safe-http.util.ts:339`）先折成内嵌 IPv4 再分类 ⇒ 与内嵌同格。

## 3. 影响面

### 3.1 要改的既有用例（逐条列出）

| 位置 | 原断言 | 改法 |
|---|---|---|
| `apps/admin-api/src/common/utils/__tests__/safe-http.util.spec.ts:260` | 「allow=true admits loopback / CGNAT benchmark / private-LAN targets」 | 拆成两条：**放行**只留 private-lan 三段（10/8、172.16/12、192.168/16）；**恒拒**新增 loopback/CGNAT/benchmark 四例 |
| `apps/admin-api/src/modules/notification/channels/__tests__/channels.spec.ts:904` | 「webhook 渠道：开关开启 → loopback URL **不再 blocked** 且真实派发」 | 改为 private-lan 派发；**新增**一条断言 loopback 仍 `blocked` |
| `apps/admin-api/src/modules/notification/channels/__tests__/channels.spec.ts:925`/`:937`/`:949`/`:961` | dingtalk / slack / wecom / feishu「开关开启 → loopback URL 派发」 | 改表驱动：private-lan 派发 + loopback 恒拒（每渠道一条） |

**保持绿**（未改）：`safe-http.util.spec.ts` 的默认姿态用例、云元数据恒拒用例（`:973` 渠道级 + spec 级）、`ssrf-deny-matrix.spec.ts` 的 R05/R08/R09 矩阵、`assertSafeExecutorUrl` / `assertSafeGitRepoUrl` 全部用例。

### 3.2 失效半径（谁会被打断）

- 受影响：**设了** `notification.allowPrivateNetwork=true`（或 `eventWebhook.allowPrivateNetwork` / `oidc.allowPrivateNetwork` / `ai.allowPrivateNetwork`）**且**目标地址是 **loopback**（执行器/通知端跑在同一台机器上，如本地 webhook 接收器）或 **CGNAT**（Tailscale `100.64/10`）或 **benchmark**（`198.18/15`）的部署 —— 这些目标从「可用」变成 **blocked**。
  - 最典型的受影响形态：**通知渠道指向 `http://127.0.0.1:<port>`**（本地 webhook 接收器）。契约明写 loopback「打自己回环没有合法拓扑」，但**本地开发/单机部署**确有此用法。
- 不受影响：RFC1918 三段（`10/8`、`172.16/12`、`192.168/16`）—— 契约放行的那一格，开关开启时继续可用（既有渠道用例已改为钉住它）。
- 受益：关闭 webhook 面 → 云元数据 / loopback / CGNAT 的通道；与 node 下载面（`96ac8eae`）、python 闸门（`4cf4ebdb`）的结论一致。

### 3.3 跨端一致性（本轮收口后的全表）

| 契约类别 | admin 执行器面 | admin webhook 面（本轮后） | node 下载面 | node gitRepo 面 | python 闸门 |
|---|---|---|---|---|---|
| `public` | 放行 | 放行 | 放行 | 放行 | 放行 |
| `privateIPv4` | 开关 ∧ 放行 | 开关 ∧ 放行 | 开关 ∧ 放行 | 开关 ∧ 放行 | 开关 ∧ 放行 |
| `loopback` | 恒拒 | **恒拒（本轮改）** | 恒拒 | 恒拒 | 恒拒 |
| `linkLocal` | 恒拒 | 恒拒 | 恒拒 | 恒拒 | 恒拒 |
| `cgnat` | 恒拒 | **恒拒（本轮改）** | 恒拒 | 恒拒 | 恒拒 |
| `unspecified` | 恒拒 | 恒拒 | 恒拒 | 恒拒 | 恒拒 |
| `multicast` | 恒拒 | 恒拒 | 恒拒 | 恒拒 | 恒拒 |
| `reserved` | 恒拒 | 恒拒 | 恒拒 | 恒拒 | 恒拒 |
| 恒拒表 | 恒拒 | 恒拒 | 恒拒 | 恒拒 | 恒拒 |

**一个已知的分类名差异（非缺陷）**：`198.18/15`（benchmark）在 node（`apps/executor-node/src/lib/ssrf-guard.ts:269`）与 python（`apps/executor-python/network_policy.py:144`）都归 `reserved`，而 admin（`safe-http.util.ts:587` 的 `ipv4-benchmark` 段）归 `restricted`。**放行结论一致**（两类在契约里都是 `allowedUnderPrivateNetwork=false` ⇒ 恒拒），只是**类别名**不同 ⇒ 不构成「两种承诺」，但**类别名**本身是契约字段，值得在未来统一（不在本轮）。

## 4. 回滚路径

1. **单 commit 回滚**：`git revert <sha>` 即回到旧姿态。无 schema 变更、无数据迁移、无写库动作 ⇒ 无补偿动作。
2. **运行期回滚**：四个 `*.allowPrivateNetwork` 配置项（`notification` / `eventWebhook` / `oidc` / `ai`）置 false ⇒ 立即回到「除 public 全拒」的默认姿态（**比旧姿态更严**，是安全侧的兜底，不是等价回滚）。**要回到旧的宽松语义必须发版**。
3. **开关语义没有灰度阀**：本轮**不引入**新开关。理由：契约口径不是「可选项」，而是**安全承诺**；引入「按契约」与「按旧口径」双轨开关，等于把 ADR-032 刚清掉的「两种承诺」重新制度化。若真需要灰度，应走**配置分环境**（生产先关开关），而不是在代码里留双轨。
4. **判据回滚**：新用例与既有用例互不依赖；回滚后新用例会红 —— 这是**预期的红灯**，**不允许**通过删用例「修好」。

## 5. 分步计划

### 步骤 1 · 判据先行（红）

新增 `safe-http.util.spec.ts` 的 `describe("R66 — webhook 面姿态与契约逐类同构")`，四条：
① 开关关闭：public 放行、其余七类全拒；② 开关开启：**只**多放行 private-lan（含其 `ipv4Mapped` 形态）；③ 恒拒表两个厂商端点任何姿态都拒；④ 恒拒层是**独立一层**（断言 `classifyAddressRisk` 把元数据端点归 `reserved`、把同段非元数据地址归 `restricted`）。

- **红→绿判据**：`cd apps/admin-api && npm test -- --testPathPatterns "safe-http.util" -t "R66"` ⇒ **旧实现 exit 1**（开关开启态放行了 loopback / cgnat）。
- **若失败如何退**：若旧实现已绿 ⇒ 静态推断不成立，停手并如实报。

### 步骤 2 · 收口（绿）

改 `safe-http.util.ts` 的两处谓词（`allowedWebhook` 与 `assertSafeHttpUrl` 内联）为契约同构；改 §3.1 的 3 处既有用例。

- **红→绿判据**：步骤 1 ⇒ **exit 0**；`npm test -- --testPathPatterns "safe-http|ssrf|webhook|notification"` ⇒ **exit 0**（25 suites / 537 passed）。
- **若失败如何退**：revert 单 commit。

### 步骤 3 · 反向验证（自证有牙）

- **3a 短路姿态谓词**（恢复旧的宽松形状）⇒ 步骤 1 的②与 webhook 出站面用例 **exit 1**。
- **3b 短路恒拒层**（`classifyAddressRisk` 里的 metadata 分支置假）⇒ 步骤 1 的④ **exit 1**（`Expected: "reserved" / Received: "restricted"`）。
  - 关键：**只短路 `isMetadataAddress` 的调用点测不出**（因双层防御，`reserved` 仍恒拒）——见 §1.1。这条实测教训必须留在判据里，否则后人以为「短路恒拒层 ⇒ 恒拒用例必红」。

### 步骤 4 · 体量收敛（不涨）

- **判据**：`node scripts/check-size-caps.mjs` 对本轮三个文件**零超限**（`safe-http.util.ts` 560、`safe-http.util.spec.ts` 587、`channels.spec.ts` 994 非注释行；`channels.spec.ts` 最长函数体回到 11）。
- **做法**：4 条渠道用例从「4 份复制」改为**表驱动 for 循环**（`it.each` 会把最长函数体抬到 24 ⇒ 超棘轮，故不用）。

## 6. 明确不做

1. **不改契约**（`packages/executor-protocol/protocol.json`）：契约已是目标口径，改它等于**降级安全承诺**。
2. **不改执行器面**（`allowedExecutor` / `assertSafeExecutorUrl` / `assertSafeGitRepoUrl`）：R05 已按契约收口，本轮零改动。
3. **不改 node / python**：两者的 webhook/下载/闸门面已按契约收紧（`96ac8eae` / `4cf4ebdb`）。
4. **不改 `scripts/**`**（四向检查的豁免账、探针改造）：写域外，由 W1/Lead 处理。
5. **不统一 `198.18/15` 的类别名**（admin `restricted` vs node/python `reserved`）：放行结论一致，不构成两种承诺；改类别名要动三端分类表，属独立立项。
6. **不引入新的灰度开关**：理由见 §4.3。
7. **不动恒拒层的位置**（ADR-029 已裁决）；本轮只补判据钉住它。

## 7. 替代方案（被否）

- **方案 B：只堵 loopback，保留 `restricted`（cgnat）随开关放行。** 否：又制造「同一份契约两种承诺」；ADR-032 方案 C 已否过同款（部分收口会让下一次「哪个类在哪端松」再开一轮）。
- **方案 C：把 webhook 面改成执行器面那样，但保留 `loopback`（打自己回环确有本地部署用法）。** 否：契约 `switch.$comment` 明写「loopback（打自己回环）… 在任何开关状态下都拒」，且这是 **OWASP SSRF 头号目标**；若要保留本地回环 webhook，正确做法是让用户用**显式配置**指向 RFC1918 地址或走反向代理，而不是把回环塞进「隐式解锁组」。
- **方案 D：加 `notification.allowLoopback` 之类的第二开关。** 否：第二开关 = 第二种承诺；且与 ADR-032 已定的「逃生阀必须回收」纪律相悖。
- **方案 E：只改文档不改代码（写明「开关解锁非 public 受限地址」）。** 否：ADR-029 已裁决这一路线（不能把 SSRF 口子写成「已声明行为」）。

## 8. 关联

- 相关 ADR：[ADR-029](adr-029-metadata-addresses-outbound-deny.md)（元数据恒拒层）、[ADR-032](adr-032-python-switch-posture-parity.md)（python 侧同款收口，本 ADR 是它的最后一格）
- 计划项：R66（admin webhook 面姿态）、R05（admin 执行器面按契约收口，本 ADR 的先例）、R01（admin 的 cgnat 收口）、R08/R09（元数据恒拒表扩展）
- 契约：`packages/executor-protocol/protocol.json` 的 `networkPolicy.switch` / `networkPolicy.addresses` / `networkPolicy.metadataAddresses`
- 守卫：`scripts/check-protocol-three-way.mjs`（真三向检查）、`scripts/check-protocol-four-way-*`（四向）、`scripts/check-size-caps.mjs`（体量棘轮）、`scripts/docs/check-docs.mjs`（ADR 结构断言）
