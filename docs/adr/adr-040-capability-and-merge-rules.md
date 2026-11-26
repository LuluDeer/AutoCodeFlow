# ADR-040: Capability 统一模型与逐字段族合并规则

状态：Accepted
- 日期：2026-11-26

## 动机（背景与判据来源）

strategy §4.1 定义统一 Capability 模型后，Scope 作用域链（§4.2）的初稿把合并写成"列表追加"，六 agent 交叉评审认定这是 P0 硬伤（strategy §12.2 H2）：同名 command/MCP server 若按追加处理，会残留下层字段，与 opencode `commands.mdx:246`/`mcp-servers.mdx:63` 与 dsh `architecture.zh.md:25` 的同名整替换语义相反。H3 另指出 `managed` 若靠 `scope.locked` 标记实现，用户仍可新增配置绕过（opencode `config.mdx:60-64`），必须改为中台 managed policy 名单 + 策略引擎不可 disable。

这是契约决策而非普通合并函数改动：合并语义决定"一个能力在两个作用域同名时谁生效"，直接构成权限边界；dump 的可读性决定运维能否审计"生效值来自哪一层"，而凭据一旦明文输出就是新的泄露面。本仓已有的 `sopPolicy()`（`apps/admin-api/src/modules/sop/sop-collab.controller.ts:951`，随每轮 poll 下发 permissionPolicy/allowedProfiles）与 capability 覆盖式上报端点（同文件 `:474`，`updateCapabilities`）是"中台策略不可被本地突破"的既有落点；但现存的 `mergeConfigWithDisk`（`apps/executor-desktop/src/renderer/config-merge.ts:53`）只做"磁盘覆盖基线 + 用户草稿保留"，是桌面配置表单语义，**不是**能力作用域链的合并，本 ADR 不复用它，只借鉴其"纯函数 + selftest 真值表"的做法。

## 决策（方案）

1. 采用统一 Capability 模型（声明式 capability.yaml：id/权限/参数/.acceptance 等），作用域链解析按**字段族**分别定义合并规则，禁止笼统的"追加/覆盖"措辞：
   - 标量（timeout/maxTokens 等）：下层同名**替换**；
   - map（provider 条目等）：**按 key 合并**，只改一个 key 不影响其他 key；
   - permission / skill / plugin：**追加**（下层新增不覆盖中台项）；
   - command / MCP server：**同名整对象替换**，不残留上层字段；
   - policy 规则：**只收紧**（restrict 单调 deny 不可撤销；下层不得放行中台已 deny 项）；
   - 无规则命中：**默认 `ask`**（fail-closed，不放行）。
2. `managed` 治理的强制手段是 **managed policy 名单 + 策略引擎不可 disable**：名单内的能力/配置项由中台下发、引擎侧无本地关闭开关；**不靠 `scope.locked` 标记**（该标记挡不住用户新增同名项）。能力与策略由中台每轮下发（对齐现有 `sopPolicy()` 的路径），本地配置只能收紧不能放宽。
3. `capability dump` 固定三栏输出：**分层来源 / 生效值 / 凭据占位符**。凭据以 `{env:NAME}` 一类的占位符呈现，绝不输出明文；三栏必须能回答"这个生效值来自哪一层、是否被下层覆盖、凭据引用的是哪个环境变量"。
4. 逐族规则的**反证用例**是合并实现的组成部分，不是可选测试：每一族必须有一条能证明"用错规则就会失败"的用例（例如同名 MCP 必须整体替换、项目 policy 不得放行中台 deny、无规则默认 ask）。沿用 `mergeConfigWithDisk` 的纯函数 + selftest 真值表形态（同文件 `:53`，由 `renderer.selftest.mjs` 驱动断言），但语义表来自本 ADR 第 1 条。

## 影响面（后果与代价）

