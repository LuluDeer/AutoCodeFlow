# R329 独立验收复核 —— 生产启用断点 B2 修复 + 启用文档

> **受众**：lead / 接手维护者 · **状态**：独立验收结论（工作树，未发布） · **最后核对**：2026-11-21
> 本文只复核 R329 三切片（后端 status 四态 / UI 告警与重授权 / runbook 与发布文档挂链），不改任何实现、spec、既有 docs 或 baseline。
> 最高验收级别：静态探查 + 单测/内存替身 + 文档守卫；本轮无 e2e，未做真库（理由见 §7）。

## 0. 结论摘要

- 6 项清单全部 PASS；无 P0、无 P1。PM 红线（禁止自动授权）未被触碰。
- 建议关闭 R329 验收。遗留 2 项 P2 / 2 项 P3 均为文档行号/措辞陈旧，非代码缺陷；本报告自身需 lead 在入口挂链（我的写域不含 README）。

## 1. B2 真修复（PASS）

- `apps/admin-api/src/modules/agent/agent.controller.ts:1079-1083`：`!systemEnabled → gate_off`，`knownExecutorCount === 0 → no_executors`。因此 `no_executors` 只在「总闸开 + 已知执行器为 0」时出现；总闸关闭一律 `gate_off`，不会误报。
- `apps/admin-api/src/modules/agent/agent.controller.ts:1084-1116`：`secretsCrypto` 缺席（`1084-1089`）或 `deriveAnonymousId` 返回 null（`1100-1111`）均记 warn 并降级 `partial`，不伪造 `full`。只有全部已知指纹派生的匿名 id 都在授权集合中（`1113-1114`）才报 `full`。
- 已知数口径 `apps/admin-api/src/modules/agent/agent.controller.ts:1067-1076`：executors 表取 `deviceFingerprint` 去重计数，空指纹不计；与 consent 全量路径 `apps/admin-api/src/modules/agent/agent.controller.ts:941-961` 同源。
- `apps/admin-api/src/modules/agent/dto/agent-telemetry.dto.ts:118-126`：DTO 声明 `knownExecutorCount` 与四态 `coverage` 枚举。
- spec 抽查：`apps/admin-api/src/modules/agent/__tests__/agent-telemetry-consent.spec.ts:437-450`（gate on + 0 executor → no_executors）、`:491-522`（部分授权 → partial）、`:524-567`（派生失败即便有 2 条授权行仍 partial）、`:569-610`（去重且不泄漏原始指纹）均断言到位。后端 18/18 绿。

## 2. 隐私边界：无自动授权（PASS，无 P0）

- 生产代码里唯一的授权写入点是 `apps/admin-api/src/modules/agent/agent.controller.ts:1011` 的 `this.telemetryOptin.grant(...)`，位于显式 `POST /agent/telemetry/consent` 处理器 `apps/admin-api/src/modules/agent/agent.controller.ts:974-1045` 内；该端点由 class 级 `@Roles(UserRole.ADMIN)` + `JwtAuthGuard` 守护（`apps/admin-api/src/modules/agent/agent.controller.ts:155-157`）。
- CodeGraph `callers setTelemetryConsent` 只有路由引用与 spec，无其它生产调用方；executor 注册面 `apps/admin-api/src/modules/executor/executor.service.ts` 全文无 telemetry/optin/grant 写入（仅 3 处无关注释）。
- coverage 计算 `apps/admin-api/src/modules/agent/agent.controller.ts:1063-1131` 全程只读：只有 `find` 与集合比较，无 upsert / grant / save；spec `:402-435` 显式断言 status 调用后 `grant` 与 `config.upsert` 均未被调用。
- UI 重授权 `apps/admin-web/src/pages/settings/TelemetrySettings.tsx:120-130` 的 `onClick` 才触发 `submitConsent(true)`，请求体 `apps/admin-web/src/pages/settings/TelemetrySettings.tsx:95-96` 为 `{optIn, source:'admin-ui'}`，不带 `installIds` ⇒ 后端按全量 executor 重授权。无 useEffect / 挂载自动触发。

## 3. UI 显式性（PASS）

- 重授权按钮 `apps/admin-web/src/pages/settings/TelemetrySettings.tsx:120-130`：普通 `Button` + `onClick`，不经 Popconfirm 但也不是自动；仅在 `no_executors`（`:215-224` warning）与 `partial`（`:225-237` info）告警的 `action` 上出现。
- 全量 consent 的语义锚点：点击断言在 `apps/admin-web/src/__tests__/telemetry-settings.test.tsx:223-235`，断言 `telemetryConsent` 收到 `{optIn:true, source:'admin-ui'}` 且 status 重取。
- 覆盖率行不隐藏：`apps/admin-web/src/pages/settings/TelemetrySettings.tsx:206-210` 无条件渲染；`:247-254` / `:256-261` 用例证明 full / gate_off 下 `telemetry-coverage-value` 仍在且无告警。
- 非管理员降级：`apps/admin-web/src/pages/settings/TelemetrySettings.tsx:108-112` 在 hooks 固定顺序之后提前返回 adminOnly Alert；`:263-270` 用例证明不发 status 请求、无 Switch / 表格 / 告警 / 重授权按钮 / 覆盖率行。前端 13/13 绿。

## 4. 测试有效性反证（PASS）

