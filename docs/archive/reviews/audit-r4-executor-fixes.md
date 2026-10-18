# Audit R4 — 执行器全面修复留档

- 日期：2026-09-18
- 范围：《AutoCodeFlow 执行器深度审查报告》27 项（P1×5 / P2×9 / P3×13）+ 安全专项 S-1~S-3
- 涉及：`apps/executor-python`（顶层包，无 `src/` 子目录）、`apps/executor-node`、`apps/executor-desktop`
- 状态：全部落地，三端验证全绿（见 §3）

---

## 1. 修复矩阵

### 维度 1：任务执行流程

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| 1-1 | P3 | `TaskWorker.process()` 递归 `setImmediate` 自调度改单飞 drain 循环（`queueMicrotask` + 队列空即停），消除高并发微任务堆积与内存累积 | executor-node `src/task-worker.ts` |
| 1-2 | P2 | Python 侧停机时排队任务补发终态 failed 回调，与 Node 侧逐字段同构（`status=failed`，无 failureReason），消除 admin 侧僵尸 RUNNING 行 | executor-python `main.py`（shutdown 路径调 `fail_prepare_stage_executions_on_shutdown`） |
| 1-3 | P3 | pull 预留槽位加抢占超时 `PULL_STALL_TIMEOUT_MS`（预留后超时未 accept 即释放；kill -9 崩溃路径由心跳/预留超时兜底） | executor-node `src/pull.ts` |

### 维度 2：Python 多版本管理

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| 2-1 | P3 | 3.7 离线预填目录命名规范写进 `.env.example`（含 `cpython-3.7.9-<uv平台三元组>-none/` 布局、20200822 tag 约束、未预填分因 `interpreter_unavailable` 说明） | executor-python `.env.example` |
| 2-2 | P3 | junction 去重加平台适配 `canonicalizeRealpathForPlatform`（Windows UNC/8.3 路径规范化），spec 补平台分支断言 | executor-node `src/interpreters.ts`（+ `interpreters.spec.ts`） |

### 维度 3：zip 安全

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| 3-1 | P3 | 理论攻击面（zip 硬链接），主流实现不携带硬链接语义；**保留不修**，风险已记录（见 §4） | — |
| 3-2 | P2 | 解压条目数上限 `maxEntries=10_000`（`ZIP_MAX_ENTRIES` 可调）两端落地，防恶意 zip 耗尽 inode | executor-python `zip_safety.py`；executor-node `zip-safety.ts` / `zip-guard.ts` |

### 维度 4：资源隔离

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| 4-1 | P1 | POSIX 任务内存上限 `task_memory_limit_mb=2048`（RLIMIT_AS，`preexec_fn` 施加于任务进程树）+ CPU 秒数/进程数上限（RLIMIT_NPROC），非 POSIX 平台明确降级并记日志 | executor-python `config.py` + 任务 spawn 路径 |
| 4-2 | P1 | Node 侧新增 `taskMemoryLimitMb` / `taskMemoryWatchdogIntervalMs` + `memory-watchdog.ts`：Linux `/proc` 进程树递归采样（含孙进程）、Windows `tasklist` CSV 直系子进程 best-effort；超限与 close/timeout 共用 settled 守卫，只杀一次 | executor-node `src/memory-watchdog.ts`（新增）+ `src/routes/execute.ts` + `config.ts` |
| 4-3 | P1 | 任务进程沙箱 `TASK_SANDBOX=bwrap`（`--die-with-parent --unshare-all --share-net` + 只读根 FS + PrivateTmp）：Linux 上 bwrap 缺失/用户命名空间被禁 → fail-closed；Windows 显式拒绝；网络出口**有意共享**（任务需联网装依赖），由 SSRF-guard（S-1）承担出口防御 | executor-node `src/routes/execute.ts`（+ config）；executor-python `sandbox.py`（+ `config.py`） |
| 4-4 | P3 | desktop spawn 子进程后设 `PriorityClass=BelowNormal`（best-effort，失败静默降级），避免抢占 UI 资源 | executor-desktop `src/main/executor-process.ts` |

