# ADR-030：per-executor 令牌签发的**跨实例幂等**（`(address, startupId)` 复用）

- 状态：**Accepted（设计）/ 落地排期见 §7**——本轮只交付本 ADR 与**运行期症状检测告警**，
  改实现与迁移单独一轮（理由见 §7.1）
- 日期：2026-11-05
- 相关：R9（幂等签发引入）、R12（单进程并发收口，ADR 未涉）、R11（接管 CAS 的谓词思路）、
  ARCH-31 §3.7（令牌缓存跨实例逐出广播）、ADR-017 §5（地址不是身份）

## 1. 背景：缺陷已被真机证实

`issueToken`（`apps/admin-api/src/modules/executor/executor.service.ts:6635`）的幂等复用是
**进程内缓存**：同步 `issuedTokenCache.get(identityKey)`（`:6697`）→ 命中且 `sameProcess` 才复用
→ 否则 `await rotateToken()`（`:6730`）。

- **单进程并发**（R12 已修）：4 并发 → 4 次轮换 → 先返回的令牌立刻作废。修法 =
  `KeyedSerializer`（`token-issue-serializer.util.ts`）按身份串行，真机 10 轮稳定 1 次轮换。
- **跨实例**（本 ADR）：串行器只在进程内生效。两个 admin-api 实例同时收到同一
  `(address, startupId)` 的 `/executors/token` 时，各自缓存都未命中 ⇒ **各轮换一次** ⇒
  **先返回的那枚令牌被另一实例的写入覆盖**。后果与 R12 同形但更隐蔽：拿到死令牌的
  执行器进入 `401 → forceTokenRefresh → POST /token → 又一轮换` 的自愈回路，
  在**两个实例间来回甩**（幂等永远命中不了对方的内存），表现为间歇性 401 与轮换风暴。

## 2. 目标与不变量

| # | 不变量 | 判定口径 |
|---|---|---|
| I1 | 任一时刻该身份**至多一枚有效令牌** | DB `tokenHash` 单列 + 唯一命中 |
| I2 | 被替换的旧令牌**明确吊销** | 旧令牌对受保护端点 401/403；`bcrypt.compare(old, stored)` 为假 |
| I3 | DB 里该身份 **active 令牌数 ≤1** | 结构性（无第二令牌表） |
| I4（新增，跨实例） | 两实例并发签发同一 `(identity, startupId)`：**返回的令牌必须相同**，或「后签发者胜且先签发者已吊销」，**不许两枚同时可用** | 两实例响应 + DB 复核 |

## 3. 三方案对比

### 方案① Redis 明文令牌缓存（否决）

做法：签发成功后把 `identityKey → {token, startupId, issuedAt}` 写入 Redis（TTL 同
`TOKEN_ISSUE_CACHE_TTL_MS`），跨实例命中即复用。

| 维度 | 结论 |
|---|---|
| **失效半径** | Redis 不可用/脑裂 ⇒ 命中退化为「本进程缓存」⇒ **回到今天的双轮换**，且**静默**（没有任何错误，只是又开始甩令牌）。这是把「已确诊的缺陷」变成「取决于中间件可用性的缺陷」 |
| **明文落中间件** | 现状：per-executor 令牌明文**只存在于 admin-api 进程内存 ≤ TTL**，DB 只有 bcrypt(12) 哈希（`entity:234` `select:false`）。改后明文进 Redis：RDB/AOF **落盘**、备份与快照带出去、`MONITOR`/`SLOWLOG`/内存 dump 可读、共享实例的多租户面可读，而 Redis 通常**没有**与 DB 同级的访问审计。等于新增一处**凭据库**，却用「缓存」的运维标准去管 |
| **与 `EXECUTOR_SECRET` 模型** | 不冲突但**叠加**：`EXECUTOR_SECRET` 是「谁可以调 register/token」的共享口令；per-executor 令牌是「这台执行器的回调 HMAC 凭据」。把后者明文放进中间件后，攻破 Redis ⇒ **直接拿到所有执行器的回调签名能力**（可伪造回调篡改执行结果），而攻破今天的 Redis 什么也拿不到 |
| 复杂度 | 低（~80 行）但**引入新依赖到关键路径**，且需要 Redis 加密/TTL/清理策略的独立评审 |

### 方案② 只存 hash + DB 幂等键（原始形态**走不通**；精化后**可行**）

**原始形态（Lead 立项里的写法）**：唯一键 `(identity, startupId, rotationSeq)` +
`INSERT ... ON CONFLICT`；失败方「退回读现状」。

