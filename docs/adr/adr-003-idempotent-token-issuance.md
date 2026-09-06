# ADR-003: per-executor token 幂等签发

状态：Accepted（N4/R8-R11 演进，rotate-on-push 已废）

## 背景

早期 /executors/token 每次调用轮换 token：fetchToken 失败重试 → 旋转风暴（真机 9 分钟 14 次旋转）→ 依赖 tokenHash 的回调 HMAC 全线 401 → 更多失败。稳态循环是幂等性破坏的放大器。

## 决策

`issueToken` 按 (address, startupId) 幂等：同进程生命周期的重复请求返回**当前** token（内存缓存明文，有界 1000/24h）；仅首轮签发/真实重启/legacy 无 startupId 时轮换。注册端点同语义（同 startupId 重复注册返回 perExecutorToken=null）。

## 后果

- 旋转窗口从"最坏 30min"收敛到一次往返（executor 401 自愈 + rotateToken 播种缓存）。
- 代价：admin 重启后缓存冷 → 首次 push 401 一次（N51，已知边界，executor 一个心跳内自愈）；reload-config 已带单次重签重试。
- 已知残界：回退重试救不了轮换场景（N50，check-then-act 无锁），收敛依赖 executor 侧自愈。

## 替代方案（被否）

- token 明文落库：DB 备份即泄密（SEC-02 方向，另行立项）；
- 每次轮换 + 全量通知：通知丢失即全 fleet 掉线。
