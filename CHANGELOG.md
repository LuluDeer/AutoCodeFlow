# Changelog

## [1.14.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.13.0...v1.14.0) (2026-10-22)


### Features

* **devx:** 激活 demo、真实模型桌面 Agent 与截图多模态诊断 ([4c32264](https://github.com/LuluDeer/AutoCodeFlow/commit/4c322643a75ff375848e96c3717dfa79bfc63bfd))


### Bug Fixes

* **deps:** py-libs 三包 certifi 升到 2026.10.19（清 3 条 critical）+ uv.lock 漂移校正 ([a091617](https://github.com/LuluDeer/AutoCodeFlow/commit/a091617c293233e3be8e6d8421c81dc58503db88))
* **deps:** py-libs 四包 certifi 升到 2026.10.19，并修掉 uv.lock 的 editable 版本漂移 ([bbf3ad0](https://github.com/LuluDeer/AutoCodeFlow/commit/bbf3ad0d82fd8db6bc53e0fdbc301bb4cb9cae41))
* **deps:** 清偿可修复的 Dependabot 告警 ([f17307e](https://github.com/LuluDeer/AutoCodeFlow/commit/f17307eb7cc6fbcef57dc2a7743b4f789af719ea))
* **executor:** 地址告警误报 + 部署下发失败（生产报告 2026-10-22 全量修复） ([8ec47e8](https://github.com/LuluDeer/AutoCodeFlow/commit/8ec47e89d2c039db464669973d5d801d79e07ccc))
* **install,compose:** 执行器地址采集加固 + compose 对外地址必填 ([2da0573](https://github.com/LuluDeer/AutoCodeFlow/commit/2da05734156a4e76cead219fd720c602ea50c74d))

## [1.13.0](https://github.com/LuluDeer/AutoCodeFlow/compare/v1.12.1...v1.13.0) (2026-10-21)


### ⚠ BREAKING CHANGES

* **desktop:** remove V2 renderer and restore V1 (1.9.2)
* **desktop:** ship V2 renderer as the default UI (2.0.0)

### Features

* **adr-026:** 守卫新增 `--report-saves` —— 盲区①的可见化（60 处候选） ([0bb940b](https://github.com/LuluDeer/AutoCodeFlow/commit/0bb940b6b545208ce27d671e1f453799c1545169))
* **ci:** ADR-026 静态守卫——无条件状态写「只减不增」棘轮 ([4bb9959](https://github.com/LuluDeer/AutoCodeFlow/commit/4bb99599142a1327fcd14d8ab6e50dd209027951))
* **ci:** 新增错误码化回退守卫 —— admin-api 裸内置异常 throw 恒为 0 ([500c8bc](https://github.com/LuluDeer/AutoCodeFlow/commit/500c8bcc03076e8f93c68b617d1aba06df06a9c3))
* **desktop:** ship V2 renderer as the default UI (2.0.0) ([43ec4b2](https://github.com/LuluDeer/AutoCodeFlow/commit/43ec4b23447d53922118255b94dc49ce390c3cb9))
* **errors:** 三端透出 admin-api errorCode/params（python http / python sdk / MCP） ([e6513f9](https://github.com/LuluDeer/AutoCodeFlow/commit/e6513f95b88cce5bc7b1f48f6d9839bc347199c8))
* **executor-desktop:** 多尺寸 UX 打磨与视觉巡检脚本 ([5ec4a88](https://github.com/LuluDeer/AutoCodeFlow/commit/5ec4a8814a6b48b4deceba95488bbaadf78389b7))
* **sdk,cli:** 透传 admin-api 稳定错误码并按 6 类给处置提示 ([1382253](https://github.com/LuluDeer/AutoCodeFlow/commit/138225378550e4e4ecc84b649edea7784d9ee8b0))


### Bug Fixes

* **cli:** 破坏性动作的确认门补全 + 本地数值参数不再静默兜底（R192-A1） ([8ad61fd](https://github.com/LuluDeer/AutoCodeFlow/commit/8ad61fdcfbddca1ad06bb15be0bd25968dae6109))
* **deps:** bump follow-redirects to 1.16.1 and uv to 0.13.4 ([758f35b](https://github.com/LuluDeer/AutoCodeFlow/commit/758f35b960e75044ab9aa82919f9496be401c8da))
* **deps:** mcp-server 锁文件升级 hono 4.13.7 -&gt; 4.13.13（修 GHSA-5r4p-p66f-jhc7） ([d31a0d4](https://github.com/LuluDeer/AutoCodeFlow/commit/d31a0d4872832a141dd4ceceb8642d92403ec910))
* **executor-desktop:** 主进程安全面审计——IPC sender 闸 + check-port 参数闸（R86-A1）+ 两个从未执行的 selftest 接线（R88） ([55ac29e](https://github.com/LuluDeer/AutoCodeFlow/commit/55ac29e7949a113d85e4eaca2f5cad2b725722b4))
* **mcp-server:** env 与 params 补**字节**口径上限——和 R111 的「码点」是两件事（R115） ([a8a9a02](https://github.com/LuluDeer/AutoCodeFlow/commit/a8a9a02f8696ca632255294dfbbe17b00a53adce))
* **mcp-server:** 入参字符串补长度上限，逐字段对齐后端 DTO（R111-A1） ([ba16215](https://github.com/LuluDeer/AutoCodeFlow/commit/ba16215e7efd603e945dfdc5ea5eb451e4f43f48))
* **mcp-server:** 工具出参加一层凭据剥除——上游干净，但只有一层（R110） ([fa5f8fa](https://github.com/LuluDeer/AutoCodeFlow/commit/fa5f8facd1e7e345fd0731cbd97c2b9ba16a8fa3))
* **mcp-server:** 形状漂移不再伪装成「全清」——list_dead_letters 补 isError（R114） ([5ccd81e](https://github.com/LuluDeer/AutoCodeFlow/commit/5ccd81ef29598bb62b503f9582c6dbc1c6da4173))
* **mcp-server:** 收紧 8 个枚举入参并为 params:{} 恢复「无覆盖」语义（R107-A1） ([58a551e](https://github.com/LuluDeer/AutoCodeFlow/commit/58a551e486f26a75be7b676249eef4d04bb9df07))
* **mcp-server:** 空载荷不再伪装成成功——get_execution / timeline 补 isError（R112） ([5c42f74](https://github.com/LuluDeer/AutoCodeFlow/commit/5c42f74e321559a84e4c8771a3c03abbf5bd03ba))
* **notification:** 出站面审计——未注册渠道静默丢告警、渠道开关失效、读面 ?key= 明文（R150-A1） ([ce67bc7](https://github.com/LuluDeer/AutoCodeFlow/commit/ce67bc7ededcfd5587a9c0fa29c15374ce1a84b5))
* **release:** atlas 的两处 lockstep 版本声明纳入 release-please 广播 ([fbdc812](https://github.com/LuluDeer/AutoCodeFlow/commit/fbdc8120c49db8acc0512c818341ab9f13fefd54))
* **release:** 把 atlas 的两处 lockstep 版本声明纳入 release-please 广播 ([53f0f22](https://github.com/LuluDeer/AutoCodeFlow/commit/53f0f222974cc93d10131ceba8239219ca19ea34))
* **sdk:** 对外 SDK 健壮性审计——错误面统一 / 尊重 Retry-After / 回调路径判定修正（R177-A1） ([103cff3](https://github.com/LuluDeer/AutoCodeFlow/commit/103cff341f0cfd8fc1cc902fae85e70d8d157996))
* **sdk:** 终态回调的单次重试等待封顶 5s——别让「为可靠性做的重试」把终态丢掉（R191） ([135f4b3](https://github.com/LuluDeer/AutoCodeFlow/commit/135f4b332838e632a76643870b2b183de80ed7fb))


### Reverts

* **desktop:** remove V2 renderer and restore V1 (1.9.2) ([7492dda](https://github.com/LuluDeer/AutoCodeFlow/commit/7492dda76ad51115a6a509a20a42019c64362572))


### Miscellaneous Chores

* **release:** 下一版按 minor 走（1.13.0），并校正 SDK README 的版本标注 ([175494e](https://github.com/LuluDeer/AutoCodeFlow/commit/175494efb361542c2fa2fd1ee738e11ce0af4032))

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
