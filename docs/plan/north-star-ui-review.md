# R328 北极星看板 UI 切片独立验收报告

- 验收人：r328-ui-verify（独立 QA/PM 视角，不改 A/B 实现）
- 分支/HEAD：`develop` / `a234863c`
- 验收级别：**静态复核 + 组件测试**；浏览器真机**未做**（环境不具备，诚实降级）

> **状态：切片②已落盘并完成复验（2026-11-21）。** 中途快照的 P0「UI 未交付」已消解——`NorthStarCard.tsx`(9.4KB)/`north-star-card.test.tsx`(5.4KB)/`queries.ts` hook/ Dashboard 接线 / zh-en 各 12 键均已落盘。复验逐条结论见**附录 B**；本报告最终以附录 B 为准，下方快照正文仅作过程留档。
>
> ~~中途快照状态：切片② `r328-dashboard-ui` 仍在编写中……~~（已被上面复验结论取代）
- 必读依据：`docs/plan/north-star-business-confirmed.md` §8（双口径不混用 PM 裁决）、R327 后端响应契约（`agent-north-star.dto.ts` / `north-star-metrics.service.ts`）、`apps/admin-web/src/pages/DashboardPage.tsx`
- 报告链接：`docs/plan/north-star-ui-review.md`

## 结论摘要（Top line）

**R328 UI 切片①（client+类型）已正确落盘；切片②（hook + 组件 + 接线 + i18n + 测试）在快照时点未落盘、仍在编写中。** 全库检索结果：web 侧只有 `apps/admin-web/src/api/metrics.ts` 新增的 client 函数 `metricsApi.getNorthStar()` 与两个类型 `NorthStarReport` / `NorthStarWeek`；属于切片②的 hook（`useNorthStarReport`/`report:['north-star-report']` queryKey）、`NorthStarCard` 组件、Dashboard 接线、zh/en 双口径 i18n 键、组件测试 `north-star-card.test.tsx` —— **快照时点全部不存在**。因此清单 1–5 的 UI 验收对象缺失，无法给出"通过/达标"结论；清单 6 构建守卫全绿但无 R328 卡片代码可测体积影响；清单 7 浏览器未验证。**建议：不关闭，待切片②落盘后按复验流程重验（见附录 A）。**

## 证据基座（落盘事实）

| 检索项 | 命令 | 结果 |
|---|---|---|
| web 侧 north-star 文件 | `git ls-files --others --cached \| grep -iE "north.?star"` | 仅 admin-api 的 dto/service/spec + docs + scripts，**无 web 文件** |
| web 侧组件/测试符号 | 全库 `grep -E "NorthStarCard\|north-star-card\|businessResultsProxy"` | **0 命中** |
| web 侧 hook / client 调用方 | `grep -rIn "getNorthStar\|useNorthStar" apps/admin-web/src` | 仅 `api/metrics.ts` 自身定义，**无调用方、无 hook** |
| i18n 键 | `grep -inE "north\|北极星\|代理值\|严格口径" locales/{zh,en}.ts` | **0 命中**（`artifactLibrary.empty.noMatch` 的 "noMatch" 为误报） |
| DashboardPage 接线 | CodeGraph `explore DashboardPage` + import 段逐行 | import 有 `SchedulerLatencyCard` 等，**无 NorthStarCard**；JSX 无北北极星卡片 |
| locales diff | `git diff -- locales/{en,zh}.ts` | 只新增 `sysSettings.telemetry.*`（R326/R327 TTFV 遗留），**与 R328 无关** |
| worktree | `git worktree list` | 仅一个 worktree，无其它实现分支藏匿 |
| stash | `git stash list` | 空 |
| 组件测试 | `ls apps/admin-web/src/__tests__ \| grep -i north` | **(none)** |

web 侧 R328 唯一落盘代码（`api/metrics.ts:98-118,144-149`）：

```ts
export interface NorthStarWeek { week_start: string; active_installs?: number; confirmed_events?: number; executions?: number; }
export interface NorthStarReport {
  as_of: string;
  business_confirmed: { weeks: NorthStarWeek[]; totals: { active_install_weeks: number; confirmed_events: number } };
  business_results_proxy: { weeks: NorthStarWeek[]; totals: { executions: number } };
  warnings: string[];
}
getNorthStar: (params?: { as_of?: string }, signal?: AbortSignal) =>
  apiClient.get<NorthStarReport>('/agent/north-star/metrics', { signal, params });
```

