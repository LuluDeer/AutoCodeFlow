# ADR-036: `localhost` 系主机名先于 DNS 拒绝——并接受错误码变更

状态：Accepted（设计已落地；R80 实测执行）
- 日期：2026-11-06
- 决策来源：R79 勘察（`*.localhost` 的 DNS 旁路）+ R80 修复
- 相关 ADR：[ADR-029](adr-029-metadata-addresses-outbound-deny.md)（恒拒先于分类）、[ADR-033](adr-033-admin-webhook-posture-parity.md)（webhook 面姿态）、[ADR-034](adr-034-network-category-table-in-contract.md)（零依赖分类模块）
- 契约事实源：`packages/executor-protocol/protocol.json` 的 `networkPolicy.addresses.loopback`

## 1. 动机

### 1.1 旁路怎么成立

admin 对主机名形态的判定**只有一条路**：DNS 解析 → 逐答案分类。

- `apps/admin-api/src/common/utils/safe-http.util.ts` 的 `assertAndPinHttpUrl` 与 `assertSafeHttpUrl` 在**不是 IP 字面量**时都直接 `lookup(host, { all: true })`，解析失败才 `SSRF_HOST_DNS_LOOKUP_FAILED`、解析成功则逐答案 `classifyAddressRisk`。
- ⇒ `localhost` 之所以被拒，**唯一原因是它解析到 `127.0.0.1`**。**没有任何一处判断「这个主机名本身是不是回环专用名」。**

而契约 `networkPolicy.addresses.loopback.description` 逐字写明：

> 回环地址：IPv4 127.0.0.0/8、IPv6 ::1，**以及主机名 localhost / \*.localhost / localhost.localdomain**。

`examples` 里也列了 `localhost` 与 `foo.localhost`。⇒ **契约规定的是「名字」，实现校验的是「解析结果」**。两者在正常情况下重合，但**不必然**：

- 某环境的 resolver / hosts / 上游 DNS 把 `foo.localhost` 解析到**公网地址**（RFC 6761 §6.3 只是「建议」本机 resolver 把它当回环，**并不强制**上游）⇒ admin **放行**，契约要求**拒**。
- 更糟的形态：`localhost.`（尾点绝对名）与大小写变体在不同 resolver 下行为不一。

**R80 实测（红）**：用 jest 的 DNS 替身把 `foo.localhost` 解析到 `93.184.216.34`（公网），旧实现**放行**——4 条断言红（`foo.localhost` / `localhost` / 四种形态 / pin 版）。这证明旁路可构造，不是纸面推演。

### 1.2 为什么这值得修（而不是「配置问题」）

契约把这三个名字**直接列为回环类别**。放行它们等于让「回环专用名」这条安全承诺**依赖于外部 DNS 的善意**。而 SSRF 闸的存在前提就是「不信任外部输入决定的目的地」。

## 2. 方案

### 2.1 在 DNS **之前**短路拒绝（复用已抽出的零依赖纯函数）

在 `assertAndPinHttpUrl`（`safe-http.util.ts:179`，其 `lookup` 在 `:184`）与
`assertSafeHttpUrl`（`safe-http.util.ts:477`，其 `lookup` 在 `:482`）的
`lookup(...)` **之前**插入一句：

```ts
if (isLoopbackHostname(host)) {
  throw new AppError(ErrorCode.SSRF_HOST_DENIED, { host });
}
```

`isLoopbackHostname` 是 R79 抽出的**零依赖纯函数**
（`apps/admin-api/src/common/utils/address-category.util.ts:507`）：
- 语义来自契约 `loopback.description` + RFC 6761 §6.3；
- 覆盖 `localhost` / `*.localhost` / `localhost.localdomain`，并做归一化（小写、去尾点、剥 IPv6 方括号）；
- **不读 env、不做 DNS、不依 Nest**，数据以纯常量内建。

**不写第二份判定**（这是本 ADR 的硬约束之一）：R79 已经把这条规则做成可复用纯函数，admin 的原路径改为调用它。

### 2.2 错误码变更（刻意的，需要被记录）

| 路径 | 旧 | 新 |
|---|---|---|
| `assertSafeHttpUrl` | `SSRF_HOST_DNS_LOOKUP_FAILED`（若 DNS 失败）或 **放行**（若解析到公网） | **`SSRF_HOST_DENIED`** |
| `assertAndPinHttpUrl` | 同上 | **`SSRF_HOST_DENIED_PINNED`** |

**为什么必须换码**：旧码说的是「解析失败」（一种环境故障），而新的判定说明的是「这个主机名本身就被契约列为回环」（一种**策略拒绝**）。用旧码会误导运维去查 DNS。

