# 架构决策记录（ADR）索引

> 固化历轮开发中“代价高昂才学到”的架构/契约决策。每篇 ADR 记录：背景、决策、后果、被否掉的替代方案。
> 状态：Accepted（现行）/ Proposed（待拍板）/ Superseded（被 ADR-xxx 取代）。新决策按序号追加。

## 写作规则

- 新 ADR 使用 [adr-template.md](adr-template.md)，文件名格式为 `adr-XXX-short-title.md`。
- 只记录会影响后续代码、测试、运维或安全边界的决策；普通实现说明不要写成 ADR。
- 若修改既有决策，优先新增 ADR 并把旧 ADR 标为 `Superseded by ADR-XXX`，避免重写历史。
- 决策必须能落到可验证约束，例如测试、CI 检查、迁移规则、部署 runbook 或代码不变量。

## 索引

| ADR | 标题 | 状态 |
|---|---|---|
| [ADR-001](adr-001-per-execution-callback-token.md) | per-execution 回调 token（域分离 HMAC，v1.&lt;execId&gt;.&lt;exp&gt;.&lt;hmac&gt;） | Accepted |
| [ADR-002](adr-002-scheduler-dual-guard.md) | 调度器多实例双保险：Redis Leader Election + DB 条件 claim | Accepted |
| [ADR-003](adr-003-idempotent-token-issuance.md) | 执行器 per-executor token 幂等签发（startupId 稳态不轮换） | Accepted |
| [ADR-004](adr-004-response-envelope-contract.md) | 全局响应信封 `{code,message,data}` 是所有客户端的隐形契约 | Accepted |
| [ADR-005](adr-005-bundle-same-commit.md) | executor-node 源码与 ncc bundle 必须同 commit | Accepted |
| [ADR-006](adr-006-rbac-same-release.md) | RBAC 收紧与前端门控同批发布 | Accepted |
| [ADR-007](adr-007-config-first-ownership.md) | 多来源配置的优先级必须钉死在契约与测试里 | Accepted |
| [ADR-008](adr-008-mock-vs-reality.md) | 调度/队列/迁移改动的验收必须含真机冒烟 | Accepted |
| [ADR-009](adr-009-log-storage-dual-store.md) | S3 日志驱动的跨存储一致性边界 | Accepted |
| [ADR-010](adr-010-db-claim-dedup-window.md) | 触发去重窗口的语义：TTL 即窗口（renew:false） | Accepted |
| [ADR-011](adr-011-domain-event-bus.md) | 进程内领域事件总线——执行终态副作用与回调主链解耦（ARCH-21，FEAT-07 基座） | Accepted |
| [ADR-012](adr-012-executor-token-safestorage.md) | executorToken safeStorage 加密——三平台差异、basic_text 降级姿态与存量迁移（P0-4） | Accepted |
| [ADR-013](adr-013-project-roles.md) | 项目级角色细化——project_members 成员模型与 viewer/editor/admin 三档角色（AUTH-02） | Accepted |
| [ADR-014](adr-014-oidc-sso.md) | OIDC SSO 单点登录（授权码模式 / 无状态 state / oidcSub 三级绑定 / JIT 开关） | Accepted |
| [ADR-015](adr-015-executor-pull-dispatch.md) | 执行器 pull 模式派发——NAT 内执行器零入站回连（长轮询拉取，弃 WS 反连） | Accepted |
| [ADR-016](adr-016-executor-control-plane-pull.md) | 控制面 pull 通道——部署/停止/卸载/热更新/终止/包推送改走 pull 命令队列（协议 1→2，ARCH-33） | Accepted |
| [ADR-017](adr-017-executor-unique-identity.md) | 执行器唯一标识——设备指纹 + 安装实例盐（`address` 降级为可达性元数据，ARCH-34；阶段 3 已落地：指纹定位 + push 409 / pull 各自成行） | Accepted |
| [ADR-018](adr-018-executor-occupied-vs-running.md) | 心跳区分「已占槽位」与「在跑执行」——新增 `reservedSlots`（协议 3→4，E-01-RPT） | Accepted |
| [ADR-019](adr-019-center-agent-runtime.md) | 中台 Agent 运行时与隔离——独立队列 + 预算闸门 + fail-open 不回灌主链 | Accepted |
| [ADR-020](adr-020-agent-boundary-model.md) | 工具分级与边界闸门——五道检查 + 硬禁用不可配置 + scope 安全默认 | Accepted |
| [ADR-021](adr-021-sop-as-executable-contract.md) | SOP 即可执行契约——文档与契约分离、版本不可变 + contentHash | Accepted |
| [ADR-022](adr-022-executor-agent-arbitrary-code.md) | 执行器 Agent 与「受控的任意代码执行」信任模型变更——权限档位 + 硬闸门 + 默认最保守 | Accepted |
| [ADR-023](adr-023-params-env-injection-contract.md) | params → 子进程 env 的注入口径——字符串回归裸值 + 类型化 `AUTOFLOW_PARAMS_JSON` 通道（协议 4→5，A-11R） | Accepted |
| [ADR-024](adr-024-execution-record-archive.md) | 执行记录归档——保留期之外的 `task_executions` 是留是删（PLAN-BACKEND-ARCHITECTURE §2.2；四选项 + 触发条件 + 本轮不实施） | Proposed |
| [ADR-025](adr-025-audit-log-tamper-evidence.md) | 审计日志不可篡改性——append-only 触发器已是有效控制，不引入哈希链（PLAN-SECURITY-HARDENING §6.1-6.2；五类假阴性 + 实测 TRUNCATE/DBA 绕过边界 + 本轮不实施） | Accepted |
| [ADR-026](adr-026-conditional-state-writes.md) | 状态迁移写必须条件化——四个模块的同一根因（整行回写 / 无前置状态 UPDATE）与六条可验收规则（R32-C3 / R32-C1 / R33-B2 / R33-A2） | Accepted |
| [ADR-027](adr-027-test-double-fidelity.md) | 测试替身必须保真——替身不保真 ⇒ 整类缺陷隐形（FindOperator 求值 / 快照读 / save 逐列 diff / 并发交错钩子 / 未知操作符必须抛错） | Accepted |
| [ADR-028](adr-028-config-secret-at-rest.md) | 配置类密钥的静态加密边界——**接受现状**（现值明文），明确**拒绝**「只加密历史表」的安全剧场，并给出四条重开条件（R83 顺着密钥脱敏数据流发现） |
| [ADR-029](adr-029-metadata-addresses-outbound-deny.md) | 出站地址闸的「元数据地址恒拒」契约段——把云元数据地址从 `restricted` 拆出单列，任何 posture/开关都拒，三端从契约派生（R07 裁决方案②） | Accepted |
| [ADR-030](adr-030-executor-token-cross-instance-idempotency.md) | per-executor 令牌签发的**跨实例幂等**——三方案对比（Redis 明文缓存 / hash+DB 幂等键 / 单写者 lease），采纳「确定性派生 + `tokenRotationEpoch` CAS」，否决另两条（R12 P1） | Accepted（设计；落地排下一轮） |
| [ADR-031](adr-031-replay-decision-hoist.md) | replay 决策前移——把「台账写哪一行」从两个判据（`opts.replayApproved` vs `verdict.approvedApprovalKey`）收成一个 per-call `ToolCallContext.ledger`，为 R57 blocked 的 `ToolCallLedger` 接缝清障（5 步计划 + 回滚开关；本轮零业务代码） | Proposed |
| [ADR-032](adr-032-python-switch-posture-parity.md) | python 执行器出站闸的「开关姿态」与契约对齐——开关只放行 `privateIPv4`（原先额外放行 linkLocal/cgnat/unspecified/multicast/reserved，含云元数据 `169.254.169.254`），与 node gitRepo / admin 执行器同构；Step 1–3 已落地（`8f04f468`/`4cf4ebdb`），含失效半径、`PY_EXECUTOR_SWITCH_POSTURE_STRICT` 灰度与「粒度不足 ⇒ 契约层拆分」后续立项（R61 立、R63 落） | Accepted（Step 1–3 已落地；Step 4–5 待办） |
| [ADR-033](adr-033-admin-webhook-posture-parity.md) | admin webhook 出站面的开关姿态与契约同构——开关只解锁 `privateIPv4`，`loopback`/`cgnat`/`benchmark` 任何开关态都拒；覆盖 11 个共享谓词的调用点（事件订阅入站+出站、5 个通知渠道、AI/OIDC 出站），与 node 下载面 / python 闸门结论一致（R66；11 个面的清单 + 失效半径 + 表驱动收敛） | Proposed |
| [ADR-034](adr-034-network-category-table-in-contract.md) | 网络类别表收敛到契约——三份手抄表 + 一层运行时别名（`CATEGORY_ALIASES`）改为「契约 `networkPolicy.categories` → 三端生成物」的编译期同源；收益是**编译期同源而非修行为**（三端决策已逐格一致），admin 保留粗标签靠 `endLabels` 反查（R70；8 处文件 + 5 步计划 + 回滚零风险） | Proposed |
| [ADR-035](adr-035-zip-channel-determination-parity.md) | zip 渠道判定的两端对齐——歧义行「无 codeSource + 有 applicationId + 无 packageUrl」：admin 判 zip（派发期解析不到就失败）、python 判非 zip（照常跑）⇒ 同一行两结论；判定 **admin 侧正确**（契约 CONTRACT.md §2.1/§2.4 两处都是 admin 口径，且 admin 判定时还没有 packageUrl），python 去掉 `packageUrl` 条件对齐（R75；5 步计划，首步先加跨端对照判据） | Proposed |
| [ADR-036](adr-036-localhost-dns-bypass.md) | `localhost` 系主机名**先于 DNS** 拒绝——旧实现只在 DNS 解析到 127.x 时才拒，`*.localhost` 解析到公网即被放行（R80 实测：注入公网解析 ⇒ 4 条用例红）；改用 R79 的零依赖 `isLoopbackHostname` 在 `lookup()` 前短路，并**刻意接受错误码变更**（`SSRF_HOST_DNS_LOOKUP_FAILED` → `SSRF_HOST_DENIED[_PINNED]`）；同族 git/executor 面登记为遗留 | Accepted |
| [ADR-037](adr-037-heartbeat-lower-bound-atomic.md) | 心跳 `runningTaskCount` 的**服务端下限并入同一条 UPDATE**（原子化，消除 count→write 的 TOCTOU）；**否掉**两条热门方案：B「下限改读占坑数」会永久饥饿（I2）、C「claim 与建行同事务」前提不成立（执行行总在占坑前已存在，`scheduler.service.ts:2855` → `task.processor.ts:326`）⇒ 无迁移、无开关、不动派发事务 | Accepted |
| [ADR-038](adr-038-broadcast-occupancy-vs-heartbeat-floor.md) | **同一计数列上的两种相反语义**：广播扇出按每台 `+1`（`executor.service.ts:6034`）但只有一行执行记录（`:5852-5855`）⇒ 未持行目标 `计数1/行数0`（真 PG 实证）；ADR-037 的心跳下限按**行数**取大 ⇒ 看不见广播占坑、会把它抹掉，而 `:6020-6026` 又**依赖**心跳覆写纠正广播少计 ⇒ 两者在同一列上互相抵消 ⇒ **容量少计、可被多派单播**。推荐**方案 B**（独立列 `broadcastReservedCount`，容量 = 两列之和，心跳下限仍只管单播行数）；否掉 A（行语义崩塌）/ C（把超卖写成已声明）/ D（热路径 join + TTL 清理） | Accepted（已实现，步骤 1–5 全部完成） |
| [ADR-039](adr-039-execute-transaction-boundary.md) | `execute` 能否安全再拆？**结论：没有事务可拆** —— `execute`（`tool-executor.service.ts:275` 起，503 行）内**零显式事务**，正确性建立在「单语句 CAS（`agent-approvals.service.ts:788-826`）+ 幂等条件写 + 严格因果顺序（闸门→领取→副作用→台账）」上；否掉 C（凭空引入两个事务 ⇒ 重复执行/审批单永久作废/漏结清，且**三者都静默**）、D（把审批链搬协作者，被 R99 硬裁决禁止）；B 只能抽三个**拒绝**分支（CAS 抽不出去，收益 25–35 行）。⇒ 有界性记入本 ADR，建议**关闭 backlog `execute-further-slimming`** | Accepted（结论=不值得拆） |

## DOC-04 覆盖状态

DOC-04 原目标是把历轮关键决策固化为 ADR-001~010。当前已覆盖到 ADR-031，并补充了后续写作模板与索引规则，因此该项视为已完成；后续新增架构决策按模板继续顺延编号。