> **为什么走不通**：令牌是**不可从哈希反推的**（bcrypt 单向）。失败方「读现状」只能拿到
> `tokenHash`，而调用方需要的是**明文字符串**作为 bearer。于是失败方只剩两条路：
> (a) 返回 409 让执行器重试 ⇒ 重试仍然读不到明文 ⇒ 再次轮换 ⇒ **把赢家的令牌打死**（回到缺陷）；
> (b) 直接把哈希当令牌发出去 ⇒ 立即 401。**故「只存 hash」不足以返回令牌**，这条原始路否。

**精化形态（本 ADR 采纳的设计，记作 ②′）——「确定性派生 + 轮换纪元 CAS」**：

- 令牌不再随机，而是**确定性派生**：
  `token = HMAC-SHA256(K_derive, identityKey ‖ "\x00" ‖ startupEpoch ‖ "\x00" ‖ rotationEpoch)`
  （`identityKey` = 现有 `tokenCacheIdentityKey(address, deviceFingerprint)`；
  `startupEpoch` = 该行 `executorStartupId` 的稳定取值；`rotationEpoch` = **新列**
  `tokenRotationEpoch integer NOT NULL DEFAULT 0`，只在轮换时 +1）。
- 轮换 = **条件更新**（与 R11 接管 CAS 同款思路）：
  `UPDATE executors SET "tokenHash" = bcrypt(token_epoch), "tokenRotationEpoch" = epoch + 1
   WHERE id = :id AND "tokenRotationEpoch" = :epoch`
- **并发只有一个赢家**（`affected=1`）；失败方（`affected=0`）**不需要明文**：
  它用**自己那组同样的输入**（同一 identity、同一 startupEpoch、同一 epoch）**重算出同一枚令牌**，
  再用 `bcrypt.compare(自己算的, 库里的新 hash)` 复核 —— 命中即证明「赢家写的就是这枚」，
  于是**把同一枚令牌返回给调用方**（不落任何明文）。
- 复核不命中（说明别人用**不同输入**轮换了，例如管理台 rotate-token）⇒ 按既有语义**409 + 重试**，
  重试时读到新 epoch 再派生新令牌。

| 维度 | 结论 |
|---|---|
| I1/I3 | 恒成立（单 hash 列 + epoch 单调） |
| I4 | 恒成立：同输入 ⇒ 同令牌；不同输入 ⇒ 后者胜、前者哈希已被覆盖（旧令牌立即吊销） |
| 明文 | **任何地方都不落明文**（内存 ≤ TTL 的既有缓存可保留，仅作性能） |
| 新增依赖 | **无**（HMAC 用 node:crypto） |
| schema | **一列** `tokenRotationEpoch integer NOT NULL DEFAULT 0`（metadata-only，零回填） |
| 安全取舍 | 派生密钥泄露 ⇒ 可算出**已知 identity+epoch** 的令牌。**但**：持有共享 `EXECUTOR_SECRET` 的一方今天就能对任意地址调 `POST /executors/token` 直接取明文 ⇒ **不新增权限面**；派生密钥用独立 env（`EXECUTOR_TOKEN_DERIVATION_SECRET`，缺省回落 `EXECUTOR_SECRET` 以保持灰度可用） |
| 风险 | 令牌**不再随机** ⇒ 依赖「随机性」的隐含假设（如日志里撞见半截哈希）失效；轮换纪元必须**只增**且不跳号，否则同一 epoch 会派生同一令牌（这正是幂等所需，但**跳号**会让两枚不同令牌对应同一行，需要 CAS 严格 `= :epoch`） |

### 方案③ 单写者 lease（否决）

做法：DB 行级 lease（`leaseOwner`/`leaseUntil`）拥有轮换权，其他实例等待或轮询行状态。

| 维度 | 结论 |
|---|---|
| 解决 I4 吗 | **不解决**：lease 只串行化「谁轮换」，不解决「输家拿不到明文」的根问题 ⇒ 输家仍需 409+重试，而每次重试都是一次新轮换（原缺陷原样保留） |
| 与 R03 灰度租约 | 语义不同：R03 的租约是「批量灰度推进的所有权」；把它扩成「令牌轮换所有权」会让一次 rollout 期间**该执行器无法换发令牌**（租约被 rollout 持有） |
| 与 R11 接管 CAS | 直接**打架**：接管 CAS 的谓词是 `status = OFFLINE`，接管成功后行会被重写身份；lease 若钉在行上，接管必须同时处理 lease 的失效转移（否则死行上的 lease 永久占用 ⇒ 新安装拿不到轮换权）。三个概念（灰度 lease / 接管 CAS / 令牌 lease）挤在同一行 = 语义熵爆炸 |
| 代价 | 需要列 + 到期清理 + 时钟偏斜处理，收益仅为「串行化」，不如 ②′ 一步到位 |

## 4. 结论

**采纳 ②′（确定性派生 + `tokenRotationEpoch` CAS）**，否决 ①（把凭据明文搬进中间件、失效时静默退回缺陷）
与 ③（不解决根问题，且与 R03/R11 的租约/CAS 语义打架）。