### 维度 5：执行器注册与心跳

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| 5-1 | P3 | `_refresh_lock` 惰性创建改为 loop 感知（每次取锁时按当前 loop 获取/创建，不再绑定首次事件循环），消除测试多 loop 场景跨 loop 复用 | executor-python `auth.py` |
| 5-2 | P3 | Node `STATIC_TOKEN` 从模块加载时快照改为每次读取（与 Python `_get_static_token()` 每次读 env 对齐），热重载 token 即时生效 | executor-node `src/middleware/auth.ts` |

### 维度 6：三端对等性

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| 6-1 | P3 | desktop 子进程 stdout/stderr 走 `handleChildOutput`：JSON 日志行解析后广播 `executor:log-structured` 事件（结构化错误分类），文本行走原通道逐字节不变 | executor-desktop `src/main/executor-process.ts` |
| 6-2 | P2 | 诊断与运行时解析共享同一判定源：`UvResolutionInput` 增 `systemEnvUvBinUsable` / `pathProbe`，env 分支坏 `UV_BIN` 不再宣称已确认可用，path 分支 probe 命中升级 `uvStaticallyConfirmed`；ipc 注入探针（仅静态无解分支触发），selftest 补 6-2 对齐断言 | executor-desktop `src/main/uv-paths.ts` / `ipc-handlers.ts` + `uv-wiring.selftest.ts` |
| 6-3 | P3 | macOS `.app` bundle：白名单设计天然排除目录型扩展名（非白名单项即拒绝），`path-domain.ts` 补注释，selftest 增 `Executor.app` 断言 | executor-desktop `src/main/path-domain.ts`（+ `path-domain.selftest.ts`） |

### 维度 7：错误处理与失败分因

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| 7-1 | P3 | 两套重试语义显式注释区分（实时回调 5 次 vs 持久化回调 150 轮），防止维护者混淆 | executor-node `src/callback.ts` |
| 7-2 | P2 | `is_safe_execution_id()` 校验（白名单字符集），`_upload_one` 拼接 URL 前双端校验（execution_id + artifact name），纵深防御 | executor-python `artifacts.py` |

### 维度 8：日志与可观测性

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| 8-1 | P3 | trace context 注入：执行器内部日志携带 W3C traceparent（`AsyncLocalStorage` 贯穿任务处理链），回调回传头保留 | executor-node `src/logger.ts`（+ `callback.ts` 头部） |
| 8-2 | P3 | 日志游标 LRU 裁剪从 O(n) `Array.from+slice` 改 Map 插入序 while 淘汰（O(1) 摊销） | executor-desktop `src/main/ipc-handlers.ts` |
| 8-3 | P3 | `LOG_FORMAT=json`：单行 JSON（timestamp/level/logger/message，异常附栈），聚合平台可直接解析；默认文本格式不变 | executor-python `main.py` 日志配置 |

### 维度 9：并发与性能

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| 9-1 | P3 | 回调主循环从 1s 固定轮询改事件驱动：`pushCallback` 唤醒 flush，空闲回落长轮询 | executor-node `src/callback.ts` |
| 9-2 | P3 | 与 1-1 同源：单飞 drain 消除 setImmediate 递归深度累积（见 1-1） | executor-node `src/task-worker.ts` |
| 9-3 | P3 | venv→依赖映射指纹缓存（`_venv_deps_cache` + 目录指纹，venv 创建/销毁时失效），大池（100+ venv）回收不再每轮全量扫描 | executor-python `maintenance.py` |

### 安全专项

| 编号 | 严重度 | 修复内容 | 落点 |
|---|---|---|---|
| S-1 | P2 | DNS rebinding 防护：`assertSafeDnsResolution` 异步解析主机名（`dns.promises.lookup` all 记录），任一 A/AAAA 落在受限网段即拒绝；解析失败 fail-closed；字面 IP/localhost 不触发解析；`allowPrivateNetwork` 逃生阀跳过。spec 补 6 个 DNS 用例（混合公网/内网多记录、全公网放行、解析失败拒绝等） | executor-node `src/lib/ssrf-guard.ts` + `src/lib/download.ts`（+ `ssrf-guard.spec.ts`） |
| S-2 | P2 | token 加密严格模式：`encryptToken({ requireEncryption })`，Linux 无 keyring 时返回 null 而非明文；`EXECUTOR_REQUIRE_ENCRYPTED_TOKEN=1/true` 开启后配置保存遇加密不可用即跳过 token 写入（保留旧值 + error 日志），绝不降级明文；selftest 补严格模式 4 断言 | executor-desktop `src/main/token-crypto.ts` + `config-store.ts`（+ `token-crypto.selftest.ts`） |
| S-3 | P1 | dev mode allow-all 改 fail-closed：仅 `EXECUTOR_ALLOW_NO_TOKEN=true`（或 `config.allow_no_token=true`）显式开启时放行未认证请求；裸部署默认拒绝任意代码执行 | executor-python `auth.py`（+ `config.py`）；executor-node `middleware/auth.ts` 同源对等（`allowNoTokenDevMode`） |

