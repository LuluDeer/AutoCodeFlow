# Changelog

## [1.12.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.12.0...v1.12.1) (2026-10-19)


### Bug Fixes

* **deps:** 一次性清偿 38 条 Dependabot 告警——27 条修复（js-yaml / tmp / dompurify / uuid / brace-expansion / glob / undici / vite / esbuild / anyio / pytest）+ 11 条登记豁免（extract-zip / http-cache-semantics / sprintf-js / stream-json，均为上游无修复版） ([d7e5f29](https://github.com/LuluDeer/AutoCodeFlow/commit/d7e5f292759a2b40ce8e2d1aef4f0fd172c8c203))
* **docs-site:** vitepress 1.6.4 → 2.0.0-alpha.20，vite 5 → 8.3.4，esbuild 告警归零 ([d7e5f29](https://github.com/LuluDeer/AutoCodeFlow/commit/d7e5f292759a2b40ce8e2d1aef4f0fd172c8c203))
* **desktop:** 修 history-watcher 真实 fs.watch 冒烟的测试竞态（macOS runner 偶发） ([494ff6a](https://github.com/LuluDeer/AutoCodeFlow/commit/494ff6a9))

### ⚠️ Breaking Changes

* **python-sdk:** `autoflow-sdk` 的 `requires-python` 由 `>=3.9` 收紧到 `>=3.10`。
  anyio 的修复版（4.14.2+）只支持 Python ≥3.10，而 3.9 分支解析到含 **critical** 漏洞
  且无修复版的 4.12.1。Python 3.9 用户需先升级解释器。

<!--
本节经人工校正（release-please 生成时把同一条修复按 develop commit / merge commit /
main merge 列了三次）。这是本仓已记录的已知偏差（见 1.11.0 / 1.10.1 小节注释与
.github/workflows/release-please.yml 的 v1.3.0 注记），根因是「非规范 merge 标题 +
develop 直推 commit」与 release-please 的遍历交互。此处按 1.11.0 的同一做法人工合并。
-->

## [1.12.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.11.0...v1.12.0) (2026-10-18)


### Features

* **api:** 游标分页加性过渡 / 跨实例配置缓存失效 / 可观测性遗留清理 ([704f749](https://github.com/LuluDeer/AutoCodeFlow/commit/704f749e69f30ea52bee2f2ef174e7fd9679af66))
* **api:** 限流白名单守卫 / HTTP RED 指标 / 磁盘堆健康检查 / 备份恢复演练 ([6087b47](https://github.com/LuluDeer/AutoCodeFlow/commit/6087b47fed806411f78f1b8e9fc06b833680e355))
* 优化 CI 流水线并升级 README ([95fa789](https://github.com/LuluDeer/AutoCodeFlow/commit/95fa7892a6d5bdf5f00a95a7ede9632c6c3f91a8))
* 优化 CI 流水线并升级 README ([2060b7d](https://github.com/LuluDeer/AutoCodeFlow/commit/2060b7dff7f747630ba3d174d7073bd0ec3e6b33))


### Bug Fixes

* 修复审计报告的 7 项 P1 高危缺陷 ([f3e340d](https://github.com/LuluDeer/AutoCodeFlow/commit/f3e340df29c463ff82c99a620b0f8fe8555eef18))
* 修复审计报告的 P2/P3 缺陷（SDK 连接池、调度器异常、跨连接死锁、部署与脚本） ([5ce4356](https://github.com/LuluDeer/AutoCodeFlow/commit/5ce4356cec56a84bbd767f3e33b2d751e9193379))
* 修复测试隔离缺陷与自检脚本腐烂（三项真实缺陷） ([19aa9fb](https://github.com/LuluDeer/AutoCodeFlow/commit/19aa9fb46439d336a05dd6718fc3d53dafb1e48d))

## [1.11.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.10.1...v1.11.0) (2026-10-16)


### Features

* **i18n,executor,admin:** 全量错误码化 + API 文档双语 + ADR-017 阶段 3 执行器行身份 ([4bfe376](https://github.com/LuluDeer/AutoCodeFlow/commit/4bfe376689ca9d938a41ba799434960dc44f512f))


### Bug Fixes

* **ci,i18n,e2e:** 修首轮 CI 的 6 个红——注入串联/守卫基线/产物摘要/playwright locale ([60659de](https://github.com/LuluDeer/AutoCodeFlow/commit/60659dedfbede1bbc6190e390a7daba250f731ed))
* **e2e,desktop:** 修二轮 CI 余下 2 红——e2e 断言随中文化与读面富化更新 + bundle 字节哈希回填 ([03c8cf4](https://github.com/LuluDeer/AutoCodeFlow/commit/03c8cf4ecc40aa66e3ceb836475c58a7699d65e1))
* **task,e2e:** 修三轮 CI 余下 2 红——pinned 离线被错报「脚本错误」+ e2e 状态级联 ([a3f719b](https://github.com/LuluDeer/AutoCodeFlow/commit/a3f719beec19dd13efbbc25468c25e900bec49b9))
* **task:** EXECUTOR_OFFLINE 判据收成单一事实源——pinned 离线被错报「脚本错误」的根因在第二份副本 ([9e55c12](https://github.com/LuluDeer/AutoCodeFlow/commit/9e55c1261a61f88cea09a7df57c866e740804ab5))

<!--
本节经人工校正（release-please 于 2026-10-16 生成时有两处偏差）：
1. **Features 重复**：同一条 feat 列了两次——596ac76（`Merge pull request #48`，
   取用了 PR 标题）与 4bfe376（该 PR 内的真实 commit）。已删去 merge 那条，
   保留真实 commit。
2. **Bug Fixes 漏三条**：原只列 60659de，漏了 03c8cf4 / a3f719b / 9e55c12——
   三条均属 `git log v1.10.1..v1.11.0` 范围内的真实修复。

⚠️ 该偏差**并非本轮特有**：v1.10.1 小节同样重复（8cbb22f 与 2b4a52f 为同一条
A-11R 消息）。根因是「非规范 merge 标题 + develop 直推 commit」与 release-please
的 PR 关联/遍历交互——`.github/workflows/release-please.yml` 的 v1.3.0 注记
「非规范 merge 标题触发 conventional 解析错误吞掉 feat 遍历」已记录同类现象。
规避建议（任选其一）：
  · develop → main 改 **squash merge**，且 squash 标题写规范 conventional 文案；或
  · 合并 Release PR 前**人工核对**其 CHANGELOG 差异，必要时按本节方式校正。
-->

## [1.10.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.10.0...v1.10.1) (2026-10-14)


### Bug Fixes

* **executor,admin,sdk:** A-11R——params 注入字符串回归裸值 + 类型化通道，修 12 天静默停摆 ([8cbb22f](https://github.com/LuluDeer/AutoCodeFlow/commit/8cbb22f6fae64b582025e24c4c49f9dc26699845))
* **executor,admin,sdk:** A-11R——params 注入字符串回归裸值 + 类型化通道，修 12 天静默停摆 ([2b4a52f](https://github.com/LuluDeer/AutoCodeFlow/commit/2b4a52f29fc37bdfb046feaa34b242cbe4281ff4))

## [1.10.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.9.1...v1.10.0) (2026-10-09)


### Features

* **cli,mcp,agent:** 互斥组三面同步补齐——CLI 命令组 + MCP 4 工具 + agent 闸门纳管 ([#41](https://github.com/LuluDeer/AutoCodeFlow/issues/41)) ([cbcd7aa](https://github.com/LuluDeer/AutoCodeFlow/commit/cbcd7aad0bac9b975dab022860112f9d26a1a77c))

## [1.9.1](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.9.0...v1.9.1) (2026-10-09)


### Bug Fixes

* **acf-cli:** 收口无人值守语义（非交互假绿 / 示例 payload / Windows lint） ([8b75be9](https://github.com/LuluDeer/AutoCodeFlow/commit/8b75be97e4d9b2eb763285ccae53cfdb826fcfa6))
* **mcp-server:** 部署缺省不再落 daemon + 补齐 annotations/ADMIN 标注 ([b487ecf](https://github.com/LuluDeer/AutoCodeFlow/commit/b487ecfd8cc437a33926e42d76089a021a962e3d))
* **release:** 根治 release-please lockstep 失效——单一 root 条目 + extra-files 广播 ([#39](https://github.com/LuluDeer/AutoCodeFlow/issues/39)) ([3e5dd7d](https://github.com/LuluDeer/AutoCodeFlow/commit/3e5dd7d5829f874bce1cfeaf10a69216c9cfcd86))
