# ADR-044: 企业管控 + 客户端自主工作台的治理边界

状态：Accepted（决策为"引擎级 restrict deny 管硬边界 + 白名单内客户端自主 + 事件代际管在途失效"）
- 日期：2026-11-26

## 动机（背景与判据来源）

用户明确最终场景：**企业有统一权限管控，客户端保留一定自主权当成普通 agent 工作台使用**。这正是 strategy §4.2 三档治理（managed/supervised/self_service × L1/L2/L3）与 GCO §3 引导链要落地的真实目标。strategy §12.3 剩余 N11/N14/N21/N22/N24-P4/N26 均卡在 needs_adr/needs_decision，历史上反复推迟，缺一份统一裁决把边界写死。

本 ADR 的证据来自 4 路 agent 对 `/data/project/opensource` 五个项目（opencode/ZCode/magpie/Octop/deepseek-harness）的深挖，逐条带 file:line：

1. **硬策略必须引擎级、不可被配置关掉**：opencode `services/site/src/docs/content/config.mdx:60-64` 明说"settings 挡不住用户新增 provider/MCP/agent/plugin"，必须靠 managed policies；`policies.mdx:301-326` policy plugin 不可 disable、Console 断连保留上次策略。ZCode `contracts/src/config/index.ts:157-175` 六 scope 里 System 只是默认基线，真正不可越界需独立 policy 层。
2. **policy 只收紧**：opencode `packages/core/src/permission/policy.ts:28-37,58-64,87-99` 四语义（rules/override/restrict/fallback）中 restrict deny 单调不可撤销，`allow` 只抵消更宽的 deny；`policies.mdx:114-152` tool.use deny 覆盖 ask 与 Allow always。
3. **客户端自主在白名单内追加**：ZCode `adapters/src/config/config-merger.ts:164-204` + `docs/hooks-runtime-contract.md:69-77` hooks events 按来源追加、enabled 取 OR——单个来源 enabled:false 关不掉别的来源；未准入不生成可执行 callback。
4. **出域进程级统一**：dsh `docs/subsystems/outbound-proxy-policy.zh.md:17-21` 单一全局 dispatcher 覆盖所有 fetch（模型/web search/HTTP MCP），项目 .env 不能改路由；magpie `internal/library/claude_plugins.go:76-103` 拒绝带 token/headers 的不可移植 source；Octop `infra/skills/skillhub_common.py:22-56` 非法 origin fail-closed 不回公网。
5. **在途失效靠事件+wait 门禁**：dsh `ptc-runtime-node/src/policy-processes.ts:15-35,43-63` 订阅 sandbox/mode 变更即 invalidate 在途进程 + wait 阻塞新准入，失败重试不回滚策略；opencode `permission/policy.ts:204-240` scopedRules 只解决"下次 check 用新策略"。
6. **Plan 是闸门不是独立权限**：ZCode `docs/plan-mode-approval-boundary.md:15-36,44-53` Plan 闸门+原模式两层、闸门只收紧、放行回原模式；历史 bug = Plan 下只读工具裸跑、destructive MCP 在 yolo 下也须恒拒；`contracts/src/tools/plan-mode.ts:35-43` allowedPrompts 是意图/类别级，第一版不自动写 permission rules。

## 决策（方案）

**统一决策：硬边界走引擎级 restrict deny（不可被 scope.locked / CLI flag / 项目 allow / 客户端 enabled:false 撤销）；客户端自主限定在中台白名单内，可追加能力/接收人/挂载但不可删改中台下发项；在途失效走"事件 invalidate + wait 门禁 + 读时 epoch 校验"，非定时轮询。**

逐项裁决：

- **N21（分级标签 + 出域）**：出域做成引擎级二元硬策略（`provider.use`/`provider:` resource 语义）+ 进程级统一出域；数据分级标签（`public|internal|sensitive`）作为 policy resource 第二维，sensitive 能力禁止公网 source；来源白名单 fail-closed（禁 userinfo/headers/命令型 scheme、非法 origin 不回退公网）；等保持 external。默认姿态 supervised+L2，危险/出域能力 managed+L1。
- **N11（Plan 身份）**：Plan 是"闸门只收紧 + 放行回原模式"，只读靠 restrict deny 而非 UI/提示词；allowedPrompts 意图级且不落永久规则；一次 plan 批准 = once + scope/guidance 版本，禁止 allow_all（与 N17 once+TTL 无 all 一致）；destructive 在 plan 下恒拒（即使原模式 yolo）。
- **N14（在途策略即时失效）**：采纳 ADR-043 方案 A 并补齐"在途 interrupt 门禁"——generation 变更即事件（唯一写路径），工具执行前闸做 invalidate + wait，成功后按新 generation 重算；跨实例 5s TTL 仅兜底、读时 epoch 为正确性来源；保留 scopedRules 的 ask/deny，否决全局 DENY 与混用 approval 指纹。重开条件仍按 ADR-043。
- **N22（SLA 告警）**：告警渠道是中台 managed 固定目标（URL/密钥中台持有），项目只能追加接收人、不能用 enabled:false 关掉中台告警；判定与发送分离，告警通道本身受策略约束且 fail-closed（无可用 channel 不静默当成功）。
- **N26（独立 CLI / 客户端自主）**：CLI 只做"列能力 / 按 agent 挂载 / 启停 / 提交审批"四类命令，不承载工作台 UI、不改 executor-desktop 四页；CLI 与 Workbench 共用同一 capability resolveFor/policy 引擎，CLI scope 可提高普通配置优先级但硬策略由 managed restrict 层先于 CLI 求值；不改造执行器为业务入口（ADR-042）。
- **N24 P4（进程外隔离）**：进程外 host/IPC 触发条件为"出现第三方不可信能力"或坏版本回退需求，当前一等代码不做；本轮先把 slots/streams 上限收口到配置层与 enforcement 事实，坏版本回退用 N23 disposer 语义，不做非等价 rollback 伪装。