## 逐条结论 + 证据

### 1. 双口径不混用（business_confirmed 严格/主 vs business_results_proxy 近似/参考）
- **契约层（client/后端）到位**：`NorthStarReport` 把两口径分成两个顶层字段，字段与后端 `AgentNorthStarResponseDto` 逐字对齐；后端 `north-star-metrics.service.ts` 用两条独立 SQL（严格读 `funnel_events`、代理读 `task_executions` 且 `synthetic=false`），独立周桶/totals，附 `STRICT_CALIBER_WARNING` + `PROXY_CALIBER_WARNING` 两条强制警告。§8 裁决要求「近似值标注 + 不冒充严格值」在**数据层**成立。
- **UI 层：无法验收**。无任何组件消费上述字段，无「两列并列/参考值弱化/强警告」渲染代码。结论：**PASS（契约层）/ 无法验收（UI 层，未落盘）**。证据：全库 `NorthStarCard` 0 命中、DashboardPage import 段无该组件。

### 2. 警告常驻（数据空/满都渲染 warnings，无 `if(data)…else 隐藏` 分支）
- `NorthStarReport.warnings: string[]` 类型存在，后端 `report()` 无条件返回两条警告（`service.ts:156`）。
- **UI 层：无法验收**。无组件渲染 warnings，无源码分支可查。结论：**无法验收（UI 层未落盘）**。

### 3. 全局口径（卡片不随项目过滤，queryKey 不带 projectId、不套 project scope）
- **client 层正分**：`getNorthStar(params?: { as_of?: string })` 参数**仅 as_of，无 projectId**，符合"全局口径"要求（对比 `getSummary` 带 `projectId?`）。
- **hook/组件层：无法验收**。无 hook 即无 queryKey，无法验证其是否带 projectId 或套 project scope。结论：**PASS（client 签名）/ 无法验收（hook 层未落盘）**。

### 4. i18n 完整（zh/en 键齐全，en 下中文 warnings 处理）
- i18n 守卫绿：`npm run lint:i18n` exit 0，静态键 3364 个、zh(3765)/en(3765) 键集一致、无新增缺失。
- 但 **zh/en 无任何 north-star/双口径键**；后端 warnings 是中文常量（如 `⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值`），en 下如何展示（直出中文 vs 前端翻译映射）**无 UI 逻辑可验**。结论：**无法验收（切片② i18n 未落盘）**。证据：locales grep 0 命中。

### 5. 测试有效性（north-star-card.test.tsx 真测双口径/警告/空态/错误态 + 反证）
- **文件不存在**，任务书指定的 `north-star-card.test.tsx` 全库无此文件，`__tests__ | grep -i north` 为 (none)。
- **反证无法执行**：任务要求"临时去掉组件警告渲染→对应测试转红"，但被测组件与测试均不存在，没有可注入的变异点，无法构造反证（拒绝伪造反证结果）。
- 既有 Dashboard 测试绿但与 R328 无关：`npx vitest run dashboard-scope-grouping.test.tsx dashboard-failed-deeplink-multistatus.test.tsx` → 2 files / 11 tests passed（exit 0），测的是 P2-1 口径徽章与项目过滤，不覆盖北极星。
- 结论：**无法验收（测试未落盘）**。

### 6. 构建 / 体积
| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `cd apps/admin-web && npx tsc -b --pretty false` | exit **0** |
| lint | `npx eslint src/api/metrics.ts src/pages/DashboardPage.tsx src/locales/{en,zh}.ts` | exit **0** |
| i18n 守卫 | `npm run lint:i18n` | exit **0** |
| first-paint 守卫 | `npx vitest run src/__tests__/first-paint-no-unused-vendor.test.ts` | 9 passed，exit **0** |
| 首屏实测体积 | 按测试同款逻辑读 `dist/index.html` 去重求和 | **1,800,359 B**（29 条），阈值 1,850,000，**余量 49,641 B ≈ 48.5 KB** |

