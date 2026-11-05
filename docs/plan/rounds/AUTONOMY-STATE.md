# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 94 段全绿**
**会话**：第 71 轮 · 并行第 9 批

## 本轮落地
1. **python 灰度阀退役完成**（`a5592905` + `2030c39c`）：开关删键/删分支/删死代码，**默认=收紧后新姿态**（六类恒拒、privateIPv4 放行、恒拒表先于开关）；源码命中 **0**；`.env.example` 755–756 已删，`env-drift` **0（230 键）**。
2. **三端姿态一致性已核实并机检**：链 **93 → 94**（`check:posture-matrix-tables`），三端 25 条地址同量、零硬编码、各自入口可达；守卫 selftest **5/5**。
3. **姿态矩阵守卫的检查面已扩到恒拒表**（W1 中断后由 Lead 验收并提交）：`metadataAddresses` 已并入「不许硬编码」面，`grep -c` = 5，`--selftest` **5/5**，链 **94/94 exit 0**。
4. **`execute` 676 → 578**（service 911 → 843），搬出 arg-parse / result-finalize / failure-finalize 三模块，反向验证两个 finalize 换空分别 14 / 13 failed。
5. **node gitRepo fail-open 修复** + 表驱动 spec；**W2** 仪表盘热力条与 **acf-cli** 度量消歧（acf-cli 改为真算「实际在跑」并另列 Occupied）。
6. atlas 量级层已刷新（acf-cli 测试文件 13→14 等）。

## Lead 决定
- **`execute` 余下 578 行的审批状态机：事务边界不跨函数**（只接受同一事务函数内纯段搬家），避免打断 R60/R61 的「单判据 + 结清」语义。
- **W1 本轮中断**：其 `check-posture-matrix-tables.mjs` 改动经 Lead 独立验收（selftest 5/5 + 链 94/94）后提交 —— **不因作者中断就丢弃已验证的改动**。

## 仍在 W1 名下、未完成
- **两处覆盖边界勘察**（admin `assertSafeGitRepoUrl` 恒放行 private-lan；admin webhook 面不在真四向判据内）—— 以契约为准判定「差异 vs 缺口」，**不硬加**。**下一批第一件事。**

## 未收口
① **发版公告**（Tailscale `100.64/10`、同机 `127.0.0.1`、`0.0.0.0` 形态、`198.18/15` 在开关开启时被拒；`UPGRADING §10` 已写，运维动作未做）；② 契约层拆地址类（ADR-032 后续）；③ 类别名 admin `restricted` vs node/python `reserved`；④ 真机脚本接链（需 CI postgres）；⑤ R18-B blocked；⑥ `zip` 渠道 packageUrl 无 accept 期同步闸；⑦ 无主机形态的解析失败串仍放行；⑧ flaky 待复发取证；⑨ `test_package_redirect_gate_*` 末段断言在 parametrize 体内（重复报 5 条）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（**断言分类层具体归类**）；形态不合不套用、代价太大就停手并给替代；**作者中断不等于改动作废——交由 Lead 独立验收**（本轮已用此法救回一处）；覆盖边界先判「差异 vs 缺口」；worker 只跑定向，全量/链由 Lead 或 W1 在无在途改动时串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