**为什么两个路径用不同的码**：沿用两边各自的既有约定——`assertSafeHttpUrl` 的拒绝一律是 `SSRF_HOST_DENIED`，pinned 版一律是 `SSRF_HOST_DENIED_PINNED`（既有代码里其它拒绝分支都是这么分的，本轮只是保持一致）。

### 2.3 对既有依赖的排查（已 grep，结论：无代码依赖）

| 面 | 是否依赖旧码 | 处理 |
|---|---|---|
| admin-api 的测试 | **无**（`grep DNS_LOOKUP_FAILED apps/admin-api/src/**/*.spec.ts` 为空） | — |
| admin-web 前端 | **无按码分支**（只有 i18n 文案表 `error-codes.{zh,en}.ts`，两个码都有翻译） | 无需改；新码文案已存在 |
| CLI / SDK / 协议 | **无**（`protocol.json` 不含这两个错误码；`docs/api-reference.md` 亦未列） | — |
| 运维文档 | 无按码分流 | — |

⇒ 错误码变更**不影响任何代码分支**，只影响「日志/审计里看到哪个码」。这是可以接受的（且新码更准确）。

## 3. 影响面

### 3.1 行为变化（唯一一处）

| 输入 | 旧 | 新 |
|---|---|---|
| `localhost` / `*.localhost` / `localhost.localdomain`（含大小写、尾点变体），**DNS 解析到公网** | **放行** | **拒** |
| 同上，DNS 解析失败 | 拒（`SSRF_HOST_DNS_LOOKUP_FAILED`） | 拒（`SSRF_HOST_DENIED[_PINNED]`） |
| 同上，DNS 解析到 127.x | 拒 | 拒（**但不再发 DNS 查询**） |
| 其它主机名（`example.com` 等） | 不变 | 不变 |

**副产物**：对 localhost 系名字**不再发起 DNS 查询**（少一次网络往返，也少一个可被 DNS 污染的窗口）。

### 3.2 失效半径

- 受影响：**没有任何合法拓扑**会指向 `*.localhost`（RFC 6761 把它定为回环专用名；契约亦列为回环）⇒ 收紧不会打断合规部署。
- 风险方向：纯收紧（只多拒，不多放行）。
- 边界：`localhost.evil.com` / `notlocalhost.com` **不**受影响（后缀匹配用的是 `.localhost`，不是 `includes`）——已有负例用例钉住。

### 3.3 同族面（R81 已全部收口）

同一文件里还有两处主机名解析路径**同样依赖 DNS**：

| 路径 | 位置（函数） | 处理 |
|---|---|---|
| `assertSafeGitRepoUrl` | git 面（`lookup` 前短路，`GIT_REPO_HOST_BLOCKED`） | **已收口**（R81，commit `998e3970`） |
| `assertSafeExecutorUrl` | executor 面（`lookup` 前短路，`EXECUTOR_HOST_BLOCKED`） | **已收口**（R81，commit `998e3970`） |

**R80 当时为什么不一起改**：这两处的错误码属于**不同语义域**（git 面 / executor 面），
各自的拒绝文案与调用方不同（git 克隆失败 vs 执行器不可达）。⇒ 先只改 webhook 面，
把两面登记为遗留；R81 用**同一处** `isLoopbackHostname` 补齐，但**保留各自的码**：

- git 面：`GIT_REPO_HOST_BLOCKED`（该面「地址判定层拒绝」的既有码）；
- executor 面：`EXECUTOR_HOST_BLOCKED`。

**为什么不套用 webhook 的 `SSRF_HOST_DENIED`**：这两面各有自己的错误域，混用会让运维
按错误的域去排查。R81 的用例 `两面的错误码各自保留` 把这条钉住（若有人改成统一码，
它会红）。

**仍未做的跨端项**：node 侧 git 面有自己的 `isLocalhostSynonym`
（`apps/executor-node/src/git-repo-network-policy.ts:168`），判据是
`localhost` / `localhost.localdomain` / `endsWith('.localhost')` —— 与 admin 的
纯函数**语义一致**，但**没处理大小写与尾点**（`LOCALHOST` / `localhost.` 在 node 侧
可能漏判）。对齐它属**跨端一致性**、要动 `apps/executor-node/**`（不在本 worker 写域），
另立一轮。

## 4. 回滚

1. **单 commit `git revert`**：改动是两条 `if` 短路 + 一处测试修正；无迁移、无 schema、无写库。
2. **不需要灰度开关**（明确取舍）：
   - 改的是**拒绝**且方向是收紧；灰度一个「要不要拦住旁路」的开关，等于**默认留着旁路**；
   - 本仓已三次裁决「双轨开关 = 制度化的两种承诺」（ADR-032 §4.3 / ADR-033 §4.3 / ADR-035 §4.2）。
