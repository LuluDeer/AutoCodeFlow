# ADR-002: 调度器多实例双保险

状态：Accepted（第三轮 + 第五轮真机收敛）

## 背景

多实例 admin-api 下定时任务会被重复触发。单一防线各有失效态：Redis 锁在 Redis 不可用时整体失效；纯 DB claim 在时钟漂移/长事务下有窗口。

## 决策

双层防线叠加，任一生效即不重复：
1. **Leader Election**：Redis 锁 `scheduler:leader`，TTL 30s，watchdog TTL/3 续期 + TTL/2 校验，续期失败自动 demote；Redis 挂时 fail-open 降级（不停调度）。
2. **DB 条件 claim**：`claimTaskTrigger` 条件 UPDATE（`status=ACTIVE AND lastTriggerTime < now-window`），window = 去重 TTL（ADR-010）。

## 后果

- 真机验证（第五轮）：双实例 80 execution 零重复，kill Leader 35s 接管。
- fail-open 是有意取舍：Redis 故障降级为"单层防线"（DB claim 兜底）而非停摆。

## 替代方案（被否）

- ShedLock 类框架：引入新依赖，且其锁失效态不可控；
- 仅 DB claim：高频任务（15s）下 UPDATE 风暴。
