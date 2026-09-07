# 架构决策记录（ADR）索引

> 固化历轮开发中"代价高昂才学到"的架构/契约决策。每篇 ADR 记录：背景、决策、后果、被否掉的替代方案。
> 状态：Accepted（现行）/ Superseded（被 ADR-xxx 取代）。新决策按序号追加。

| ADR | 标题 | 状态 |
|---|---|---|
| [ADR-001](./adr-001-per-execution-callback-token.md) | per-execution 回调 token（域分离 HMAC，v1.<execId>.<exp>.<hmac>） | Accepted |
| [ADR-002](./adr-002-scheduler-dual-guard.md) | 调度器多实例双保险：Redis Leader Election + DB 条件 claim | Accepted |
| [ADR-003](./adr-003-idempotent-token-issuance.md) | 执行器 per-executor token 幂等签发（startupId 稳态不轮换） | Accepted |
| [ADR-004](./adr-004-response-envelope-contract.md) | 全局响应信封 {code,message,data} 是所有客户端的隐形契约 | Accepted |
| [ADR-005](./adr-005-bundle-same-commit.md) | executor-node 源码与 ncc bundle 必须同 commit | Accepted |
| [ADR-006](./adr-006-rbac-same-release.md) | RBAC 收紧与前端门控同批发布 | Accepted |
| [ADR-007](./adr-007-config-first-ownership.md) | 多来源配置的优先级必须钉死在契约与测试里 | Accepted |
| [ADR-008](./adr-008-mock-vs-reality.md) | 调度/队列/迁移改动的验收必须含真机冒烟 | Accepted |
| [ADR-009](./adr-009-log-storage-dual-store.md) | S3 日志驱动的跨存储一致性边界 | Accepted |
| [ADR-010](./adr-010-db-claim-dedup-window.md) | 触发去重窗口的语义：TTL 即窗口（renew:false） | Accepted |
| [ADR-011](./adr-011-domain-event-bus.md) | 进程内领域事件总线——执行终态副作用与回调主链解耦（ARCH-21，FEAT-07 基座） | Accepted |
