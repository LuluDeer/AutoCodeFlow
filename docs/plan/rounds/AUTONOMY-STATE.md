# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 94 段全绿**（新加 posture-matrix）
**会话**：第 69 轮 · 并行第 7 批收尾

## 本轮落地（HEAD）
1. **三端姿态矩阵机检化**（链 **93 → 94**）：W1 新建 `check:posture-matrix-tables`（四判据：三端各有表驱动 spec / 条数一致 25 / 必须读契约且**不许硬编码地址字面量** / 各自测试入口可达；**不比对结论**，避免造第二实现——这是 W1 实测「python 可直跑、node/admin 需额外依赖」后按代价条款停手、再由我批准替代方案的产物）。三端 spec 已由 W3/W4/W5 补齐，守卫 **exit 0**。
2. **`execute` 拆分完成**（`1807a782`/`990ed516`）：**676 → 578**（目标 ≤600 达成），service **911 → 843**；搬出三个新模块（arg-parse 85 / result-finalize 59 / failure-finalize 73）+ 在途台账改私有方法。**反向验证**：`finalizeToolResult` 换空 ⇒ 14 failed；`finalizeToolFailure` 换空 ⇒ 13 failed。定向 8 suites/223 passed、`size-caps` 0。
3. **python 回收灰度阀**（`a5592905`，ADR-032 Step4/5）：`PY_EXECUTOR_SWITCH_POSTURE_STRICT` 已退役，默认＝**收紧后新姿态**。
4. **node gitRepo face fail-open 修复**（`f99f0129`）：URL 解析不了的主机（IPv6 zone-id 形态）此前 fail-open、现与下载面一致 DENY；顺带修两处判据漂移（`isRestrictedHost` 与分类器不同判、`isRestrictedIpv4` 漏恒拒表前置）。parity 修复前 **8 failed** → 绿 **78 passed**。
5. **W2 两处度量消歧**（`f4509d7a`/`15ba1378`/`c8846331`/`34fb7ac8`）：仪表盘热力条与 **acf-cli** 的「Running Tasks」实为**已占槽位**；acf-cli 侧因上游返回整行实体、**reservedSlots 可得**，已改为真算「实际在跑」并另列「Occupied Slots」。
6. **atlas 量级层刷新**（本轮）：`acf-cli` 测试文件 13→14 等，跑 `check-atlas-counts --update` 并提交。

## 三端姿态现状（一致）
开关开启 ⇒ **只放行 privateIPv4(RFC1918)**；loopback / linkLocal(含 `169.254.169.254`、`fd00:ec2::254`、zone-id 形态) / cgnat / unspecified / multicast / reserved(含 `198.18/15`) / ipv4Mapped 包裹受限地址 **恒拒**。

## 待裁决（我）
1. **`execute` 余下 578 行主要是审批状态机 E–K 段**：拆它须重排 `consume` **事务边界** —— 需先回答「事务边界能否跨函数」。**决定：不跨。** 拆分只能在同一事务函数内做「纯段搬家」，不接受把事务拆成两段（否则 R60/R61 修好的「单判据 + 结清」语义会被打断）。
2. **R68 守卫的「不许硬编码」检查未覆盖 `metadataAddresses.addresses`**（W3 实测注入 `100.100.100.200` 不报）⇒ 让 W1 把该数组并入检查面。

## 未收口
① 发版公告（Tailscale/127.0.0.1/0.0.0.0 形态/198.18 在开关开启时被拒；`UPGRADING §10` 已写，运维动作未做）；② 契约层拆地址类（ADR-032 后续）；③ 类别名 admin `restricted` vs node/python `reserved`（结论一致）；④ 真机脚本接链（需 CI postgres）；⑤ R18-B blocked；⑥ `zip` 渠道 packageUrl 无 accept 期同步闸（`enforcement.stage=accept` 未满足，但 SSRF 不可达）；⑦ 完全无主机形态的解析失败串仍放行；⑧ flaky 待复发取证；⑨ `.env.example` 里退役的灰度阀行待删（W4 应给行号）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（**判据要断言分类层具体归类，不能只断言"调用了某函数"**）；形态不合不套用、代价太大就停手并给替代；删别人写域文件前先确认它是否已验证；worker 只跑定向，全量/链由 Lead 或 W1 在无在途改动时串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
