# 架构决策记录（ADR）索引

> 固化历轮开发中“代价高昂才学到”的架构/契约决策。每篇 ADR 记录：背景、决策、后果、被否掉的替代方案。
> 状态：Accepted（现行）/ Proposed（待拍板）/ Superseded（被 ADR-xxx 取代）。新决策按序号追加。

## 写作规则

- 新 ADR 使用 [adr-template.md](./adr-template.md)，文件名格式为 `adr-XXX-short-title.md`。
- 只记录会影响后续代码、测试、运维或安全边界的决策；普通实现说明不要写成 ADR。
- 若修改既有决策，优先新增 ADR 并把旧 ADR 标为 `Superseded by ADR-XXX`，避免重写历史。
- 决策必须能落到可验证约束，例如测试、CI 检查、迁移规则、部署 runbook 或代码不变量。

## 索引

| ADR | 标题 | 状态 |
|---|---|---|
| [ADR-001](./adr-001-per-execution-callback-token.md) | per-execution 回调 token（域分离 HMAC，v1.&lt;execId&gt;.&lt;exp&gt;.&lt;hmac&gt;） | Accepted |
| [ADR-002](./adr-002-scheduler-dual-guard.md) | 调度器多实例双保险：Redis Leader Election + DB 条件 claim | Accepted |
| [ADR-003](./adr-003-idempotent-token-issuance.md) | 执行器 per-executor token 幂等签发（startupId 稳态不轮换） | Accepted |
| [ADR-004](./adr-004-response-envelope-contract.md) | 全局响应信封 `{code,message,data}` 是所有客户端的隐形契约 | Accepted |
| [ADR-005](./adr-005-bundle-same-commit.md) | executor-node 源码与 ncc bundle 必须同 commit | Accepted |
| [ADR-006](./adr-006-rbac-same-release.md) | RBAC 收紧与前端门控同批发布 | Accepted |
| [ADR-007](./adr-007-config-first-ownership.md) | 多来源配置的优先级必须钉死在契约与测试里 | Accepted |
| [ADR-008](./adr-008-mock-vs-reality.md) | 调度/队列/迁移改动的验收必须含真机冒烟 | Accepted |
| [ADR-009](./adr-009-log-storage-dual-store.md) | S3 日志驱动的跨存储一致性边界 | Accepted |
| [ADR-010](./adr-010-db-claim-dedup-window.md) | 触发去重窗口的语义：TTL 即窗口（renew:false） | Accepted |
| [ADR-011](./adr-011-domain-event-bus.md) | 进程内领域事件总线——执行终态副作用与回调主链解耦（ARCH-21，FEAT-07 基座） | Accepted |
| [ADR-012](./adr-012-executor-token-safestorage.md) | executorToken safeStorage 加密——三平台差异、basic_text 降级姿态与存量迁移（P0-4） | Accepted |

## DOC-04 覆盖状态

DOC-04 原目标是把历轮关键决策固化为 ADR-001~010。当前已覆盖到 ADR-012，并补充了后续写作模板与索引规则，因此该项视为已完成；后续新增架构决策按模板继续顺延编号。