3. **回滚的代价**：恢复「DNS 解析到公网即放行 `*.localhost`」的旁路。⇒ 回滚前应先确认没有依赖该行为的自动化（预期没有：合法部署不会把回调指向 `*.localhost`）。

## 5. 分步计划

### 步骤 1 · 先写能红的用例（**已完成**）

- **做**：注入式 DNS 替身把 `*.localhost` 解析到公网 IP，断言必须拒。
- **红→绿判据**：旧实现 **4 failed / exit 1**（`foo.localhost` / `localhost` / 四种形态 / pin 版）。**已实测**。
- **失败如何退**：若旧实现是绿的 ⇒ 旁路不成立，停手。

### 步骤 2 · DNS 前短路（**已完成**）

- **做**：两处 `lookup` 前插 `isLoopbackHostname(host)` → 抛 `SSRF_HOST_DENIED` / `SSRF_HOST_DENIED_PINNED`。
- **判据**：步骤 1 的 4 条转绿；定向 `safe-http|ssrf|posture|address|webhook|notification` ⇒ **32 suites / 619 passed / exit 0**；`tsc --noEmit` exit 0。**已实测**。

### 步骤 3 · 反向验证（**已完成**）

- **做**：把两条短路置为 `false &&`。
- **判据**：同样 4 条 **exit 1**；还原 ⇒ 全绿。**已实测**（证明用例真咬住短路，不是恒真）。

### 步骤 4 · 错误码依赖排查（**已完成**，见 §2.3）

- **判据**：`grep` 结果为空（测试/前端/CLI/协议均不按码分支）；i18n 两个码都有文案。

### 步骤 5 · 同族面收口（**未做，独立一轮**）

- **做**：`assertSafeGitRepoUrl` / `assertSafeExecutorUrl` 同样在 DNS 前短路；并决定是否与 node 的 `isLocalhostSynonym` 统一语义（node 的判据是 `localhost` / `localhost.localdomain` / `endsWith('.localhost')`，与 admin 的纯函数**逐字一致**，只是没处理大小写与尾点）。
- **红→绿判据**：给这两条路径各加「注入公网解析 ⇒ 必须拒」的用例，先红后绿。
- **为什么独立**：错误码归属不同的语义域，且跨端对齐要动 node（不在本 worker 写域）。

## 6. 明确不做

1. **不改契约**：契约已经写明三个名字属 loopback，本轮是让实现追上契约。
2. **不改 node / python**：node 的 git 面已有等价判定；python 侧的 accept 闸由 ADR-032 收口。
3. **不改 `assertSafeGitRepoUrl` / `assertSafeExecutorUrl`**（见 §3.3，已登记遗留）。
4. **不改 i18n 文案**：`SSRF_HOST_DENIED` / `SSRF_HOST_DENIED_PINNED` 的 zh/en 文案都已存在且准确。
5. **不引入特性开关**（理由见 §4.2）。
6. **不做「DNS 结果与主机名语义冲突」的通用裁决**（例如「解析到公网但名字像内网」）：那需要一份名字启发式表，是另一个课题；本轮只处理**契约点名的三个名字**。

## 7. 替代方案（被否）

- **方案 B：只改测试不改实现**（断言「解析到公网时放行」是预期行为）。否：那是把旁路写成契约——契约明确要求这三个名字是回环。
- **方案 C：在 DNS 之后补一道「主机名同义」检查**（解析成功再判名字）。否：① 解析到公网时仍会先发出 DNS 查询（窗口仍在，且多一次可被污染的机会）；② 解析失败时错误码仍指向 DNS，掩盖真实原因。
- **方案 D：把 `*.localhost` 加进契约 `metadataAddresses` 恒拒表**。否：恒拒表的语义是「地址」，而这是「名字」；且恒拒表要求判定在**分类之前**、对**解析后的地址**生效——用它表达主机名会污染该段的语义。
- **方案 E：给全局 resolver 配置 `*.localhost` → 127.0.0.1**。否：那是部署侧缓解，不是代码保证；库的默认行为不该依赖运维配置。

## 8. 关联

- 相关 ADR：[ADR-029](adr-029-metadata-addresses-outbound-deny.md) · [ADR-033](adr-033-admin-webhook-posture-parity.md) · [ADR-034](adr-034-network-category-table-in-contract.md)
- 契约：`packages/executor-protocol/protocol.json` 的 `networkPolicy.addresses.loopback`
- 既有实现：`apps/admin-api/src/common/utils/address-category.util.ts`（`isLoopbackHostname`）、`apps/admin-api/src/common/utils/safe-http.util.ts`（两处短路）
- 计划项：R79（勘察 + 纯函数）、R80（本 ADR 落地）