- 正向：同名资源的行为可预测（整替换不留残字段）、中台策略不可被本地放宽、dump 可审计且不泄露凭据；与 §12.2 H2/H3 的裁决一致，未占用 `scope.locked` 这条被否决路径。
- 代价：resolve 必须从"一个 merge"拆成按族分派的合并器，配置 schema 要显式标注每个字段所属族；dump 需要与环境/凭据存储约定占位符语法。后续增量入口：新增字段族必须同时给出合并规则与反证用例，否则视为契约缺口。
- 验收：合并器的每族反证用例以纯函数 selftest 执行（不靠文本契约），dump 三栏用"注入明文凭据后输出不得包含该明文"的断言；外部项目 evidence 逐格对齐 strategy §12.2 表，不跨项目挂名（§12.6）。

## 替代方案（被否）

- 统一"列表追加"：同名 command/MCP 会残留上层字段，与 opencode/dsh 的整替换语义冲突（H2 实证）。
- 靠 `scope.locked` 标记实现 managed：用户新增同名项即可绕过，opencode `config.mdx:60-64` 已证伪（H3 实证）。
- dump 打印生效配置全文（含凭据明文）：把审计工具变成凭据泄露面；三栏 + 占位符是更低风险的可审计形态。

## 回滚

- 合并器尚未上线时，回滚 = 保留现有 `mergeConfigWithDisk` 的磁盘覆盖语义、能力作用域链不启用，配置回到中台基线 + 用户草稿。
- 已上线后**不允许把某一族改回笼统追加/覆盖**（会重新引入 H2 的同名残留缺陷）；只允许整体关闭作用域解析并落到 fail-closed 默认 `ask`，再由运维按层恢复。
- dump 若被发现输出凭据明文，立即停用 dump 端点、回退到既有审计日志查看方式；`agent-approvals.service.ts:55` 的四键策略指纹保持不动，避免回滚误伤存量审批授权。

## 分步计划

1. 定 schema：在 manifest 封闭键上标注每个字段所属族（标量 / map / 列表追加 / 同名整替换 / policy），provider 条目来源对齐 `ai-providers.ts:42` 的 `AiProviderEntry`；产物是字段族清单 + schema。
2. 实现逐族合并器：纯函数 + 真值表 selftest，每族一条反证用例；沿用 `config-merge.ts:53` 的纯函数形态，语义表取本 ADR 第 1 条（不复用其业务语义）。
3. 接 managed 名单与策略引擎：名单内项引擎侧不可 disable；策略键与 `agent-approvals.service.ts:55` 的指纹键集对齐但**不复用四眼身份判定**，使档位收回能独立失效。
4. 落 dump 三栏 + 明文凭据注入断言；最后做一次反方复核（同名整替换 / policy 只收紧 / 默认 ask 三例必过）再宣告完成。

## 明确不做

- 不复用 `mergeConfigWithDisk` 当作用域链合并器（它是桌面配置表单语义，见动机）。
- 不靠 `scope.locked` 实现 managed，resolve 判定条件里不读取该标记。
- 不在 dump 打印凭据明文或完整生效配置，不新起一套配置 schema 体系。

## 可验证约束

- 逐字段族合并规则每条都有 selftest 反证用例的落点（新增 `capability-merge.selftest.mjs`，形态对齐 `apps/executor-desktop/src/renderer/renderer.selftest.mjs` 对 `config-merge.ts` 的驱动方式）：标量替换 / map 按 key / permission·skill·plugin 追加 / command·MCP 同名整替换 / policy 只收紧 / 无规则默认 ask —— 六条各一条反证。
- managed：存在"名单内项在引擎侧无法 disable"的断言；`scope.locked` 不得出现在 resolve 判定条件中（文本 + 行为双重检查）。
- dump：三栏字段齐全 + 明文凭据不出现在输出中。

## 关联

- 计划项：strategy §12.2 H2/H3、§12.3 N2/N3、§4.1/§4.2
- 相关 ADR：ADR-020（工具分级与边界闸门）、ADR-041（治理档位 × 引导强度正交）
