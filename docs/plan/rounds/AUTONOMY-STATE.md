# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准（HEAD 含 `cddbf480` + 本卡）· **5 worker 并行** · 守卫链 93 段**全绿**
**会话**：第 68 轮 · 并行第 6 批收尾

## 本轮落地（HEAD）
1. **admin webhook 面收紧**（`8968daeb` + ADR-033 `cddbf480`）：11 个调用点共享 `safe-http.util.ts` 的两处谓词 ⇒ **同源一次收紧**。逐类：loopback 放行→**拒**、cgnat 放行→**拒**、ipv4Mapped 包裹受限地址 放行→**拒**；public/privateIPv4 不变；linkLocal/unspecified/multicast/reserved 本就恒拒。判据：旧实现 **exit 1** → 绿 **25 suites / 537 passed**，`tsc` 0。**反向验证两处**：短路姿态谓词 ⇒ exit 1；短路 `classifyAddressRisk` 的 metadata 分支 ⇒ exit 1（教训：admin 把元数据端点也归 reserved，属**双层防御**，只短路 `isMetadataAddress` 测不出，**判据须断言分类层具体归类**）。
2. **`UPGRADING.md §10` 补齐**（Lead 代写）：新增 `reserved`（benchmark 段 `198.18.0.0/15`）行 + **R66 webhook/通知/OIDC/AI 出站面收紧**段（11 个调用点、开关开启只放行 RFC1918、受影响现场、回退路径）。`test:docs` **exit 0**。
3. **W1 全链复跑全绿**（`69f65cb6` 代签 `deploy.spec.ts` 1487）：`docs` 0(6/6) · `size-caps` 0 · `guards-wired` 0 · `guards:repo` **0，末行「✔ 全链通过：解析 93 段 / 执行 93 段 / diff 空」** · `bundle-drift` 0。
4. 此前已入：node 下载面同族缺陷修复（`96ac8eae`，旧 14 failed → 37 passed）、python 出站闸收紧（`4cf4ebdb`，全 python 套件 1724 passed/1 skipped）、`.env.example` 补灰度键（`4a33b5e0`，env-drift 0）、per-call context 恢复与 ADR 回填（`29bf2fca`/`1102403a`）、W2 部署页消歧、形态分派助手 4/4 接线。

## 三端姿态现状（对齐后）
| 面 | 开关开启时放行 |
|---|---|
| admin 执行器面 / webhook 面 / node 下载面 / python 出站闸 | **仅 privateIPv4（RFC1918）**；loopback·linkLocal(含云元数据)·cgnat·unspecified·multicast·reserved·ipv4Mapped 包裹受限地址 **恒拒** |

## 未收口（按优先级）
1. **用户可见行为变更需公告**：Tailscale `100.64/10`、`169.254.x`、`127.0.0.1`（同机通知/webhook/OIDC/AI）、`0.0.0.0` 形态、`198.18/15` 在开关开启时被拒（RFC1918 与 loopback 不变）；`§10` 已写，**发版公告**仍需运维动作。
2. **灰度阀待回收**：`PY_EXECUTOR_SWITCH_POSTURE_STRICT`（ADR-032 Step5）；node/admin 侧是否需要同类阀待定。
3. **类别名不统一**：admin 叫 `restricted`、node/python 叫 `reserved`（结论一致）⇒ 统一需动三端分类表（独立立项）。
4. **契约层地址类拆分**（ADR-032 后续）：要让「只放开 cgnat 而挡住 linkLocal」必须拆契约类别 + 新 ADR。
5. 真机脚本接链（需 CI postgres，本地无法验证 CI 真跑）；R18-B blocked；flaky 待复发取证；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；服务端无 `reservedSlots<=running` 下限；`execute` 676 行待拆（ADR-031 步骤 4/5）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（恒真⇒变绿；**判据要断言分类层具体归类，不能只断言"调用了某函数"**）；形态不合不套用；删别人写域文件前先确认它是否已验证；worker 只跑定向，全量/链由 Lead 或 W1 在无在途改动时串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