- **N27（客户端形态定位，2026-11-27 operator 明确）**：**只有 desktop 客户端提供工作台 UI，供公司内业务人员使用**；`executor-node` 与 `executor-python` **只做 headless 执行器模式**（注册/心跳/拉取/回调/usage 上报），不承载工作台、不做业务入口。这条把 N26「不把工作台塞进执行器」从 CLI 推广到全部 headless 执行器；后续客户端侧功能规划按此边界——业务人员体验只在 executor-desktop 四页迭代，node/python 只按执行正确性（协议/回调/usage）验收。

## 影响面（后果与代价）

- 正向：一次固化六项裁决，避免后续会话反复探查同一批 needs_adr；给出企业管控与客户端自主的清晰分界——中台只守"硬边界 + 审计 + 白名单"，客户端在白名单内自建/挂载/追加接收人，两边都真。
- 代价：引擎级 policy 接线比配置标记复杂（需 evaluateAll 多资源 any-deny + 事件代际），但复用本仓已落地的 `scope-engine.ts` 四语义、`inprocess-gate.ts` classify/budget/degrade、N23 generation-swap disposer，无另造体系。
- 验收：每项实施后按 AGENTS §4.4 分级验收——来源白名单/分级标签至少真 PG 数据层断言（PG 落新值 + 跨源被拒 + dump 不泄露明文）；在途失效必须真 PG 进程内 e2e；CLI/告警至少真子进程 selftest，不以"接口 200"代替副作用断言。

## 替代方案（被否）

- **用 `scope.locked` 当硬约束**：opencode config.mdx:60-64 实证挡不住用户新增同名项；ADR-040 已定 managed 靠策略名单 + 引擎不可 disable，本 ADR 延续。
- **客户端自带本地 policy 实现**：形成 opencode 警告的绕过面；所有入口必须走同一 resolveFor/policy 引擎（dsh 单一 dispatcher 同理）。
- **定时轮询代替事件代际**：读时 epoch + 事件 invalidate 才是正确性来源（dsh PolicyProcesses / Octop chatStore epoch 实证）；TTL 只兜底。
- **Plan 用独立权限系统或 UX 折叠开关**：ZCode 历史 bug 证明 Plan 下独立放行会绕过原模式 ask/deny，形成提示注入面。
- **现在就做进程外隔离**：本仓能力是一等代码，过早引入 IPC/坏版本复杂度（magpie Bun host 是给第三方插件的），无规模触发即空转。

## 回滚

- 本 ADR 主体是决策固化；配套实现逐项可独立回滚：来源白名单/分级标签以 feature 开关或 remove 新增校验函数即回旧行为（旧 source 类型仍在白名单内）；Plan gate 缺席时 runtime fail-open 到既有行为；SLA consumer 不注册即无告警副作用；CLI 命令不动 executor-desktop 四页。
- 数据层（若加 dataClass 列）用可空列 + 存量 NULL 视为 public，迁移 down 仅 DROP COLUMN，不回填、不破坏存量能力。

## 分步计划

1. （本 ADR）固化六项裁决 + strategy/GCO 状态指向本 ADR。
2. N21 来源白名单 + 分级标签底座（本轮主控实现）：source-policy 加 `assertOriginAllowed`（禁 userinfo/headers/命令型 scheme、非法 origin 不回公网）+ 分级标签绑定；capability.service 接线；真 PG 数据层反证。
3. N11 Plan gate / N22 SLA consumer（本轮 agent 并行实现纯函数与 consumer，主控集成接线）。
4. N14 方案 A 按 ADR-043 重开条件单独立项；N24 P4 / N26 待触发条件，不在本轮硬做。

## 明确不做（本轮）

- 不改 executor-desktop 四页；不把工作台塞进执行器（ADR-042 硬约束）。
- 不做进程外 host / IPC / 坏版本非等价 rollback。
- 不做 allow_all 永久授权、不把 allowedPrompts 落成永久 permission rules。
- 等保二/三级认证、真实 IM 回调/加解密、autoUpdate 实际拉取、生产样本——均 external，不写进交付。

## 证据锚点

- `opencode/services/site/src/docs/content/config.mdx:60-64,99-110`（managed settings 挡不住新增、policies 反向 precedence）
- `opencode/packages/core/src/permission/policy.ts:28-37,58-72,87-99,204-240`（四语义只收紧、scopedRules）
- `deepseek-harness/packages/ptc-runtime/ptc-runtime-node/src/policy-processes.ts:15-35,43-63`（在途 invalidate + wait 门禁）
- `deepseek-harness/docs/subsystems/outbound-proxy-policy.zh.md:17-21`（进程级统一出域、项目 .env 不改路由）
- `ZCode/docs/plan-mode-approval-boundary.md:15-36,44-53`（Plan 闸门+原模式、destructive 恒拒）
- `ZCode/packages/adapters/src/config/config-merger.ts:164-204`（按来源追加、单源 enabled:false 不关别的来源）
- `magpie/internal/library/claude_plugins.go:76-103`（拒带 token/headers 的不可移植 source）
- `Octop/infra/skills/skillhub_common.py:22-56`（非法 origin fail-closed 不回公网）
- 本仓：`apps/admin-api/src/modules/capability/scope/scope-engine.ts:250-313`（四语义已实现）、`capability/inprocess-gate.ts:180,286,373`（classify/budget/degrade 已接线）、`workbench/scoped-rules.ts:101`（已落地分类）、`ADR-040/041/042/043`（既有决策）
