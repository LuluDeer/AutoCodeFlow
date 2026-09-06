# ADR-009: S3 日志驱动的跨存储一致性边界

状态：Accepted（BUG-06 修复后更新）

## 背景

LOG_STORAGE_DRIVER=s3：每次执行一个 gzip 对象，DB 只留指针；读取按 exec.logStorage 分流；S3 失败回退 DB 行。

## 决策

1. 顺序固定 **S3-put → DB-delete/写指针**（反向会有悬空指针）；
2. 跨存储不共享事务——失败窗口是有意接受的边界；
3. **回退必须自洽（BUG-06）**：put 失败时把「截至本页的全量内容」写 DB（append 场景并入 S3 上既有内容、行号归零），事务成功后把 exec 行指针收回 `logStorage='db'/key=null`——否则 replace 态读到 STALE 对象、append 态产出孤儿行；
4. 残留旧 S3 对象视为惰性垃圾：键按 executionId 确定性复用，后续成功写覆盖。

## 后果

- 读取面任何时刻都自洽（DB 态或 S3 态二选一，无混合视图）；
- 惰性垃圾量 = 失败次数 × 单执行日志大小，可接受且无需后台清扫。