- first-paint 阈值在本次工作树已被从 1,800,000 放宽到 1,850,000（diff 可见，注释称因 i18n chunk `i18n-B_WJUdZD.js` 已 745 KB、fresh build 1,800,359 B 吃尽旧余量）。
- **重要边界**：当前 `dist/index.html` mtime 为 `2026-11-20T18:34:28Z`，早于 R328；因无 R328 卡片代码，**该 1,800,359 B 不含任何北极星卡片体积**，"新卡片是否逼近阈值"目前无对象可测。若切片②落盘且用现有 antd/recharts，需重建后复测；`recharts` 库级 chunk 若进首屏，按注释估算 ≈ 1.8M + 365 KB ≈ 2.16 MB 会破界。结论：**守卫全绿，但体积影响未验证**。

### 7. 浏览器真机
- 环境不具备：`ps` 无 `dev:web` 进程；`http://127.0.0.1:3080` 返回 **401**（需认证）；北极星端点需真 JWT + 真库，后端 `http://127.0.0.1:3105` **不通**（curl exit 7）。
- 结论：**未做浏览器级验证**，无截图、无真机结论，不伪造。

## 缺口分级

| 级别 | 缺口 | 影响 |
|---|---|---|
| **P0 / Blocker（中途快照）** | 快照时点切片②（hook `useNorthStarReport`+queryKey、NorthStarCard + Dashboard 接线 + i18n + 组件测试）尚未落盘、仍在编写；切片① client+类型已正确完成 | R328 UI 验收对象在快照时点不存在，清单 1–5 无法给出通过结论；**待切片②落盘重验，不视为最终缺陷** |
| **P1** | first-paint 阈值已放宽 50 KB（1.8M→1.85M），且当前 dist 早于 R328 | 卡片落盘后体积余量仅 48.5 KB，需重建复测；重依赖进首屏会破界 |
| **边界（非缺陷）** | 浏览器真机不具备（3080=401 / 3105 不通 / 无 dev:web） | 无法做真机确认，验收级别封顶为静态+组件测试 |

## 是否建议关闭

**不建议关闭（本次快照）。** 切片①（client+类型）已正确完成；切片②（hook `useNorthStarReport`+queryKey 无 projectId、组件、Dashboard 接线、双口径 i18n、组件测试）在快照时点仍在编写，不满足验收前提。lead 已通知切片②仍在写，本报告作为中途快照保留。**待切片②落盘后按附录 A 重验**：执行清单 1–5（重点双口径不混用、警告常驻、queryKey 无 projectId、zh/en 键齐且 en 下中文 warnings 处理、测试反证），重建 dist 复测 first-paint 实际体积（当前余量仅 48.5KB），环境具备时补浏览器真机（需 3105 + JWT）。

## 附：本次所有命令 exit 汇总

```text
git worktree list                                      -> 1 worktree
git stash list                                         -> 空
git status --short | grep -iE "north|dashboard..."     -> 仅 api/metrics.ts + locales(telemetry) + first-paint test
全库 grep NorthStarCard|north-star-card|businessResultsProxy -> 0 命中
CD apps/admin-web && npx tsc -b --pretty false         -> exit 0
npx eslint <4 files>                                   -> exit 0
npm run lint:i18n                                      -> exit 0 (3364 keys, zh/en 3765 each)
npx vitest run first-paint-no-unused-vendor.test.ts    -> 9 passed, exit 0 (1,800,359 B / 1,850,000)
npx vitest run dashboard-scope-grouping + failed-deeplink -> 11 passed, exit 0
curl http://127.0.0.1:3080                             -> 401
curl http://127.0.0.1:3105                             -> exit 7 (不通)
```

## 附录 A · 切片②落盘后的复验流程（待执行）

> 待 lead 通知 `r328-dashboard-ui` 落盘后执行；此处先固定判据与命令，避免届时口径漂移。

