# ADR-011: 进程内领域事件总线——执行终态副作用与回调主链解耦

状态：Accepted（ARCH-21，第十六轮）

## 背景

通知（含 NOTIFICATION_FAILED 审计兜底）此前由 `TaskService.handleCallback`
主链直调 `NotificationService`（私有方法 `notifyCallbackFailure`），AI 分析
与依赖扇出同样以 service 直调散布在回调/worker 链上。计划书 §5 判定该耦合
是 handleCallback 继续承载 FEAT-07（出站 webhook）等新增消费方的瓶颈。

## 决策

1. **薄层自研，不引 `@nestjs/event-emitter`**：admin-api 依赖里没有它；
   Node 原生 `EventEmitter` 封装 `DomainEventBus`（emit/on/off +
   `listenerCount`）约百行即覆盖需求，语义完全自控。为解耦一件事引一个包
   不划算。
2. **事件契约集中在 `common/events/domain-events.ts`**：事件名常量
   （`execution.completed` / `execution.failed`）+ 载荷类型。载荷只含原始
   类型（id 级 + 摘要级字段），common 层不反向 import task 模块实体；
   监听器需要实体配置（如 Task 的 alarmEmail/runbook）自行按 id 回查。
3. **时序契约：emit 必须在终态 DB 提交（条件 UPDATE winner 命中）之后**，
   事件即"已提交的既成事实"，监听器可放心回查。emit 点保持原通知直调的
   位置（fan-out/日志持久化之前）——旧不变量「即便后续步骤抛错，失败告警
   也已恰好发出一次」原样成立；重复回调走 affected=0 分支不再 emit。
4. **fail-open 双层**：总线对监听器同步抛错与异步 rejection 一律捕获、
   只记日志，`emit` 永不外抛；主链侧 `emitTerminalEvent` 再包一层
   try/catch 保险丝。「副作用坏了拖垮回调主链」被结构性禁止。
5. **TIMEOUT 不独立成事件**：`execution.failed` 载荷的
   `status:"timeout"`/`failureReason` 足以区分——与旧行为严格等价
   （旧代码 FAILED/TIMEOUT 走同款告警）。`killed` 在载荷类型中预留，
   当前 kill/sweep 链未接入 emit（见「后果」）。
6. **监听器归消费方模块**：`ExecutionEventsListener` 放 notification 模块
   （`OnModuleInit` 订阅/`OnModuleDestroy` 退订，总线为 `@Global` 单例），
   task 模块不再 import 通知实现。总线注入 `@Optional`（先例 OBS-04
   reportRepo）：生产由 `DomainEventModule` 恒提供，既有独立 spec 装配缺
   provider 时事件静默不发、主链行为不变。

## 后果

- 验收红线达成：`task.service.ts` 不再 import/注入 `NotificationService`
  （`AuditService` 随之迁出，唯一消费方已进监听器）。
- **FEAT-07 接入形态确定**：出站 webhook = 在 event-subscriptions 新模块
  注册 `execution.completed`/`execution.failed` 监听器，主链零改动。
- **行为变化（有意接受）**：通知从"回调响应前同步完成"变为"回调响应时
  可能仍在途"（异步派发、进程内）。告警最终一致（fail-open + 审计兜底
  语义未变）；如需 at-least-once 投递保证，属于 FEAT-07 出站可靠性的
  范畴（outbox/重试），不在进程内总线层解决。
- 本轮刻意保留的直调（范围注记）：`task.processor.ts` isLastAttempt 分支
  的 AI 分析 + dispatch 失败通知（aiAnalysis 须先写回实体再随通知外发，
  拆监听器涉时序重排）；依赖扇出 `triggerDependentTasks`（与通知/AI 无
  耦合）；`suggestSchedule`/`analyzeExecution` 端点（请求驱动、同步返回
  结果给调用方，非副作用）。KILLED 终态（kill/sweep 写入）暂未 emit，
  载荷类型与总线就绪，接入是纯增量。
- 顺带闭合 OBS-02 遗留：notification 模块 `forFeature([Task])` 补注册，
  `AlertsController` 的 `taskRepo` 注入此前只在 mock 装配的 spec 里成立，
  真实模块图上缺 provider（单测掩盖，ADR-008 形态再现）。

## 被否方案

- `@nestjs/event-emitter` / 内置 EventEmitterModule：为单一解耦点引入
  框架级依赖与 `@OnEvent` 字符串装饰器（事件名失控风险），收益不足。
- BullMQ 队列外置事件总线：进程内消费方（通知）不需要持久队列语义，
  出站可靠性留给 FEAT-07 的 outbox 决策。
- 事件带全量实体（把 Task 行塞 payload）：payload 膨胀且 common 层反向
  依赖实体类型，改回"按 id 回查"与迁移前查询语义逐字等价。
