# 第十四轮进度小结（Windows 侧接棒）

> 日期：2026-09-12 · 负责人：Windows 侧主会话（接续 ubuntu 侧已完成的大量开发）
> 前轮：第十三轮（多实例一致性收口 + AUTH-02 + 三处真实缺陷，真机验证驱动）——见 `docs/PROGRESS-round13-2026-09-12.md`
> 长期计划：`docs/DEVELOPMENT-PLAN-2026-09H2.md` · 认领板：`docs/PLAN-CLAIMS.md`

## 一、本轮目标

ubuntu 侧 agent 已完成 13+ 轮开发，项目功能与测试基线高度成熟。本轮作为 Windows 侧负责人，目标不是新增大量特性，而是：

1. **重建并认证 Windows 健康基线**（win 侧接棒的首要职责）；
2. **消除一处 Windows 特有的间歇性 flaky 根因**（W-06 收口）；
3. **刷新治理/交接文档**到 git 现状，保证下一会话连续性、避免重复劳动。

## 二、接手时状态

- 工作树：`develop`，clean，与 `origin/develop` 同步。
- git 现状已**领先** round13 文档：ARCH-31 outbox 行级 claim（7/7）、nginx-sse 24/24、QA-05 容量白皮书、混沌演练真机、迁移 `1790000000015` 注册落库等均已入库。
- 环境：Windows · Node 24.17.0 · pnpm 11.8。各子包 `node_modules` 基本就绪。

## 三、本轮交付

### 3.1 修复①：admin-web 子包依赖陈旧（健康基线）

- **现象**：`npm run typecheck:web` 报 `Cannot find module 'react-i18next'` / `i18next`。
- **根因**：UI-10 在 `apps/admin-web/package.json` 增加了 `react-i18next` + `i18next` 依赖，但本 Windows 克隆的 `node_modules` 未重装（目录陈旧/安装被截断），`node_modules/react-i18next` 缺失。
- **处置**：`cd apps/admin-web && npm install` 补齐 **26 个包**，`typecheck:web` 恢复绿。
- **性质**：环境/依赖刷新问题，非代码缺陷；属 win 侧接棒必做的基线校准。

### 3.2 修复②：acf-cli 配置模块 Windows 并行构造 flaky（W-06 收口）

- **文件**：`packages/acf-cli/src/config.ts`
- **根因**：模块级 `new Conf({ configFileMode: 0o600 })` 在 Windows 并行磁盘负载下构造偶发抛错（全量单测 1/89 间歇性失败；隔离运行全绿）——典型 W-06 型并行竞态。POSIX 不受影响。
- **处置**：改为 `createStore()` 工厂函数：先以 `configFileMode` 构造，失败则降级为无 mode 构造（仍由既有的 `hardenConfigPermissions()` 在加载时修复权限）。
  - 消除 flaky 根因；
  - 附带提升 CLI 健壮性：在无法设置 0600 的平台（Windows ACL 语义 / 只读挂载）不再因构造抛错而崩溃。
- **验证**：`config-security.test.ts` 连续 3 次稳定绿（4 passed / 1 skipped）；完整 cli 套件复跑 `88 passed / 1 skipped`（89）稳定绿。

### 3.3 跨平台健康认证（本 Windows，无 docker/PG/Redis）

| 套件 | 结果 |
| --- | --- |
| `typecheck:api` | ✅ 绿 |
| `typecheck:cli` | ✅ 绿 |
| `typecheck:mcp` | ✅ 绿 |
| `typecheck:node-sdk` | ✅ 绿 |
| `typecheck:web`（修复①后） | ✅ 绿 |
| `test:mcp` | ✅ 100/100 |
| `test:cli` | ✅ 89/89（1 skip；修复②后稳定） |
| admin-api 通知模块 | ✅ 219/219（含 **NF-05 Slack/Feishu 渠道真机用例**，计划板已 done 实证可用） |
| `executor-node` | ✅ 273/273（Windows 修复的生产代码认证通过） |

**结论**：Windows 基线健康，无新增回归；W-系 findings 仍全结清（与 `docs/windows-findings.md` DOC-08 长尾清偿一致）。

### 3.4 治理文档刷新

- `AGENT_HANDOFF.md` 顶部「更新时间」推进至本轮（第十四轮），指向本文档。
- 注：本轮未改 `PLAN-CLAIMS.md` —— NF-05 等后端渠道在计划板已标 done，本轮以测试实证其可用；无遗漏待认领项（剩余 unclaimed 仅 BUG-04 上游追踪、AUTH-04 OIDC 可选）。

### 3.5 UI-10 第三阶段状态更正（治理修正）

- **结论：UI-10 第三阶段在 git 现状已基本完成**，round13 文档「剩余约 52 文件 / 5000+ 硬编码中文」已严重滞后。
- **证据**：抽样核对 5 个核心页（ApplicationListPage / TaskListPage / TaskDetailPage / ExecutionDetailPage / TaskFormPage）——渲染文案已全部 `t('appList.*'|'taskList.*'|'taskDetail.*'|…)` 化；`search_content` 命中的中文全部位于 `//` / `*` 注释（如 UI-03/FEAT-17/CORE-02 等），非渲染文案。i18n 专项测试（`src/__tests__/i18n-infra.test.tsx`）`zh/en key 集合一致`断言 **5/5 绿**。
- **含义**：应用默认渲染 zh 正常，英文切换可达；该特性不再阻塞、不再属「越晚越贵」待办。剩余仅为个别组件级零散文案的拾遗（CommandPalette / 个别 settings 页仍有少量渲染中文），属非阻塞打磨，留后续轻量收口。

## 四、未做 / 留待下轮（含阻塞原因）

- **v1.2.0 发布（lockstep）**：需推送 `develop→main` + release-please Release PR + 仓库 `RELEASE_PLEASE_TOKEN` 与 NPM/PyPI 凭据。本 Windows 会话无凭据，留发布轮。
- **ARCH-31 outbox 行级 claim（`FOR UPDATE SKIP LOCKED`）**：代码已完成、真机 15/15 已验矩阵前 4 项；第 3 项（心跳落非属主实例的真实灰度推进）需执行器 + 可达 git 源，生产形态。
- **QA-05 四档容量目标**（500 并发 / 1000 RPM / SSE 500 / 回调 10k）+ 服务端 Prometheus 水位 + 白皮书定稿：生产形态真机。
- **UI-10 第三阶段**全站剩余页 i18n（约 52 文件 / 5000+ 硬编码中文）：越晚越贵，建议作为后续重点。
- **AUTH-02** 成员过滤读面 + admin-web 权限门控 UI。
- **AUTH-04** OIDC SSO（可选）。
- **BUG-07** Windows detached 信号深测：生产侧 W-14/15/P-9/10/12 已修；仅剩三链 detached 孙进程残留探针 harness，需执行器真跑。

## 五、项目成熟度判断

项目已处于**高成熟度**：9 套件测试基线全绿（ubuntu）、核心特性（多实例一致性、审批流、i18n、通知多渠道、kill 链、outbox 可靠性、桌面端、CLI）齐备、文档/ADR/VERIFY 体系完整、已发布 v1.1.1。

Windows 侧本轮确认：跨平台单测与类型检查在 Windows 全绿、平台敏感的执行器（273）与通知多渠道（含 Slack/飞书）实证可用。**剩余均为生产形态真机验证、发布动作与可选增强**，无阻塞性代码缺陷。继续推进路径清晰（见第四节）。
