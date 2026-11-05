# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准（HEAD `2030c39c`）· **5 worker 并行** · **守卫链 94 段全绿**
**会话**：第 70 轮 · 并行第 8 批

## 本轮落地（HEAD）
1. **python 灰度阀已退役**（`a5592905`，ADR-032 Step4/5）：`PY_EXECUTOR_SWITCH_POSTURE_STRICT` 删键删分支删死代码，**默认=收紧后新姿态**（测试证据：六类 `allowedUnderPrivateNetwork=false` 在开关开启时全拒、privateIPv4 仍放行、恒拒表仍先于开关）；源码扫描命中 **0**；`.env.example` 755–756 已由 Lead 删除（`2030c39c`），`env-drift` **exit 0（230 键）**。
2. **三端姿态一致性已核实**（W4）：loopback / privateIPv4 / linkLocal / cgnat / unspecified / multicast / reserved + 恒拒表，三端**同结论** ⇒ 「python 严于 node 下载面」**已消解**（R63/R66 之后），**不登记过期 finding**。python 全量 `-k not slow` **1793 passed / 1 skipped**；`check:protocol-three-way` 14 格 0 不一致。
3. **`execute` 676 → 578**（`1807a782`/`990ed516`），service 911 → 843；搬出 arg-parse(85) / result-finalize(59) / failure-finalize(73) 三模块；反向验证：两个 finalize 换空分别 14 / 13 failed。
4. **node gitRepo face fail-open 修复**（`f99f0129`）+ 表驱动 spec（`e1365104`）；**posture-matrix 守卫全绿**（三端 25 条同量、零硬编码）。
5. **W2 两处度量消歧**：仪表盘热力条（`f4509d7a`/`15ba1378`）与 **acf-cli**（`c8846331`/`34fb7ac8`）——acf-cli 上游返回整行实体、`reservedSlots` 可得，已改真算「实际在跑」并另列「Occupied Slots」。
6. **atlas 量级层刷新**（本轮）并提交。

## Lead 决定（本轮）
- **`execute` 余下 578 行的审批状态机 E–K 段：事务边界不跨函数。** 只接受同一事务函数内做纯段搬家；**不接受**把 `consume` 事务拆成两段（会打断 R60/R61 修好的「单判据 + 结清」语义）。

## 在途
- **W1**：① 把 `metadataAddresses.addresses` 并入「不许硬编码」检查面（W3 实测注入 `100.100.100.200` 不报）；② 勘察两处**覆盖边界**（admin `assertSafeGitRepoUrl` 恒放行 private-lan、admin webhook 面不在真四向判据内）——以契约为准判定「差异 or 缺口」，**不硬加**；③ 复跑 94 段链。
- W2/W3/W4/W5 空闲，待下一批。

## 未收口
① **发版公告**（Tailscale `100.64/10`、同机 `127.0.0.1`、`0.0.0.0` 形态、`198.18/15` 在开关开启时被拒；`UPGRADING §10` 已写，运维动作未做）；② 契约层拆地址类（ADR-032 后续）；③ 类别名 admin `restricted` vs node/python `reserved`（结论一致）；④ 真机脚本接链（需 CI postgres）；⑤ R18-B blocked；⑥ `zip` 渠道 packageUrl 无 accept 期同步闸；⑦ 完全无主机形态的解析失败串仍放行；⑧ flaky 待复发取证；⑨ `test_package_redirect_gate_*` 的末段断言仍在 parametrize 体内（会重复报 5 条）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（**断言分类层具体归类，不只断言"调用了某函数"**）；形态不合不套用、代价太大就停手并给替代；**删别人写域文件前先确认它是否已验证**；覆盖边界先判「差异 vs 缺口」再动手；worker 只跑定向，全量/链由 Lead 或 W1 在无在途改动时串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
