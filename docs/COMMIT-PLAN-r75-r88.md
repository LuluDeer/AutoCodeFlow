# 提交方案 · 工作台改造第 75–88 轮（develop 未提交改动）

> **受众**：operator（提交决策者） · **生成**：第 89 轮 · **状态**：方案就绪，未执行任何 git add/commit/push
> 本文把 develop 上 14 轮累积的 71 个未提交文件，按「编译/守卫强依赖」切成 **7 个原子单元 + 3 个可独立提交组**，给出拓扑序与每组验证命令。两路独立调研交叉验证：一路做主题分组，一路用 `/tmp` 临时副本 + 守卫 `--root` 反证拆开后果。**不要按主题（TTFV/发布/驾驶舱）拆生成物单元——必红。**
>
> **增量提示（第 89–92 轮）**：本方案覆盖第 75–88 轮。第 89–92 轮又新增：① `COMMIT-PLAN-r75-r88.md` 自身；② 审批发起三态诚实化的后端/前端/生成物/测试；③ 价目表管理 UI；④ **审批发起失败跨角色闭环**（workbench.controller.ts 失败审计、release-retry.controller.ts 新 `POST /release-approvals/request` 端点、api/audit.ts、ReinitApprovalButton.tsx、AuditDetailFooter.tsx、新审计 action 词条、openapi/api-types/en-map/api-reference 的 request hunk 及 4 个新 spec/test）。这些**沿用同一分组规则**：DTO/生成物 hunk 归 U1（与 TTFV/retry/approvalStatus 生成物同批，不可拆）、controller+service+审计+测试归 U3、前端页面/locales/组件归 U4、新增 e2e spec 归 U5、纯文档自身独立。提交前按本方案逐组验证命令复跑即可，无需为新文件改分组结构。

---

## 1. 为什么是这套切分（3 条硬约束）

1. **`api-types-drift` 是重生成 + diff 硬闸**（ci.yml:3064-3079）：`swagger:export && git diff --exit-code -- openapi.json`、`gen:api-types && git diff --exit-code -- api-types.ts`。TTFV 与 retry 两个主题的 hunk **交织在同一批生成物里**，任何只含一半生成物的中间提交都会因「重生成结果与入库产物不符」转红 ⇒ 必须一个原子单元一次提交。
2. **HEAD 的 `lint:i18n` 本来就是红的**（实测把 5 文件恢复 HEAD 后 `i18n-scan --check` exit 1）——U4 是「转绿提交」，不是可选清理。在它落地前 CI 必红。
3. **基线登记与触发源共生**：`check:enum-drift`、`check:source-text-contracts`、`check:interface-maps`、`check-atlas-counts` 都是「新增即红」棘轮——触发源（const-object / 读源码 spec / 新审计动作 / 新 e2e spec）必须与登记/标签/计数同提交。

---

## 2. 原子单元（必须整组提交，不可拆）

按提交顺序（拓扑序，被依赖的在前）：

### U1 · API 契约单元（根，必须最先）
- **文件**：`apps/admin-api/src/modules/agent/dto/agent-north-star.dto.ts`、`apps/admin-api/src/modules/workbench/release-retry.controller.ts`、`apps/admin-api/src/modules/agent/agent.controller.ts`、`apps/admin-api/openapi.json`、`apps/admin-web/src/types/generated/api-types.ts`、`docs/api-reference.md`、`scripts/api-i18n/data/openapi-en-map.json`
- **为什么原子**：重生成 diff 闸（上面约束 1）。openapi 注入步骤串在 `swagger:export` 里，en-map 缺 17 条则检查红。
- **提交信息**：`chore(api): 同步 OpenAPI/生成类型/英文词条/接口文档（TTFV 三态与发布重试端点）`
- **提交前验证**：`npm run swagger:export && npm run gen:api-types && npm run gen:api-reference && npm run check:api-i18n && npm run check:api-reference && npm run check:web-type-drift && npm run check:web-type-field-drift`（应全绿且 `git diff` 无新增变化）

