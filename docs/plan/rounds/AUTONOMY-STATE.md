# AUTONOMY-STATE — 状态卡（≤40 行）· **收尾交接版（第 6 轮，本轮只交接）**

**基线**：HEAD `b82950fa` · 工作区干净 · 台账 PLAN-CLAIMS/HANDOFF 均含 R05 印记（已核）
**本会话**：5 个增量轮全结项（R01–R05，11 提交）· 手册 `AUTONOMY-LOOP.md`(90 行) · 本卡 39 行
**下个会话第一动作**：`git log -1 --oneline && git status --short` 确认 `b82950fa`、干净 → 读本卡 → 打「UPGRADING 升级段」

## 开工三步（无脑照做）
1. 读完 `AUTONOMY-LOOP.md`（六步/证据/止损/轮换）；
2. `send_message` 到 teammate **`guard-chain`** 续跑（它熟 R01–R05 全部栈内上下文，别新开）；
3. 立项 P1：**`docs/UPGRADING.md` 补「内网 / 回环执行器」升级段 + 一条升级回归用例**。

## 下轮 P1（账上最脏的一笔，必做）
R05 引入**破坏性变更且未公告**：① 内网执行器须显式 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`（compose 默认栈已开）；② **同机 `127.0.0.1` 执行器不再可用**（契约「打自己回环没有合法拓扑」）。
判据：新增升级回归用例（读到旧配置应给出明确报错/告警）+ `test:docs`/`guards:repo`/`size-caps` 全 exit 0。回滚：单文件还原。

## 其后 backlog（按序）
1. `policy:'webhook'` 姿态仍把 `restricted` 放开关组（§7.1，同族第二处，建议立项 `webhook-posture-cgnat`）；
2. executor-node 侧 `.env` 加载未同等约束（§7.4 P2）；133 键二分（可选）；
3. 守卫框架 meta-改造（§7.2 P2，`check-guards-wired.mjs:424-425` 字符串展开面）；
4. 真机债未碰：接管 CAS 并发 / 灰度 × 部分唯一索引 / agent 域 23505 归因 / firepoint 步骤 7。

## 已收口（别重做，会白干）
R01 CGNAT 恒拒 · R02 守卫链报告面（含**纠错**：退出码一直是对的，坏的是可见尾部）· R03 灰度租约 5s 空窗 · R04 自检 hermeticity（`.env` **三个**入口：`main.ts:31` / `app.module.ts:70` / `data-source.ts:14`）· R05 协议两格四方对齐（真机 smoke PASS=84/FAIL=0）。

## 血泪教训（新会话必读）
- **回执也会给错归因**：R01 说「守卫链报告成功」是错的；关键结论必须交叉复核（R04/R05 均由 Lead 实跑复核过主判据）。
- **「本地全链可信」是 R04 才买来的地基**：R04 之前所有本机红可能是 `.env` 污染，别把环境问题当代码缺陷。
- 主会话 ≤8 次工具调用/轮（本会话实测 9/7/7/8/8/2）；只读本卡 + 手册 + git 摘要，其余全派。
- `git add` 只用显式路径，禁 `-A`；未跑真机标 `unverified`（R05 的 docker smoke 是真跑，其余真机项仍是 `unverified`）。
- 轮数 ≥6 → 收尾轮；同一阻塞 3 轮 → blocked；验证失败 2 次 → 回滚。
