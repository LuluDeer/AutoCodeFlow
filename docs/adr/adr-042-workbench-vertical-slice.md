# ADR-042: 三端职责划分与纵向切片优先

状态：Accepted
- 日期：2026-11-26

## 动机（背景与判据来源）

strategy §3.3 的"三端一号"与 §12.3 N1/N26 规定：Workbench（业务工作台）是**第三入口**，不是替换既有入口；外部 agent 以"不改内核、只原子改写配置一个 key、中台下发 baseUrl/key 指针"的旁路接入，与现有 56 工具 MCP 反向编排旁路**并存**，不把"迁移到 Workbench"设为前置。桌面壳的职责按 N26 收敛为窗口与凭证，Web 内容用现有 renderer webview，避免重走 ROADMAP:123 桌面 V2 重写。CodeGraph 核实：现有反向编排 MCP 工具已在 `packages/mcp-server/src/tools/executor.ts:17`（`registerExecutorTools`，经 `packages/mcp-server/src/index.ts`/`tools.ts` 注册）；桌面壳的凭据加密走 `apps/executor-desktop/src/main/token-crypto.ts:71`（`encryptToken`，Electron safeStorage envelope，ADR-012）；`apps/executor-desktop/src/main/agent/runtime.ts:243` 的 `chatJson` 是本地未 export 的函数。

同时，red V5 的证伪质疑（strategy §12.2 H5、§12.3 N4、GCO §11.1 G3/G4、§11.4）指出三处复用踩空：`toolsForSessionKind`（`tool-registry.ts:1455`）是静态 kind×phase 白名单且 chat 不限工具；`sop.draft()` 写的是 SOP 行不是方案卡（`apps/admin-api/src/modules/sop/sop.service.ts:207`，CodeGraph 已核实）；`chatJson` 在 executor-desktop 且未 export（已核实）。且初稿示例 `finance.erp.readonly` 本仓无此能力。故在投入 P2 全量实现前，必须先做一个纵向薄切片证伪"业务人员能否不填技术细节拿到产物"。这是 GCO 全部设计的最便宜证伪方式，优先于任何 P2 实现。

## 决策（方案）

1. 三端职责固定：
   - **Workbench（Web/工作台）**：第三入口，承载意图采集→方案卡→审批→看产物的引导链；不替换 CLI/IM/外部 agent 入口，不把迁移设为前置。
   - **MCP/外部 agent 旁路**：与现有 56 工具 MCP 反向编排旁路并存，外部 agent 通过配置指针接入，不改其内核。
   - **桌面壳（executor-desktop）**：只做窗口管理与凭证保管（safeStorage 加密，沿用 `token-crypto.ts` 的 envelope）；Web 内容用现有 renderer webview，不新建桌面版工作台，不把 Workbench 塞进 executor-desktop。
2. red V5 纵向切片先行（P2 前置证伪闸门，2 周）：选 1 个已有只读能力 + 用**现有 SOP draft/publish 承载方案卡**（`sop.service.ts:207` 起草、controller 的 publish，CodeGraph 已核实存在；只在签名/数据结构层借鉴，承认它写的是 SOP 行不是正式方案卡）+ 现有四眼/digest 确认 + 一页前端（3 业务字段→预览→审批→看产物）。
3. 切片的**触发条件/通过判据**：真浏览器 e2e 断言"不填 cron/UUID/glue 拿到报表"。通过后才解锁后续 P2；不通则整条引导链设计作废重来。
4. 切片阶段**暂不建**：能力注册表、Scope 链、Part 模型、编译 prompt、三档 UI。这些是证伪通过后的增量目标（N1/N2/N7/N10/N11 等），不得提前堆进 MVP。新增"业务会话 kind"若确需引入，必须 fail-closed 并进 tripwire（G3）。
5. 首个 e2e 用已有 API/已就绪文件数据源，不用幽灵能力 `finance.erp.readonly`（G4）；无 API 场景的一等降级（X11 GUI + fromVideo 录屏 N9）属于证伪通过后的实施项。

## 影响面（后果与代价）