## 5. 必写项

### 5.1 回滚路径

- 代码：`git revert <sha>`（一次提交含 service 改动 + 迁移 + 测试）。
- 迁移 down：`DROP COLUMN "tokenRotationEpoch"`（**安全**：该列只被新代码读；旧代码完全不认识它）。
  迁移必须**显式实现 `down()`**（`check:migrations` 要求），且 **metadata-only**（`NOT NULL DEFAULT 0`
  在 PG 16 上是 catalog-only 变更，不重写表）。
- **令牌兼容**：回滚后派生阈值失效 ⇒ 下一次轮换回到随机令牌，已签发的派生令牌**仍然有效**
  （库里存的是它的 bcrypt 哈希，与派生方式无关）⇒ **回滚不打断在跑的执行器**。

### 5.2 灰度兼容（新旧实例混跑）

- **旧实例**（随机令牌、无 epoch 意识）在混跑期仍可轮换：它写 `tokenHash` 但不改
  `tokenRotationEpoch` ⇒ 新实例的 CAS **不会**被旧实例的写入挡住（谓词是 epoch，不是 hash），
  于是「旧实例轮换 → 新实例再轮换」的两连轮换仍可能发生。
- ⇒ **混跑期跨实例幂等是部分成立**（新×新成立；新×旧不成立）。要求：
  1. 滚动发布期间**逐实例**升级，且升级窗口内**避免**对同一执行器并发重启（常规部署天然满足）；
  2. 启动时打印一条**一次性 WARN**：`token idempotency: cross-instance guarantee requires ALL instances ≥ <version> (ADR-030)`，由新代码根据「本进程是否为派生模式」+「集群里是否存在旧实例」判定——本轮先用 env 门
     `EXECUTOR_TOKEN_EPOCH_MODE`（`off`|`on`，缺省 `off`）承载，落地轮再改成版本探测。
  3. 旧实例完全下线后，跨实例幂等**自动**成立（无需二次发布）。

### 5.3 数据迁移守规

- 新迁移文件命名 `1790000000097-AddExecutorTokenRotationEpoch.ts`（接在 `…096` 之后）；
- 必须 `npm run check:migrations` 通过（命名/时间戳单调 / up+down 成对 / 无数据回填）；
- 列形状：`integer NOT NULL DEFAULT 0`（**零回填**、metadata-only）；**不建索引**
  （只按主键 `id` + 该列做 CAS，无需索引）；
- 不涉数据搬迁 ⇒ 无需 `--no-transaction`；不涉 `check-index-drift`（不加索引）。

### 5.4 失效半径（量化）

| 场景 | 现状（进程内串行器） | 方案 ②′ |
|---|---|---|
| 单实例并发 4 发 | 1 枚令牌（R12 已修） | 1 枚令牌 |
| 两实例并发同身份 | **2 次轮换** ⇒ 1 枚令牌立即可用、1 枚**刚返回即死**（执行器 401 后自愈，最多一次来回） | **1 次轮换** ⇒ 两实例返回**同一枚** |
| 派生密钥泄露 | —（无派生） | 可算出已知 `identity+epoch` 的令牌；但等价于今天「持有 `EXECUTOR_SECRET` 即可调 `/executors/token` 取明文」⇒ **不扩大** |
| **换派生密钥** | —（无派生） | **不会吊销已签发令牌**（见 §5.5 实测修正）；破坏的是**跨实例幂等**（不同 K 派生不同令牌 ⇒ 输家复核失败 ⇒ 兜底随机）与**下次按需轮换的一致性**；回退写回旧 K 即恢复 |
| Redis 故障 | 无影响 | 无影响（不使用 Redis） |
| epoch 跳号/回绕 | — | 若 epoch 回退到历史值 ⇒ 该历史令牌**复活**。防护：CAS 严格 `= :epoch` 且只 `+1`；`down()` 后 epoch 列消失，无回退面 |

## 6. 验收判据（落地轮用）

1. **确定性**：两服务实例共享一个 fake repo（或真 PG 两个连接），在「读 epoch」与「CAS 写」之间
   注入并发轮换 ⇒ 旧实现两枚不同令牌（红）/ 新实现两枚**同一**令牌（绿）。
2. **真机**：两 admin-api 实例共享 DB + Redis，同 `(address, startupId)` 并发 N≥10 轮 ⇒
   每轮 I1/I2/I3/I4 全成立、两实例返回令牌**相同**。
3. 回归：`apps/admin-api` 定向 / `typecheck:api` / `guards:repo` / `test:docs` /
   `check:size-caps` / `check:migrations` / `check:race-selftests-wired` 全绿。

## 7. 落地排期与本轮边界（诚实记录）

### 7.1 为什么本轮不直接改实现

