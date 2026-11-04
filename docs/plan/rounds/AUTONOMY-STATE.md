# AUTONOMY-STATE — 状态卡（≤40 行）

**会话**：第 1 轮已收（R01 结项，commit `49345111`）· 基线 HEAD `49345111`
**未提交**：`docs/plan/rounds/AUTONOMY-LOOP.md` + `AUTONOMY-STATE.md`（本卡）为 untracked，**下轮第一个动作要决定：修索引引用后一起提交**
**循环手册**：见 `AUTONOMY-LOOP.md`（主会话每轮只读本卡 + 手册 + git 摘要）

## R01 结论（已结项）

- **修掉**：admin 执行器姿态把 `restricted`（CGNAT 100.64/10 含阿里云元数据 100.100.100.200 + RFC2544 198.18/15）放进「开关开启才放行」组，与 node/python 两态恒拒相悖（`safe-http.util.ts:95-98`、`:836-841`）
- **判据**：`safe-http.util.spec` + `ssrf-deny-matrix.spec` **先 3 红 / 63 绿 → 66/66 exit 0**；`test:api` 459 suites / 7,896 exit 0；`typecheck:api` exit 0；84 个守卫逐个全 exit 0
- 证据：`artifacts/autonomy/R01/{assess,brief,verify,guards-repo}.log|md`

## ⚠ 立刻要处理的债（R01 暴露）

1. **`test:guards:repo` 整链被 `test:docs` 的「孤儿文档」判据卡死** —— 本轮新增的两份 docs 未被索引引用 ⇒ 后面 84 个守卫根本没跑。**这是 Lead 自己造的**。
2. `policy:"webhook"` 姿态仍把 `restricted` 随开关放行（契约不管这条面，已进 PLAYBOOK §7.1）。

## 下轮第一步（新会话照做即可）

1. `git log -1 --oneline` + `git status --short` 确认基线未漂移（预期 HEAD=49345111，2 个 untracked docs）；
2. **修孤儿文档判据**：把 `docs/plan/rounds/AUTONOMY-{LOOP,STATE}.md` 接进文档索引（`docs/plan/rounds/README.md` 的分轮记录表），再跑 `npm run test:docs` 与 `test:guards:repo` 取**真实 exit code**；红了就修，绿了把两份 docs 一起提交；
3. 然后取 R01 指出的下一格：`loopback@on` / `privateIPv4@off`（需 compose/.env 默认值 + 真机 B4/B5 同批）；
4. 复用同一 subagent 会话续跑，不新开。

## 预算与纪律速记

- 主会话 ≤8 次工具调用/轮；不读代码、不读完整测试输出、不读 diff。**R01 实测 9 次（超 1 次，用于 bootstrap 两份 docs）—— 下轮起严格 8 次内，bootstrap 类动作不再进主会话。**
- 验证未跑真机 → 标 `unverified`；`git add` 只用显式路径，禁 `-A`。
- 连续 3 轮同一阻塞 → blocked；验证失败 2 次 → 回滚。
- 轮数 ≥6 或已被压缩 → 收尾轮，刷新本卡 + `goal pause`。

## 候选池（供 R03 起，取自 R01 实测）

`registerTaskTools` 854 行 / `dispatch` 631 行 / `ConfigPage` 1,682 行 / `TaskDetailPage` / `TaskFormPage` E·G·H·I / firepoint 步骤 7 + 冒烟脚本脏 DB 不可重入 / 接管 CAS 并发 / 灰度 × 部分唯一索引 / agent 域 23505 归因
（R01 实测：状态卡原 6 条候选里 **5 条已被 HEAD 推翻** —— 用前必须 CodeGraph 复核，不要直接照单开工。）