### U2 · TTFV 后端 + 登记（U1 之后）
- **文件**：`apps/admin-api/src/modules/agent/runtime/ttfv-metrics.ts`(新)、`north-star-metrics.service.ts`、`runtime/__tests__/ttfv-metrics.spec.ts`(新)、`runtime/__tests__/ttfv-api-contract.spec.ts`(新)、`scripts/check-enum-drift.mjs`、`scripts/source-text-contracts.json`
- **为什么原子**：`TTFV_DATA_STATUS` const-object 需 enum-drift ALLOWLIST（+2 条，含 `SOP_RELEASE_AUDIT_ACTIONS`）；两个 spec 读 `scripts/ttfv-real-metrics.mjs` 源文本需 STC-129/130 登记。
- **提交信息**：`feat(admin-api): 接入 TTFV 真实口径三态指标与逐字同源断言`
- **验证**：`npm run check:enum-drift && npm run check:source-text-contracts`

### U3 · Release 后端 + 前端消费（U1 之后，U2 之后更顺）
- **文件**：`apps/admin-api/src/modules/workbench/release-approval.service.ts`、`release-retry.controller.ts` 的后端配套在 U1；本单元含 `workbench.module.ts`、`runtime/release-outcome.audit.ts`(新)、`runtime/__tests__/release-visibility.spec.ts`(新)、`workbench/__tests__/release-approval-persist.spec.ts`(新)、`workbench/__tests__/release-retry.spec.ts`(新)、`apps/admin-api/test/release-restart-recovery.e2e-spec.ts`(新)、`release-cross-instance.e2e-spec.ts`(新)、`release-cross-instance.review.md`(新)、`release-retry.e2e-spec.ts`(新)；前端 `apps/admin-web/src/api/audit.ts`、`components/audit/RetryReleaseButton.tsx`(新)、`AuditDetailFooter.tsx`(新)、`pages/audit/index.tsx`、`pages/audit/resourceOptions.ts`、`__tests__/retry-release-button.test.tsx`(新)；`apps/admin-api/src/modules/capability-activation/__tests__/capability-activation*.spec.ts` 三个 ApiQuery mock
- **为什么原子**：`RetryReleaseResult` 依赖 U1 生成类型；新审计动作 `sop_publish.release_*` 需前端 ACTION_LABEL_KEYS + zh/en 词条（`check:interface-maps` §④）；`SOP_RELEASE_AUDIT_ACTIONS` 豁免在 U2 的 enum-drift 里（故 U2 先于/同批 U3）。三个 capability-activation spec 的 `ApiQuery: deco` 是 HEAD 遗留红灯修复，可跟本组。
- **提交信息**：`feat(admin-api): 发布批准必达、跨实例恢复与一键重试（ADR-045）`
- **验证**：`npm run check:interface-maps && npm run check:mutation-residue && npm run test:agent && npm run test:sop`

### U4 · 前端 i18n + 驾驶舱（U1 之后；本单元是 CI 转绿提交）
- **文件**：`apps/admin-web/src/locales/en.ts`、`zh.ts`；`api/capabilities.ts`、`api/queries.ts`；`pages/{ActivationStatsPage,CapabilitiesPage,WorkbenchPage,DashboardPage}.tsx`、`layouts/MainLayout.tsx`；`components/dashboard/{ApprovalQueueCard,CostPostureCard,TtfvCard,NorthStarCard}.tsx`；`__tests__/{boss-cockpit,dashboard-role-cards,ttfv-card,north-star-honest,i18n-migration-verify,env-base-url}.test.tsx`(新为主)；`e2e/{boss-cockpit,ttfv-card}.spec.ts`(新)
- **为什么原子**：`lint:i18n` 转绿依赖 5 页面 + 206 词条一次到位；`DashboardPage` import 三新卡、卡片消费新 i18n key、`queries.ts` 三新 hook 相互依赖；`NorthStarCard`/测试夹具读 U1 的 `ttfv` 字段，故 U1 必须先落地。
- **提交信息**：`feat(admin-web): 完成 i18n 迁移并上线老板驾驶舱四卡（诚实标缺/角色化）`
- **验证**：`cd apps/admin-web && npm run lint:i18n && npx tsc -b && npx vitest run`（应全绿）

