# 实施轮 #11（2026-10-27）：把「没跑真机」的账还掉 + Agent 运行时三处 P1

> 编排：主控 + 1 个**限时**只读 subagent（25 分钟预算、分段交付）。
> 上一轮两个 subagent 跑 50 分钟零产出被中断；这轮改成"到点无论进展如何立刻交"，
> **生效了**——它交回了 3 条 P1 + 9 条 P2 + 10 条"不是问题"。

承接：[实施轮 #10 报告](implementation-round-10-2026-10-27.md)。

---

## 1. per-IP 硬顶：第一次真机验证

轮 #8 落地的 `ip-ceiling.middleware` 此前只有 10 例单测（假 express 对象上的纯逻辑）。
单测证明不了的三件事——**是否真挂进 Nest、是否真在 55MB parser 之前、路径前缀是否匹配**——
任何一件错位都表现为"测试全绿但线上没有防护"。

本轮把 admin-api **真跑起来**（`node dist/main.js`，真实 PG/Redis，`NODE_ENV=production`），
新增 `scripts/ip-ceiling-live-drill.mjs`：

```
回调面 per-IP 硬顶真机演练（额度 5/min）
  ✔ 前置：admin-api 可达
  ✔ 额度内放行、超出后触发 429（第 6 次）
  ✔ ③ 换 x-executor-address 仍被拦（原缺陷的绕过形态已关闭）
  ✔ 429 携带 Retry-After=60
  ✔ ④ 不带 x-executor-address 同样受限（桶键与头无关）
  ✔ ⑤ 同 IP 的其它路由不受影响（health/live=200）
✔ 真机演练全部通过
```

**反证**：把服务端额度调到 100000 重启后，同一脚本**红 3 项**——判据有牙。

顺带证明两件事：① 生产守卫真的会拒绝弱值（实测两次启动失败：31 字符的
`JWT_REFRESH_SECRET`、弱 `INITIAL_ADMIN_PASSWORD`）——这正是轮 #8 修的 OPS-03
那个事故的成因；② 旧的 demo 栈（36 小时前构建）跑这个演练会红，**这是正确行为**，
脚本已按概率列出三种成因（旧构建最常见）。

## 2. Agent 运行时：3 条 P1 已修（全部带反证）

subagent 交回的三条 P1，主控逐条复核后**全部证实**并落地：

### A1 · 审批面只有申请没有批准（P1）

- **实测**：`requestApproval()` 只拼一个 `apr-<sessionId>-<ts>` 字符串 + 推通知，
  **不落库**（无 approval 实体）；`agent.controller` 只有 list/detail/create/resume/budget
  五条路由，**没有任何批准端点**；`markWaiting()` 在生产代码零调用方。
- **后果**：5 个 `approvalRequired: true` 的工具（update_task / rollback_task_version /
  upgrade_deployment / stop_deployment / sop_publish）稳定返回 awaiting_approval，
  **永远等不到批准**——"声明可经人工点头执行，实际永久不可执行"。
- **本轮处置（如实降级，不硬塞半成品）**：
  1. 注册表加 **APPROVAL-GAP** 注释，把事实写死在声明旁边；
  2. 回给模型的文案从「【等待人工审批】…请勿重复提交」改为
     「【需人工审批，当前不可执行】…审批通道尚未接通，重复提交只会再次挂起——
     请改用只读手段，或把结论写进最终报告交由人工执行」——
     **不再诱导模型等待**（等待会让它反复重试，白烧轮次）；
  3. 新增 tripwire：一旦有人补上 approvals 路由，脚本会反过来要求"把注释与文案一起更新"。
- **反证**：把文案改回"等待人工审批" → tripwire 立即红；恢复后绿。

### A2 · 自动触发会话空 scope 打残白名单（P1）

- **实测**：`agent-trigger` 建 incident 会话时硬编码 `scope: {}`，而
  `validateScope` 对"该资源类型允许集合为空"是**直接 deny out_of_scope**；
  incident 白名单里的 trigger_task / retry_execution / kill_execution / pause_task /
  resume_task 全是绑定资源的工具 ⇒ **一个都调不动**，事件处置场景只剩只读工具。
- **本轮修复**：新增 `buildEventScope(eventType, resourceKey, payload)`，
  按事件类型绑定**该事件自身的资源**：
  `execution.*` → `{executions:[id], tasks:[id]}`；`executor.offline` → `{executors:[id]}`；
  `deployment.completed` → `{applications:[id]}`；**认不出的形态返回 `{}`（保守默认不倒退）**。
- **修复过程中被新断言抓出一个真错**：`executor.offline` 的 resourceKey 是**地址**
  （`office:8002`，聚合按"哪台机器"分组），而工具要的是 **executorId** ——
  首版实现直接把地址塞进 scope，等于**绑错维度**（校验永远不匹配）。
  已改为从事件载荷取 id，取不到就不绑。这条是"写测试时才发现"的典型。
- **反证**：三条新断言（映射正确 / 认不出即空 / 绝不产生 unrestricted 通配）+
  一条维度断言（缺 id 时不绑），31/31 绿。

### C4 · awaiting_approval 消耗速率配额（P2，顺手修）

- 审批没闭环时，一个会话碰几次"需审批"的工具就把 15 次配额烧光，而它一次都没真正执行。
- 修法：`countPriorCalls` 排除 `awaiting_approval`（与既有"排除 denied"同精神）。
- **反证**：3 条历史里 2 条 awaiting_approval → priorCalls=1。

## 3. 其余 P2：登记不修（附理由）

| ID | 内容 | 为什么不本轮修 |
|---|---|---|
| A3 | 闸门 counters 跨崩溃不落盘（只在终态/澄清分支回写 journal）⇒ 反复 kill 可续命 15 轮/2h | 要动 journal 写入时机 + 崩溃恢复语义，属独立切片；**这是三条 P1 里唯一未修的**，已列入下一轮首位 |
| B1 | `dependency_install` 闸是死代码（全仓仅 selftest 调用） | 要么接上 trialRun 前置判定、要么删掉常量——涉及"试跑是否允许装依赖"的产品口径 |
| B2 | `AgentHostDeps.limits` 生产恒为空（15 轮/2h/5 澄清/30 试跑不可配） | 需要托管配置快照注入 + 热更新链路 |
| B3 | 执行器澄清上限与中台 SOP `maxRounds` 不协商（有 escalated 兜底，故 P2） | 需把 poll 载荷的 maxRounds 注入 loop limits |
| B4 | 预算只按轮判，轮内 N 个 toolCalls 串行无闸 | 改推理循环内层，回归面较大 |
| C1 | `deploy_application`/`deploy_app` 是 write 但无 `approvalRequired` | 需先确认 DEP-04 默认开关（未验证） |
| C2 | `resourceKind` 缺省放行仍 latent（当前每个 spec 都显式写了） | 与轮 #7 同一项，改必填会触碰全部 56 个 spec |
| C3 | 澄清回复归属校验在执行体而非闸门 | 需 sop 侧投影数据做 pre-resolve hook |

## 4. 验证矩阵

| 项 | 结果 |
|---|---|
| admin-api 全量 | **354 套件 / 6225 例全绿**（+4 例） |
| 真机演练（额度 5） | 5/5 通过 |
| 真机演练（额度 100000，反证） | 红 3 项 |
| `agent-boundary-check` | 全绿（含 APPROVAL-GAP tripwire + C4 判据） |
| `test:guards:repo` | EXIT=0 |
| 进程清理 | 测试实例已 kill、端口 3199 已释放；未触碰昨日遗留的另一个 `dist/main.js` |

## 5. 遗留（按优先级）

1. **A3 闸门计数跨崩溃丢失**（三条 P1 里唯一未修）。
2. 审批闭环（审批实体 + grant/revoke 端点 + 恢复执行）——A1 只做了"如实降级"。
3. B1~B4 / C1~C3 八条 P2。
4. `dangerouslyIgnoreUnhandledErrors` 彻底关闭、`e2e-full.sh` 进本地闸、
   deploy.sh 镜像重建与就绪闸门真镜像演练、A2 产品决策。