1. **落盘确认**：`glob` 找 `NorthStarCard.tsx` / `hooks/useNorthStarReport*`，`grep 'north-star-report' src/api/queries.ts`（lead 已见 `report:['north-star-report']` 常量），确认组件/Dashboard 接线已出现。
2. **清单 1 双口径**：读组件源码，确认 `business_confirmed`（严格/主）与 `business_results_proxy`（近似/参考）分列渲染、参考值视觉弱化、无混算、无「近似冒充达标」；若有 dist 截图补浏览器确认。
3. **清单 2 警告常驻**：确认 warnings（尤其 `PROXY_CALIBER_WARNING` 强警告）在空/满数据下都渲染，无 `if(data)…else 隐藏` 分支；反证法：临时在 /tmp 镜像去掉警告渲染，跑对应测试应转红。
4. **清单 3 全局口径**：确认 hook 的 queryKey=`['north-star-report']` 分支**不拼 projectId**、请求不套 project scope；对照 `dashboard-scope-grouping.test.tsx` 的随项目/全局二分范例，确认北极星卡归全局组。
5. **清单 4 i18n**：确认 zh/en 双口径键齐全（`npm run lint:i18n` 应仍 exit 0），en 下后端中文 warnings 的处理（直出 vs 翻译映射）合理。
6. **清单 5 测试有效性**：跑 `north-star-card.test.tsx`，确认真覆盖双口径/警告/空态/错误态；执行反证（变异组件去警告渲染→测试转红→还原）。
7. **清单 6 体积复测（关键）**：`cd apps/admin-web && npm run build` 重建 dist（当前 dist 早于 R328），再 `npx vitest run src/__tests__/first-paint-no-unused-vendor.test.ts` + 首屏求和脚本取实际 bytes，确认 < 1,850,000 并报告新余量（基线 1,800,359 / 余量 49,641B）。若含 recharts 首屏 chunk 逼近/破界需点名。
8. **清单 7 浏览器**：仅当 3080 免登录 + 3105 带 JWT 真库可用时做；否则维持"未做浏览器级"。
9. **输出**：更新本报告「复验附录」实际结论 + 重发 lead；届时才给最终关闭建议。

---

## 附录 B · 切片②落盘后复验实际结论（2026-11-21 21:52 CST，最终结论）

复验对象：`apps/admin-web/src/components/dashboard/NorthStarCard.tsx`(9,398B)、`src/__tests__/north-star-card.test.tsx`(5,354B)、`src/api/queries.ts`(`useNorthStarReport` :283)、`src/pages/DashboardPage.tsx`(import :39 / 渲染 :725)、zh/en 各 12 个 `dashboard.northStar.*` 键。验收级别：静态复核 + 组件测试（RTL）+ 重建 dist 体积复测；浏览器真机未做（3080=401，降级）。

### 清单 1 双口径不混用 —— PASS
源码逐行核对：严格值 `north-star-strict` 区 `:158-183`（`color="success"` + 严格 Tag，主指标 confirmed=42 / 辅 installs=7），近似值 `north-star-proxy` 区 `:186-202`（`opacity:0.72` + 左侧分隔线 + 「参考·近似值」Tag，executions=99），两区各自独立 testid、不并排相加、无混算字段。strictHint/proxyHint 逐条说明来源差异（口径 D vs 口径 A）。`readTotals():89-96` 三字段各自 `?? 0` 独立取值。测试①逐字断言 42/7/99 不串、严格 Tag 含「严格」、参考 Tag 含「参考」。符合 §8「并列展示、参考弱化、不混用、无近似冒充达标」。

### 清单 2 警告常驻 —— PASS（反证有效）
`WarningRail():64-86` 容器标题常驻 + `warnings.map` 逐条原文 `Alert`（`title={warning}` 逐字不翻译），调用点 `:212` 无条件放在成功态末尾；空数据测试②/③证明周序列与 totals 全空仍渲染 GUARD。**边界说明**：`isPending`(`:120-128`) 与 `isError`(`:131-145`) 两个早退分支不渲染 WarningRail——加载/失败态无 warnings 数据，属合理（非"有数据却隐藏警告"），清单 2 判据是"数据空/满都渲染"，这两态不在其列。**反证（变异测试）**：备份原组件到 `/tmp`（sha256 `66b14de1…`），临时把 `<WarningRail warnings={totals.warnings}/>` 改为传 `[]`，跑测试 → **1 failed / 3 passed，exit 1**（失败点 test:91 `findByText(GUARD)`），随后 trap 还原，sha256 字节级一致、`git diff` 该路径为空，原文件零改动。证明测试②真正钉住警告渲染，非摆设。

