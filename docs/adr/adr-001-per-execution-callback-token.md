# ADR-001: per-execution 回调 token

状态：Accepted（第八轮 N23 根治，round-8）

## 背景

任务代码（glue/SDK）需要回调执行结果，但共享 token（SEC-01）不能透传给任务子进程——任何拿到共享 token 的代码等价于该执行器本体。早期方案 N23 前回调对任务代码不可用，SDK 只能落盘由执行器代发。

## 决策

每次派发铸造一次性回调 token：`v1.<executionId>.<exp>.<hmac>`。
- HMAC key = 执行器当前 tokenHash 字符串（N26：bcrypt 矛盾的解法——hash 本身作为对称密钥，双端注册/心跳采纳三点同步）；
- 域分离：HMAC(secret, 固定域 || executionId || exp)，TTL = 任务超时 + 900s；
- token 精确绑定一个 executionId（逐 item 校验 address↔executionId），fail-closed；
- 双端（TS→TS→Py 三方）用同一测试向量钉死算法，任何一端单方面改动即刻三方同红。

## 后果

- 任务代码回调零凭据面扩大；泄漏的 token 出了 TTL/绑定域即废纸。
- 代价：tokenHash 语义从"凭据哈希"扩展为"HMAC 源密钥"，rotate-token 链路的任何改动必须同步三端向量（第八轮 P1 稳态击穿即源于此链）。

## 替代方案（被否）

- 长期任务级 token：凭据面大、轮换语义复杂；
- 回调经执行器代理：任务代码与执行器解耦诉求被破坏（SDK 直连 admin 的设计前提）。