1. **改的是凭据派生**：令牌从「随机 32 字节」变成「HMAC 派生」，影响**每一个**执行器的每一次
   取令牌动作。`rotateToken` 有 **6 个调用点**（CodeGraph `impact` 核实）+ 管理台轮换面，
   任一遗漏都会让某条路径继续发随机令牌 ⇒ 「有时幂等、有时不幂等」，比现状更难诊断。
2. **需要迁移 + 灰度顺序约束**：混跑期新×旧不幂等（§5.2），必须在 ADR 里定好发布顺序并配启动告警；
   迁移本身简单，但**发布编排**要在同一轮里验证。
3. **验证成本**：验收要「两实例 + 真 PG + 真 Redis + N 轮」（与 R12 的单实例用例不是一个量级），
   需要新脚本 + 接链（`check:race-selftests-wired`）。

⇒ 本轮交付：**本 ADR（决策 + 三方案对比 + 必写项）** + **运行期症状检测告警**（§7.2），
改实现与迁移排下一轮（`token-epoch-derivation`）。

### 7.2 本轮的过渡措施：运行期检测告警（已落地）

跨实例双轮换有一个**可观测症状**：`issueToken` 读到进程内缓存条目、但其明文**已不能**通过
`bcrypt.compare` 与库里的 `tokenHash` 对上，而该行的 `executorStartupId` **没变**
（= 不是重启，是「别人把我的令牌换掉了」）。这正是「另一实例轮换过」的证据。

本轮在该分支加一条 **WARN**（每身份每 TTL 去重，避免刷屏），文案指向本 ADR，并附上
「如何判断是否多实例部署 + 该做什么」。它不会修复缺陷，但让**缺陷从静默变可见**——
这也正是本仓一贯的处理方式（参考 `executorPostureWarning`）。

## 5.5 修正（R15，2026-11-05）：§5.4 那条「换密钥 ⇒ 所有派生令牌立即失效」是**错的**

原文（已删）把「换派生密钥」写成了「全机队令牌立即失效」。R15 写运维手册时按纪律先取证，
发现它与代码不符，**以实测为准修正**：

### 实测（可复现）

```bash
cd apps/admin-api && node -e '
const bcrypt = require("./node_modules/bcrypt");
const { deriveExecutorToken } = require("./dist/modules/executor/token-epoch-derivation.util.js");
(async () => {
  const base = { identityKey: "10.15.0.1:8006|fp", startupEpoch: "life-A", rotationEpoch: 7 };
  const tOld = deriveExecutorToken({ secret: "secret-OLD-...", ...base });
  const tNew = deriveExecutorToken({ secret: "secret-NEW-...", ...base });
  const storedHash = await bcrypt.hash(tOld, 12);
  console.log("K1/K2 派生是否相同:", tOld === tNew);          // false
  console.log("换密钥后旧令牌能否通过库里哈希:", await bcrypt.compare(tOld, storedHash)); // true
  console.log("换密钥后新派生令牌能否通过:", await bcrypt.compare(tNew, storedHash));     // false
})();'
```

⇒ 输出 `false / true / false`：**换密钥不改变已签发令牌的有效性**。

### 为什么（代码根据）

令牌**校验**只用 `bcrypt.compare(presented, row.tokenHash)`
（`apps/admin-api/src/modules/executor/executor-credentials.collaborator.ts:209/245/297`），
**从不重新派生**；派生只发生在**签发/轮换**时（`executor.service.ts:6659` 的 `mintEpochToken`）。
故换 K 只影响「下一次派生出什么」，不影响「库里那枚哈希对应的明文」。

### 修正后的失效半径（这才是运维要读的）

| 受影响 | 表现 | 自愈 |
|---|---|---|
| **已签发令牌** | **不受影响**（仍能通过校验） | — |
| **跨实例幂等** | K 不同的实例对同一 epoch 派生不同令牌 ⇒ 输家 `bcrypt` 复核失败 ⇒ 有界 2 轮后**兜底随机令牌** | 所有实例换成同一 K 后恢复 |
| **按需轮换的那一行** | 该身份下次取令牌会得到用新 K 派生的令牌，**旧哈希被覆盖** ⇒ 该行旧令牌作废（正常轮换语义） | 执行器下一次取令牌即拿到新令牌 |
| **回调 HMAC** | 执行器手里的 `tokenHash` 若已过期，用旧哈希签的回调会被拒 | 执行器取令牌/心跳时同步新哈希（≤ 一次心跳间隔） |
| 数据 | **无丢失**：执行、历史、派发均不依赖令牌明文 | — |

⇒ 结论：**回退是可行的**（写回旧 `EXECUTOR_TOKEN_DERIVATION_SECRET` 即恢复幂等一致性），
期间被轮换掉的令牌不会"回来"（执行器自愈，无数据风险）。原文的「不可回退」表述一并作废。