- 后端：`apps/admin-api/src/modules/agent/agent.controller.ts` 临时把 `coverage = "no_executors"` 改为 `"partial"`，jest 定向 B2 用例 exit 1（`Expected: "no_executors" / Received: "partial"`，spec:449）；镜像还原后 sha256 `26dcdedf235c09689d71bcd50336848ef77c1415bb4dc2a3d348cfd91926739f` 前后逐字一致。
- 前端：`apps/admin-web/src/pages/settings/TelemetrySettings.tsx` 临时把告警守卫 `coverage === 'no_executors'` 改为 `'full'`，vitest 定向用例 exit 1（`findByTestId('telemetry-coverage-alert')` 超时，test:226）；镜像还原后 sha256 `f450e0be3f367731fc1df39fccc0d765183b37d07fd4980a50ca0191fc0b15ac` 前后逐字一致。
- 反证只改动临时镜像副本对应的工作文件并立即按 sha 还原；spec / 测试文件从未改动，原文件字节未变。

## 5. 文档准确性（PASS，含陈旧项）

抽查 5 处（runbook 声明 → 实际）：

| 抽查点 | runbook 声明 | 实际 file:line | 结论 |
|---|---|---|---|
| 迁移脚本名 | `1790000000101-AddFunnelEvents.ts:39` / `1790000000102-AddTelemetryOptin.ts:36` | 建表分别在 `apps/admin-api/src/migrations/1790000000101-AddFunnelEvents.ts:39`、`apps/admin-api/src/migrations/1790000000102-AddTelemetryOptin.ts:36`；唯一索引 `:56` / `:48` | PASS（指纹列 `install_id` 实际在 `:41`，文档写 `:42`，P3 off-by-one） |
| `SEC_SECRETS_KEY` 影响 | `secret-crypto.util.service.ts:153-159` HMAC 派生、`:154` 空 key 返 null；consent 派生失败 503 | `apps/admin-api/src/common/utils/secret-crypto.util.service.ts:153-159`、`apps/admin-api/src/modules/agent/agent.controller.ts:993-999` 与 `:953-960` | PASS |
| consent 端点路径 | `POST /agent/telemetry/consent`，`agent.controller.ts:974` / `:977-1045` | `apps/admin-api/src/modules/agent/agent.controller.ts:974`、`:977-1045`；source 枚举 `apps/admin-api/src/modules/agent/dto/agent-telemetry.dto.ts:18-21` | PASS |
| status coverage 字段 | DTO `agent-telemetry.dto.ts:118-119` / `:121-126`；端点 `agent.controller.ts:1047` / `:1050-1071` | DTO 两处 PASS；端点 `:1047` PASS，但方法体实际 `apps/admin-api/src/modules/agent/agent.controller.ts:1050-1132`（coverage 计算在 `:1063-1116`，返回在 `:1129-1130`） | P2：文档行号范围陈旧，且 §3.1 仍写「切片①②正在落盘 / 旧构建可能暂不返回」，当前构建已返回（有「以当前构建实际返回为准」兜底，非虚假完成声明） |
| `installId` 误传警告 | `agent.controller.ts:936-939` 原样落库、不派生 HMAC | `apps/admin-api/src/modules/agent/agent.controller.ts:936-939` | PASS |

另外：runbook §2.1 的 Popconfirm 行号 `TelemetrySettings.tsx:211-227` 实际为 `apps/admin-web/src/pages/settings/TelemetrySettings.tsx:239-255`（R329 插入告警后未同步），P3。

诚实性：`docs/plan/north-star-enablement.md:3` 标「状态：发布前置」、`:17` 标「发布前置勾选项」、`:167` 明确「本文不声称已完成生产启用」，未假称已发布/已启用。`docs/AGENT_HANDOFF.md` 顶部仍是 R328，R329 交接段未落（lead 写域，非本轮缺陷）。

## 6. 守卫（PASS，报告落盘前）

- `npm run test:docs` → exit 0（check-docs selftest + 主跑；doc-style selftest 30/30 + 主跑：单 H1 / 层级 / 空表格 / 新鲜度 / 围栏语言全过）。
- `npm run check:metric-docs` → exit 0（selftest 22/22；注册表 53 / 文档 53，基线欠账 0；runbook 里的 `autoflow` 库名已带 ignore-unknown 标记）。
- `npm run lint:i18n` → exit 0（i18n-scan selftest 9/9；缺键守卫静态键 3380，与 zh/en 键集无新增缺失）。
- 注意：本报告新建于 `docs/plan/` 且未被入口链接，`check-docs` 的 orphan 判据会点名本报告；需 lead 集成期在 README 挂链（我的写域不含 README）。挂链前守卫全绿。

## 7. 缺口分级与验收级别

- P0/P1：无。
- P2（文档陈旧，建议本轮或下轮修）：runbook §3.1 `telemetryStatus` 行号 `:1050-1071` 应为 `:1050-1132`；「正在落盘」措辞应改为「已落盘」。
- P3（行号漂移，可顺手修）：迁移脚本 `install_id` 列行号 `:42`→`:41`；§2.1 Popconfirm 行号 `:211-227`→`:239-255`。
- 验收级别：静态探查（CodeGraph 1.6.2 + 源码）+ 单测/内存替身（后端 18/18、前端 13/13、两次定向反证有牙）+ 文档守卫（3 条全绿）。coverage 四态是纯集合运算（fingerprints 去重集 × authorized 集），真 PG 只能再验证两条 `find` 的查询语义，而查询本身本轮未改；故静态 + 单测级已足够，本轮未做真库、无 e2e（诚实降级，不冒充进程内集成级）。
- 建议：关闭 R329 验收；P2/P3 由 lead 集成期随 README 挂链一并处理。
