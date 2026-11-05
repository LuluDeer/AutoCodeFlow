# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · ⚠ **链当前红在 94/95 `check:posture-matrix-tables`**
**会话**：第 76 轮 · 并行第 14 批收尾

## 本轮落地（HEAD）
1. **ADR-035 渠道判定两端对齐**（`1c667369`，只写设计）：admin 判 `codeSource==='application_zip' || (codeSource==null && applicationId)`（`executor.service.ts:5465-5467`，**唯一一处**）；python 多一个 `packageUrl` 条件（`execute.py:2318`）。**契约明确支持 admin 口径**（`CONTRACT.md:355/430`、`:245` 存量回填优先级）⇒ 判定 **admin 正确、python 应对齐**；决定性理由：**admin 判定时刻手上还没有 packageUrl**（要先查 applications 表），加该条件是「先有鸡还是先有蛋」。
2. **node 渠道判定收唯一事实源 + 修过阻**（`36a25ead`）：新增 `src/task-channel.ts`（`isZipChannelEnabled` + `readTaskAlias` 上收）；prepare 路径原本等价内联，但**两道 accept 闸与 pull 预闸只看「没有 gitRepo」** ⇒ 与 python 不同源；旧实现**过阻 glue 渠道**与「无 codeSource+applicationId」。12 组真值表 + 路由级/ pull 级判据；**体量全部压回上限内（无需代签）**；反向验证两条（优先级改反 / 闸退回旧口径）均红。
3. **webhook 面改为真跑判据**（`e58f5aa2`）：经 `--experimental-strip-types` 子进程**真跑** `evaluateOutboundPosture`（决策层），期望值来自契约 `switch.semantics`（**不从实现反推**）；红演示成立（把「其余类别」改宽松 ⇒ exit 1 并点名 loopback×off 不一致）。**降级部分**：「地址→risk」仍带 Nest 依赖，未真跑（由「不许硬编码地址」判据兜住）。**反向验证未取得证据**（两次注入得非法 JS，如实记录）。
4. **发版公告标题稳定化 + 必需小节判据规格**（`0b5a9b46` + 规格）：五节关键词各自唯一（原「### 4.1/4.2 可回滚/不可回滚」会命中子串 ⇒ 改「运行期可撤回/无法撤回」）；规格含白名单 `^docs/RELEASE-NOTES-[^/]*\.md$`、三条反例、实现落点（`check-docs.mjs` 与 `checkAdrStructure` 平级、**勿塞进它**）、**原型实测**（删节⇒红 / 非白名单不误伤 / 现仓库 0 违规）。

## ⚠ 当前红（下一轮第一件事）
`check:posture-matrix-tables` **exit 1**（链 94/95）。本轮诊断输出见下方；最可能原因：W5 新增 `task-channel.ts` / `task-channel.spec.ts` 被该守卫的「不许硬编码地址」或「三端表齐备」面扫到（或地址条数 25 的口径被新文件影响）。**先看输出再改判据，不许放宽**。

## 未收口
① 上述红；② W1 webhook 判据的**反向验证**（一行：`got !== c.expected` → `false`）仍未做；③ python 应按 ADR-035 去掉 `packageUrl` 条件（实施轮）；④ `classifyAddressRisk` 抽零依赖纯函数（让「地址→risk」也真跑）；⑤ release-notes 五节判据待实施（规格已备，落 `scripts/**` = W1 域）；⑥ ADR-034 契约类别表实施；⑦ 真机脚本接链（需 CI postgres）；⑧ R18-B blocked；⑨ liveness 覆盖面仅 2 个脚本。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红——绿而不可红 = 死判据**；**对照断言须配独立锚定**（期望值来自契约/需求而非实现）；作者中断≠改动作废；跨端改动**同载荷同结论**且**判的值须与真正使用的值同源**；定位代码块只用 CodeGraph 符号边界；断言源码文本必须登记；**判据红时必须先看输出再决定改代码还是改判据**；worker 只跑定向，全量/链由 Lead 串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