---

## 2. 测试侧同步（存量 spec/实现漂移，非审计 27 项）

Python（O-24 共享连接池 / B-2 回调头改造后的对账）：
- `test_health.py`：`_check_admin_api` mock 目标从 `health_module.httpx.AsyncClient` 迁移到 `scheduler.get_http_client`（函数体内延迟导入，patch scheduler 生效）；readiness 用例补 `_resources_ok` mock，资源判定与宿主负载解耦（高负载 CI 机 psutil ≥90% 假 503）
- `test_re_register.py`：8 处 mock 目标迁移——main 相关 6 处打 `main_module.get_http_client`（模块级导入绑定），auth 相关 2 处打 `sched.get_http_client`（函数体内延迟导入）
- `test_traceparent.py` / `test_execute.py`：回调头断言补 `x-executor-address`（B-2 parity，admin 按执行器限流）

Node（已在上一轮验证中同步）：`callback.spec.ts`（B-2 头）、`admin-client.spec.ts`（O-23 共享实例重写）；新增 `memory-watchdog.spec.ts`（7 用例）、`ssrf-guard.spec.ts`（DNS 6 用例）、`task-worker.spec.ts` 单飞回归 2 用例。

---

## 3. 验证结果

| 端 | 命令 | 结果 |
|---|---|---|
| executor-python | `C:\Python314\python.exe -m pytest tests -q -o addopts="" --basetemp=<tmp>` | **866 passed / 3 skipped**（全量 30 文件，约 5.5 分钟） |
| executor-node | `npx tsc --noEmit` + `npx jest --silent` | **669 passed / 7 skipped / 31 suites** |
| executor-desktop | `npx tsc -p tsconfig.json --noEmit` + `npm run test:main` + `node src/renderer/renderer.selftest.mjs` | **8 selftest 全绿** + renderer selftest 通过（MODULE_TYPELESS_PACKAGE_JSON 警告无碍） |

> 注意：executor-python 代码位于 `apps/executor-python/` 顶层（无 `src/` 子目录）；此前"src 与 HEAD 零差异"系路径误判，实际改动均在 git 工作区。

---

## 4. 残余缺口（如实披露）

1. **1-3 pull 预留 kill -9 泄漏**：进程被强杀时 `finally` 无法执行，预留槽位释放依赖心跳超时兜底（`PULL_STALL_TIMEOUT_MS`）。属不可完全消除的崩溃语义，已文档化。
2. **2-2 UNC 路径**：`canonicalizeRealpathForPlatform` 已做平台适配并有 spec，但本环境无 Windows CI，真实 UNC 场景未机器验证。
3. **3-1 zip 硬链接**：理论攻击面，主流 zip 实现不表达硬链接；未实现 inode 校验（保留）。条目数上限（3-2）已两端落地。
4. **4-3 网络出口**：bwrap 使用 `--share-net`——任务需联网安装依赖/拉取包，全网络隔离会破坏合法任务。出口防御由 S-1 SSRF-guard（含 DNS rebinding 校验）承担；生产容器建议叠加 docker 网络策略。
5. **S-2 Linux keyring**：严格模式默认关闭（显式 `EXECUTOR_REQUIRE_ENCRYPTED_TOKEN=1` 开启）。默认仍允许无 keyring 环境降级（避免破坏合法无桌面部署），缺口与开启方式已写入 config 文档。
6. **4-4/6-1 desktop**：子进程优先级与 JSON 日志解析为 best-effort，Windows 权限不足时静默降级。

---

## 5. 复验方式

三端验证命令见 §3 表格；Python 侧必须使用 `C:\Python314\python.exe`（默认解释器无 pytest）并携带 `-o addopts=""`（覆盖 pytest.ini 内置 --cov，当前解释器缺 pytest-cov）与系统临时目录 `--basetemp`。