### 清单 3 全局口径 —— PASS（源码）/ 测试覆盖缺口 P2
`queries.ts:53-55` `northStar.report = ['north-star-report'] as const` 裸键、无 projectId；`:283-289` hook `queryFn` 调 `metricsApi.getNorthStar(undefined, signal)`，只透 signal、不带 project 参数，queryKey 无 projectId 维度、切项目不重取。`DashboardPage` 渲染 `<NorthStarCard/>` 无 props，组件头注释明确"不接收 projectId"，独立 `north-star-global-tag` 刻意不复用 `scope-badge-global`（避开 baseline 的 4 枚断言）。**缺口 P2**：全量 grep 确认无任何测试断言 `getNorthStar` 调用参数无 projectId / queryKey 无项目维度；`north-star-card.test.tsx` 只静态断言全局 Tag 存在，`dashboard-scope-grouping.test.tsx` 的 mock 未 stub getNorthStar。功能正确但缺回归锚点，建议后续补一条 queryKey/调用参数断言。

### 清单 4 i18n 完整 —— PASS（含 en 下中文警告的合理处理）
zh/en 各 12 个 `dashboard.northStar.*` 键逐一对齐（title/strict/proxy/strictHint/proxyHint/activeInstalls/confirmedExecutions/proxyExecutions/asOf/empty/readFailed/warning），`npm run lint:i18n` exit 0（静态键 3,376，zh/en 各 3,777，无新增缺失；较快照 3,364/3,765 正好 +12）。en 下后端中文 warnings 处理合理：`WarningRail` 逐条 `Alert title={warning}` 直出后端原文不翻译，外层用 `dashboard.northStar.warning` 标题/Tooltip 说明「口径护栏（后端原文，常驻）」/「verbatim from backend, always shown」，与组件头注释「原文来自后端、不作翻译」一致——避免翻译漂移强警告，符合护栏语义。

### 清单 5 测试有效性 —— PASS（4/4 真测，非摆设；反证已转红）
`north-star-card.test.tsx` 4 个用例真覆盖：①双口径数值/Tag 独立 ②warnings 空序列逐字常驻 ③空数据按 0 + 容器在 + 不误显错误态 ④读取失败友好提示 + 重试 + 不崩成空态。`npx vitest run north-star-card.test.tsx` → 4 passed exit 0；变异反证见清单 2（转红 exit 1 后还原）。

### 清单 6 构建/体积 —— PASS（重建后实测未破界，余量收窄至 2.36%）
`npx tsc -b` exit 0；`npx eslint`(4 文件) exit 0；`npm run build` exit 0（2.05s）。**重建 dist（mtime 2026-11-21T13:51:59Z）后实测首屏 JS 30 条 = 1,806,362 B（1.723 MiB）**，阈值 1,850,000，**余量 43,638 B（2.36%）**，较切片①基线 1,800,359 **增量 +6,003 B**。Vite warning：i18n chunk 751.02 kB（含新增 12 键）、LineChart 365.40 kB、GlueEditor 2.72 MB 均为非首屏/懒加载 chunk；首屏 Top1 i18n 751,027B 已在守卫白名单内。`first-paint-no-unused-vendor.test.ts` 9 passed exit 0；全量 `npx vitest run` **350 files / 2,840 passed | 1 skipped**（exit 0）。评价：切片②未引入重依赖进首屏（+6KB 主要是 i18n 词条增量），未破界；但余量已从 49.6KB 降到 43.6KB，后续若再把 recharts LineChart 提进首屏（+365KB）必破，闸门牙仍在。

### 清单 7 浏览器真机 —— 未做（环境降级）
3080 返回 401（需认证）、3105 不通、无 `dev:web` 进程，北极星端点需真 JWT + 真库。无真机截图，不伪造。

### 复验缺口分级（最终）
- **P2（建议补，不阻断）**：全局口径缺测试锚点——无断言 queryKey 无 projectId / `getNorthStar` 调用不带项目维度；建议加一条 hook 级断言。
- **P3（提示）**：first-paint 余量收窄至 43.6KB（2.36%），已加 northStar 12 键；后续大依赖入首屏需重测。
- **无 P0/P1 功能缺陷**。中途快照的 P0（UI 未交付）已消解。

### 最终建议
**建议关闭本切片验收（UI 静态+组件测试+体积复测维度）**：清单 1/2/4/5/6 PASS，清单 3 源码 PASS 仅缺 1 条测试锚点（P2 非阻断），清单 7 浏览器受环境限制降级。P2 可转后续小切片补测试，不阻塞 R328 关闭。浏览器真机结论待环境具备（3080 免登录 + 3105 + JWT）时另补，不纳入本次通过范围。