- 正向：2 周即可用真浏览器结论决定"继续还是作废"，避免在错误前提上投入整个 P2；三端边界清晰，桌面不重走 V2 重写，外部 agent 不必迁移；方案卡载体复用现有 SOP 落库/发布能力，减少新表。
- 代价：切片阶段的方案卡是临时载体（SOP 行），数据结构与未来正式方案卡不同，后续要迁移；G3 的三处"复用"都只能借鉴签名、机制重写。后续增量入口：e2e 通过后按 §12.3 排期逐项启用注册表/Scope 链/Part 模型/编译 prompt/三档。
- 验收：切片以浏览器级 e2e 为准（真构建产物 + 真浏览器），不以单测或"接口返回成功"代替（strategy §10 / AGENTS.md §4.4）。静态层断言"Workbench 未塞入 executor-desktop"由目录/导入检查承担。

## 替代方案（被否）

- "先建全量注册表"（P1 能力注册表 + Scope 链 + Part 模型 + 编译 prompt + 三档 UI 一次到位）：在最便宜的证伪尚未做时就付全量成本；red V5 指出若业务人员根本拿不到产物，这些全白做。
- 把 Workbench 塞进 executor-desktop / 做成桌面版替换：违反 N26（桌面壳只做窗口/凭证、Web 用 renderer webview）与"第三入口非替换"（N1），并重走 ROADMAP:123 桌面 V2 重写。
- 把工作台设为外部 agent/CLI 的前置迁移条件：ZCode 的 skill/agent 是 workspace 内敛贡献、无外向挂载（§12.6），迁移前置会阻断既有入口用户。
- 直接复用 `toolsForSessionKind` / `sop.draft()` / `chatJson` 当方案卡与编译链：三处均踩空（H5/G3）——静态白名单不限工具、draft 写 SOP 行、chatJson 未 export 且只校验 JSON 合法不校验语义。

## 回滚

- 切片未启动即发现前提不成立（业务人员拿不到产物）：直接作废整条引导链设计，不进入 P2；此时无注册表/Scope 链/Part 模型可回退。
- 切片已启动但 e2e 不通：回退到现有 SOP draft/publish + 四眼审批路径，前端页下线，能力注册表等增量不启用；`sop.service.ts:207` 的 draft 语义保持原样，不把它改造成正式方案卡。
- 桌面壳若被误塞入 Workbench：按 N26 把 Web 内容移回 renderer webview，桌面只留窗口/凭证；凭据加密继续走 `token-crypto.ts:71` 的既有 envelope。

## 分步计划

1. 选 1 个已有只读能力 + 已有 API/就绪文件数据源（禁用幽灵能力 `finance.erp.readonly`）；若涉及模型渠道，沿用 `ai-providers.ts:42` 的既有 `AiProviderEntry` 条目。
2. 用现有 SOP draft/publish 承载方案卡：只借鉴 `sop.service.ts:207` 的签名与落库路径，明确它写的是 SOP 行，机制层另做。
3. 接现有四眼/digest 确认（`agent-approvals.service.ts:55` 的 4 键策略指纹参与授权失效判定，但不复用其"处置人身份"语义）。
4. 做一页前端（3 业务字段→预览→审批→看产物），以真浏览器 e2e 断言"不填 cron/UUID/glue 拿到报表"为唯一通过判据；通过后才按 §12.3 排期启用注册表/Scope 链/Part 模型/编译 prompt/三档。

## 明确不做

- 不在切片阶段建能力注册表、Scope 链、Part 模型、编译 prompt、三档 UI。
- 不把 Workbench 塞进 executor-desktop，不设"迁移到 Workbench"为前置条件。
- 不直接复用 `toolsForSessionKind` / `sop.draft()` / `chatJson` 当方案卡与编译链，不引入幽灵能力 id。

## 可验证约束

- 真浏览器 e2e 断言："不填 cron/UUID/glue 拿到报表"通过，是切片唯一通过判据。
- 范围断言：切片产物目录/导入检查确认未新建注册表/Scope 链/Part 模型/编译 prompt/三档 UI；Workbench 不在 executor-desktop 内实现。
- 三端职责断言：MCP 仍以 `registerExecutorTools`（`packages/mcp-server/src/tools/executor.ts:17`）提供反向编排工具；桌面凭据仍走 `token-crypto.ts` 的 safeStorage envelope；新增"业务会话 kind"若出现则 fail-closed 并进 tripwire。
- 首个 e2e 数据源断言：使用已有 API/就绪文件，不引用幽灵能力 id。

## 关联

- 计划项：strategy §3.3、§10、§12.2 H5、§12.3 N1/N4/N26、GCO §11.1 G3/G4、§11.4
- 相关 ADR：ADR-020（工具边界）、ADR-041（scope.mode × guidance.level 正交；切片阶段三档 UI 暂不建）