### U5 · 真栈 e2e + atlas 计数（U2/U3/U4 之后）
- **文件**：`apps/admin-web/e2e/legacy/e2e-release-chain-fullstack.spec.js`(新)、`scripts/check-atlas-counts.mjs`、`docs/atlas/07-testing/e2e-testing.md`、`scripts/e2e-full.sh`
- **为什么原子**：`check-atlas-counts` 三方硬核对（spec 四份 / 文档 52 例 / 守卫常量 `E2E_SPECS`），「全有或全无」，不存在先提交文档再补 spec 的安全中间态。
- **提交信息**：`test(ci): 发布审批链真栈 e2e 并同步全链计数（52 例）`
- **验证**：`npm run check:atlas-counts && npm run test:docs`（真栈 `bash scripts/e2e-full.sh` 可选复验，约 2.8m）

### U6 · env 模板守卫（独立，任意位置）
- **文件**：`.env.example`、`apps/admin-web/.env.example`、`apps/admin-web/README.md`、`deploy/README.md`、`docs/atlas/06-infra/env-vars.md`、`docs/atlas/01-apps/admin-web/api-layer.md`、`docs/atlas/01-apps/admin-web/e2e-and-conventions.md`、`apps/admin-web/src/__tests__/env-base-url.test.ts`(新)
- **为什么**：env-base-url.test 逐字读两个模板（单向：模板先/同提交即可）；其余纯叙述。
- **提交信息**：`fix(config): admin-web API 基址统一为同源 /api（模板/文档/单测）`

### U7 · CI 守卫接线（独立，任意位置）
- **文件**：`package.json`（test:guards:chain 尾追加 `test:agent`/`test:sop`）、`scripts/agent-boundary-check.mjs`、`scripts/agent-sop-check.mjs`
- **为什么**：两个清单各加 `tool_search` 排除（同源逐字一致）；`test:guards:selftests` 已含这两条，接线后本地链也覆盖。
- **提交信息**：`fix(ci): 登记 tool_search 排除并纳入守卫链防复发`

---

## 3. 可独立提交组（无硬依赖，收尾）

- **G-DOCS**：`docs/AGENT_HANDOFF.md`、`docs/PROJECT-STATUS.md`（汇总 14 轮，最后提交）。`docs/api-reference.md` 已在 U1（不可移出）。
- **G-SCHEMA-BASELINE**：`scripts/openapi-response-schema-baseline.json`——源码实证「不提交也不红」（只在倒退时红，覆盖提升只写 note）；棘轮卫生建议跟 U1，但不强制。
- **G-CROSS-REVIEW**：`apps/admin-api/test/release-cross-instance.review.md` 纯 md 审查报告，随 U3 或独立均可。

---

## 4. 提交顺序总览

```text
U1 → U2 → U3 → U4 → U5 → U6 → U7 → G-DOCS（最后）
（U6/U7 可与 U2–U5 任意交错；G-SCHEMA-BASELINE 建议跟 U1；G-CROSS-REVIEW 跟 U3）
```

**红线（违反必红）**：
- 按 TTFV / retry / 驾驶舱主题拆 U1 的生成物 → `api-types-drift` 红。
- U4 晚于其它组提交 → 在它落地前 `lint:i18n` 一直红（HEAD 基线就是红的）。
- U5 的 spec / 计数守卫 / 文档三者拆开 → `check-atlas-counts` 红。
- U3 的审计写入离开 U2 的 enum-drift 豁免 → `check:enum-drift` 红。

---

## 5. 每次提交前的统一动作

1. 对该组跑「验证」列的命令（全绿才提交）。
2. `git diff --cached --check`（暂存后查格式）。
3. `npm run check:mutation-residue`（它只扫未提交 diff——**一旦提交，标记永久藏进历史**，务必每组提交前对该组单独跑一次，当前全绿）。
4. 全部提交后（未 push）：`npm run test:guards:chain && npm run lint:i18n && bash scripts/e2e-full.sh` 最终确认（约 3–5 分钟）。

---

## 6. 边界与授权

- 本文**只提供方案**，未执行任何 `git add` / `git commit` / `git stash` / `git push`。按仓库规则，提交需 operator 显式指令。
- 文件数说明：`git status --short` 折叠显示为 70 项，`--untracked-files=all` 展开为 71 个真实文件（多出的是 `release-cross-instance.review.md`，纯 md 无依赖）。
- 验证级别：分组依赖结论来自源码 + 守卫判据阅读 + `/tmp` 临时副本反证（未用 stash、未改工作树），非「逐组 checkout 真跑」——后者需 operator 授权后按本方案执行时逐步验证。
