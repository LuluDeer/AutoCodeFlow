# 安全红线路径回归清单（QA-09）

> 目的：把十五轮安全审计（R1-R19 / S1-S16 / DR-01~07 / W1-W8 / SEC-01）修掉的每一条"红线路径"固化为**可执行的回归检查**——防止后续重构把同一类口子重新打开。
> 用法：① 触碰下列任一区域时，PR 必须附对应行的回归证据（测试名或真机断言）；② 每次安全专项复审以本清单为底册核对。
> 姿态基线：fail-closed 优先；错误响应不区分原因（防枚举）；凭据绝不落日志/透传子进程/进入 URL query（install.sh artifact 除外——该例外有显式标注）。

## 一、认证与凭据

| # | 红线路径 | 回归锚点 |
|---|---|---|
| A-1 | 共享 token 不进任务子进程 env（SEC-01 白名单，node/py 双侧） | env-whitelist.spec（node）/ env 白名单测试（py） |
| A-2 | per-execution 回调 token 绑定单一 executionId + TTL，逐 item 校验 address 一致 | execution-callback.controller.spec + 三方 HMAC 测试向量 |
| A-3 | token 轮换三点采纳（register/token/heartbeat 回传 tokenHash）且幂等签发不轮换 | executor.service.spec（N4/R9/R11）；BUG-01 双文案与 retry 指标（dc82ac7） |
| A-4 | install-cmd / install.sh 不再暴露共享凭据（DR-01 修复面），参数注入校验（N15 六注入零落盘） | install 相关 spec + install.sh 漂移守卫 |
| A-5 | 登录枚举时序拉平（dummy bcrypt compare）+ 登录限流独立阈值 | auth spec；W-22 装饰器 env 死配置教训（main.ts 预载 .env） |
| A-6 | refresh token 消费原子化（DR-07）+ logout 吊销（SEC-02） | auth.service spec |
| A-7 | 客户端包凭据链：CLI 刷新自愈失败清凭据、MCP env 注入、双 SDK disabled 语义（SEC-01 复审） | acf-cli client.test / mcp-server api.test / sdk 测试 |

## 二、授权（RBAC）

| # | 红线路径 | 回归锚点 |
|---|---|---|
| B-1 | 全局 RolesGuard + 机器端点（@Public）空 @Roles() 覆盖的语义不破 | roles-guard 相关 spec |
| B-2 | 执行器写面（update/reload-config/rotate-token/set-offline/delete）ADMIN-only（W2） | executor.controller.rbac.spec（401/403/2xx 矩阵） |
| B-3 | config 写面 / notification+ai config / audit / executor-packages 收紧 ADMIN（N11/R 系） | 各 controller spec；config.controller.rbac.spec |
| B-4 | 应用/部署全链 @Roles(ADMIN) + env 读面全链脱敏（deployment.env/relations/snapshot.env 三处绕过闭合） | application 相关 spec |
| B-5 | /uploads 静态面强制鉴权（JWT 或共享 token），公开前缀白名单为空 | ARCH-002 spec |
| B-6 | SSE query token 仅 /logs/stream 路径接受且强制 type=access | N7/N22 spec |
| B-7 | 前端门控与后端收紧同批（ADR-006）：admin 视角与非 admin 视角 Playwright 均有断言 | e2e 角色例（RBAC/降级） |

## 三、注入与输入面

| # | 红线路径 | 回归锚点 |
|---|---|---|
| C-1 | shell entrypoint 白名单+位置参数（python/node 双侧对齐，round-4 P0） | entrypoint 注入 spec |
| C-2 | heartbeat/register 白名单构造 payload（tokenHash/status/runningTaskCount 不可注入，F-7） | register 列注入 spec |
| C-3 | gitRepo URL 校验（scheme 白名单 + 受限地址拒绝，R5/R16）+ clone 分支语义（S12） | assertSafeGitRepoUrl spec |
| C-4 | Windows zip 条目校验 + 通用 zip-bomb 防护方向（S6） | windows 校验 spec |
| C-5 | 上传：diskStorage+流式哈希+500MB 上限+孤儿清理+Content-Disposition 消毒（R9/QA9/QA10/S10/S11） | 上传链 spec |
| C-6 | PyPI 上传 50MB 上限 + sidecar 哈希 + os.link 原子防重（N18/N30/N21） | registry-pypi 52 用例 |
| C-7 | 账号过期锁原子重置、PID @IsInt 等运行态校验 | R 系列 spec |

## 四、SSRF / 出站面

| # | 红线路径 | 回归锚点 |
|---|---|---|
| D-1 | 六出站点全部过 guard：dispatch/broadcast/reload-config/push + 三通知渠道 | assertSafeExecutorUrl spec |
| D-2 | IPv4-mapped IPv6（::ffff:）归一（N25）；deny 段含 198.18/15、100.64/10（V3）；maxRedirects:0 | url-guard 矩阵 |
| D-3 | 包下载跨主机重定向剥离凭据（eadedca） | 下载器 spec |
| D-4 | webhook 渠道 config-first/显式参数优先级钉死 + URL query 脱敏 | webhook 优先级 spec |

## 五、可靠性地带（安全外溢面）

| # | 红线路径 | 回归锚点 |
|---|---|---|
| E-1 | KILLED 终态不被回调覆盖（R-P0-007 条件 UPDATE） | handleCallback spec |
| E-2 | 回调分片 ≤100 + .meta 重试 + dead-letter 终态（node/py 双侧） | callback 分片/死信 spec |
| E-3 | COVER_EARLY 条件 UPDATE + RETURNING 防双释放（R4-P1） | blockStrategy spec |
| E-4 | 停机链：树杀 → worker flush（BUG-09）→ 回调 drain；node 同 commit bundle（ADR-005） | lifespan 顺序测试 + bundle drift 守卫 |
| E-5 | S3 回退自洽：replace 指针收回 / append 全量并入（BUG-06，ADR-009） | task-service-s3 集成测试 |
| E-6 | 崩溃型 RUNNING：预算判定 → kill best-effort → re-enqueue（STALE_RECOVERY_RETRY_ENABLED） | scheduler.service.spec |

## 六、观测与取证

| # | 红线路径 | 回归锚点 |
|---|---|---|
| F-1 | 401 七分类 + 回调业务结果 + 投递结果 + SSE 拒绝计数（观测即验证产物，ADR-008） | metrics render spec |
| F-2 | 触发延迟直方图（CORE-06）：bucket/sum/count series | scheduler-metrics-latency.spec |
| F-3 | 审计 CSV 注入消毒（S8）+ 400 化（S9 族）+ ParseIntPipe（S13） | audit spec |
| F-4 | 通知日志脱敏摘要（NOTIF-002）+ silences 上限（NOTIF-003/FEAT-01 持久化后仍限 1000） | notification spec |

## 七、待办缺口（复审中识别、尚未闭环）

- SEC-NEW-1：desktop executorToken 明文落盘 → safeStorage 加密（docs/SEC-01-复审报告.md F12-1）。
- registry-npm `someProp` 死键清理 + API JWT 60d 缩短评估（BUG-16 注记）。
- minio 链 3 moderate（上游未发版）——豁免归档，复查每轮 npm-audit job。
