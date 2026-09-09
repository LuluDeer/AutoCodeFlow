# ADR-010: 去重窗口语义——TTL 即窗口

状态：Accepted（R4-P0 / N6 演进）

## 背景

触发去重锁曾被 watchdog 无限续期 → 每任务每进程生命周期只触发一次（R4-P0）；修后 TTL 又取 max(timeout, interval) → 15s 任务被压成 300s 周期（N6）。

## 决策

1. 触发锁 `renew:false`——**TTL 本身就是跨实例去重窗口**，永不续期、永不释放（release 无意义）；
2. 窗口 = 触发周期 − 500ms（`TRIGGER_DEDUP_JITTER_BUFFER_MS`，claim 窗口同源推导）；fixed_rate 的 acquire 相位滞后 δ 是 N6 抖动根因；
3. DB claim 的 windowStart 与锁 TTL 同源，两层防线共享同一窗口语义。

## 后果

- 真机：15s 任务 gap 均值 15.000s 零抖动。
- 任何"给触发锁加续期"的新想法都是回归（redis-lock.service 的注释已把本 ADR 钉在 acquireLock 的 renew 选项上）。
