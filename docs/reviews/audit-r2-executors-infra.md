# 执行器与基础设施深度审查（2026-09-14 @ 0ef3bbe）

- 审查对象：`apps/executor-node`、`apps/executor-python`、`apps/registry-npm`、`apps/registry-pypi`、`.github/workflows/`（ci.yml / release.yml / release-please.yml / docs-site-deploy.yml）、根级与 infra 的 compose、全部部署/运维脚本（deploy.sh / dev.sh / start-dev.sh / init-db.sh / Makefile / scripts/*.sh、scripts/*.mjs 结构面）、测试基建（playwright.e2e.config.js、根级 e2e spec、pytest 配置）
- 基线：分支 `develop`，HEAD `0ef3bbe`，工作区干净（唯一新增为本文档）
- 审查方式：逐文件人工通读 + 系统性 grep；所有结论附 `文件:行号` 与代码摘录；未运行 install/build/test，未修改任何现有文件
- 与既有评审的关系：已通读 `docs/reviews/audit-r1-backend.md`（R-01~R-30）与 `docs/reviews/audit-r1-frontend.md`（F-01~F-38）避免重复。本报告发现全部独立取证；涉及 admin-api 侧行为（如 429 处理、stale sweep）仅作对照引用，不在本报告展开。

---

## 一、全景与方法

### 1.1 代码规模

| 范围 | 规模 |
|---|---|
| executor-node 源码（非 spec，TS） | 30 文件 / 5,752 行；spec 22 文件 / 5,918 行（源码:测试 ≈ 1:1） |
| executor-python 源码（非 tests） | 14 文件 / 3,754 行；tests 16 文件 / 5,826 行（243 个 test 函数） |
| registry-npm | config.yaml 46 行 + README（verdaccio 成品镜像，非自研） |
| registry-pypi | main.py 438 行 + tests 731 行（41 个 test） |
| CI 工作流 | ci.yml 1,010 行（24 个 job）、release.yml 199 行、release-please.yml 84 行、docs-site-deploy.yml 66 行 |
| 部署/脚本 | docker-compose.yml 420 行、docker-compose.ha.yml 38 行、infra/docker-compose.yml + nginx、根级 4 个 .sh + Makefile、scripts/ 下 6 个 .sh + 28 个 .mjs（10,446 行） |
| 测试基建 | playwright.e2e.config.js + 根级 e2e-full.spec.js（101,636 字节，46 例）+ e2e-ui09-mobile.spec.js（2 例）；根 pytest.ini + apps/executor-python/pytest.ini |

### 1.2 实际通读清单（证据基础）

- **executor-node 全文**：main.ts、config.ts、middleware/auth.ts、scheduler.ts、task-worker.ts、routes/execute.ts（1,375 行全文）、routes/deploy.ts（631 行全文）、routes/config.ts、routes/health.ts、routes/logs.ts、routes/update-package.ts、callback.ts、admin-client.ts、admin-envelope.ts、admin-api-url.ts、pull.ts、file-logger.ts、artifacts.ts、zip-guard.ts、execution-callback-token.ts、env-whitelist.ts、run-command.ts、safe-path.ts、manifest.ts、startup-identity.ts、heartbeat-state.ts、logger.ts、lib/download.ts、Dockerfile、package.json、.env/.env.example
- **executor-python 全文**：main.py、auth.py、config.py、scheduler.py、admin_api.py、routers/execute.py（1,833 行全文）、routers/config.py、routers/health.py、routers/logs.py、maintenance.py、artifacts.py、execution_callback_token.py、manifest.py、startup_identity.py、Dockerfile、requirements*.txt、pytest.ini、.env.example、tests/conftest.py
- **registry 两个**：registry-npm/config.yaml + README；registry-pypi/main.py 全文 + Dockerfile + tests 目录用 grep 全列
- **CI 全文**：ci.yml 1,010 行逐段、release.yml、release-please.yml、docs-site-deploy.yml
- **部署/脚本**：docker-compose.yml 全文、docker-compose.ha.yml 全文、infra/docker-compose.yml + infra/nginx/default.conf 全文、deploy.sh、dev.sh、start-dev.sh、init-db.sh、Makefile、scripts/install.sh（263 行全文）、scripts/e2e-full.sh（352 行全文）、scripts/chaos-drill.sh（头注+纯函数区）、scripts/ci-local.sh（头注+参数区）、scripts/start-isolated.sh、scripts/stop-isolated.sh、scripts/bundle-executor-artifact.sh、scripts/load-test-stack.sh（尾部采样段）、scripts/ha-compose-selftest.mjs（结构）
- **测试基建**：playwright.e2e.config.js 全文、e2e-full.spec.js 46 个 test 标题全列、e2e-ui09-mobile.spec.js、两个 pytest.ini、conftest.py

### 1.3 系统性 grep 结果摘要

| 模式 | 结果 |
|---|---|
| `pull_request_target` | **0 处**（四个工作流均无，权限面干净） |
| `continue-on-error` | 1 处：ci.yml:539（python-packages-test 安装步骤）——见 E-14 |
| `secrets.*` | 仅 release.yml 的 NPM_TOKEN / PYPI_API_TOKEN + GITHUB_TOKEN，无明文密钥入工作流 |
| `TODO/FIXME/HACK` | executor 源码 0 条；scripts/ 仅 chaos-drill.sh 场景 D 的诚实 TODO 骨架（无 PG 从库可注入） |
| `shell=True` / `os.system` / `eval(` | python 侧 0 处（全部 argv 数组 spawn）；node 侧无 eval/new Function；node `shell: true` 仅 win32 npm/git 路径（见 E-26） |
| `0.0.0.0` | registry-npm config.yaml:45（容器内监听，compose 已用 127.0.0.1 映射收敛）、executor-python main.py:312（uvicorn 直绑全接口）、registry-pypi Dockerfile CMD——执行器裸机路径暴露面见 E-11/E-04 |
| compose 明文/默认口令 | `INITIAL_ADMIN_PASSWORD: -Admin@123456`（docker-compose.yml:131）、registry-pypi 代码内默认 `autoflow/autoflow123`（main.py:42-43）——见 E-03/E-10 |
| `set -` 纪律 | scripts/ 下 6 个新脚本全部 `set -euo pipefail`；根级 5 个脚本仅 `set -e`（见 E-36） |
| 死代码/双拷贝 | install.sh ↔ install-script.content.ts 双拷贝（有运行时守卫，见 E-38）；compose `PYPI_API_KEY` 注入但 main.py 从未读取（E-36） |
| 自检脚本 vs CI | `test:arch31-*` / `test:pull-dispatch` / `test:qa05-callback-tier` / `test:oidc-sso` / `test:nginx-sse` / `test:ha-compose` / `test:registry-npm` 共 **8 个行为自检脚本不在任何 workflow 中运行**（ci.yml 仅 check-migrations + bug18 --dry-run）——见 E-13 |

### 1.4 总体评价

两侧执行器的工程质量显著高于同类项目平均线：env 白名单+secret denylist、per-execution HMAC 回调 token、zip 炸弹/路径穿越双重闸、BoundedLogBuffer/有界内存、磁盘 TTL 回收、pull 模式、token 轮换自愈（R9/R10/R11）等，且 node/python 双端做到了罕见的逐条 parity（大量 ADR 级注释对照）。CI 门禁也相当完备（concurrency、timeout、gitleaks、lockfile 完整性、api-types-drift、windows 矩阵）。

因此本轮发现集中在**双端 parity 的残余裂缝**（timeout=0 语义、readiness 端点、清理保护单侧缺失）、**异常路径的时间窗**（pull 容量竞态、停机窗口接新任务、回调死信过快、artifact 上传无超时）与**部署面的加固不均衡**（compose 管住了容器，裸机 install.sh 与 registry-pypi 掉队）。

---

## 二、发现清单

> 分级：P0=数据损坏/核心功能损坏（本轮无）；P1=任务丢失/权限边界失效；P2=特定条件下的正确性/安全/可靠性问题；P3=打磨项。
> 每条含：编号、类别、位置、证据（≤5 行）、影响、修法、工作量（S<0.5d / M<2d / L>2d）。
> 类别标注（node/py/infra/ci）指问题归属侧；"双端"表示两侧同源问题。

### 【P1】

#### E-01【Bug/py+node】pull 派发的容量竞态把「暂时没槽位」变成「任务永久失败」

- **位置**：`apps/executor-node/src/pull.ts:41-59`；`apps/executor-python/routers/execute.py:740-741` + `apps/executor-python/scheduler.py:240-244`
- **证据**：
  ```ts
  // pull.ts：先检查有空槽才去 pull，但 admin 领取后 acceptExecution 可能已 429
  const accepted = acceptExecution(body as ExecuteRequest, traceparent);
  if (accepted.status !== 200) {
    // 领取被拒（容量竞态/校验失败）：补发 failed 回调，admin 侧不留僵尸 RUNNING 行
    pushCallback({ executionId: task.executionId, status: 'failed', ... });
  ```
  ```python
  # execute.py:740 —— 领取核心对 429 的处理是同一个失败回调分支
  if sched.get_running_count() >= settings.max_concurrent_tasks:
      raise ExecutionRejected(429, 'Executor is at capacity')
  ```
- **影响**：pull 循环的空槽检查与 admin 队列领取之间存在窗口（admin 端长轮询取出即出队）；期间一个 push 派发占走最后一个槽位，被拉取的执行就被 429 拒绝并**补发 failed 回调**——admin 把执行记为失败，任务不会重试。容量竞态是纯瞬时状态，却产生与「校验失败」同级的永久终态。同任务高峰期（pull 模式多执行器并发取件）必然出现。
- **修法**：把「429 容量不足」与「400 校验失败」在 pull 路径分流——前者不回调失败，改为 admin 侧 requeue（或在 pull 响应中让 admin 保留任务 / executor 领取前先原子预占槽位）。node/python 同改，并补一条 pull-dispatch-selftest 用例固化。
- **工作量**：M

#### E-02【Bug/双端】`timeout=0`（不限时）语义两侧不一致：node 无限跑、python 按 300s 默认值杀

- **类别**：Bug（协议不一致，任务提示中明确要求排查「同一字段两种语义」）
- **位置**：`apps/executor-node/src/routes/execute.ts:394-399,641-648,897-899`；`apps/executor-python/routers/execute.py:1549-1552`
- **证据**：
  ```ts
  // node：0 = 不限时是显式语义（改动4），仅 null/undefined 才回退默认
  const timeout = rawTimeout === 0 ? 0 : (rawTimeout as number) || config.taskTimeoutSeconds;
  ...
  const TOKEN_TTL_UNBOUNDED_SECONDS = 315_360_000; // timeout=0 → 10 年 token
  ```
  ```python
  # python：or-链里 0 是 falsy —— timeout=0 被当成「未提供」，回落 300s 默认
  timeout = _clamp_timeout_seconds(
      task.get('timeoutSeconds') or task.get('timeout_seconds') or task.get('timeout') or settings.task_timeout_seconds,
      settings.task_timeout_seconds,
  )
  ```
- **影响**：同一份任务定义（admin 侧语义 timeout=0 = 不限时）派到 node 执行器可无限运行（回调 token 也给了 10 年 TTL），派到 python 执行器 300 秒后被杀。同类任务在混合执行器集群中结果由「谁接到」决定，且 python 侧的失败原因会被归类为 timeout，与真实业务语义不符。另注：负值/越界在 node 是 400 拒绝，python 是 clamp 到 1s 立即杀（`_clamp_timeout_seconds`），同一字段第三种语义。
- **修法**：python 侧显式处理 `0`（`raw is 0/int(raw)==0 → 不限时 + token 用 10 年上限`），并拉齐越界策略（建议两侧都 400 拒绝而非 clamp）；在两侧 spec 各加一条 `timeout=0` 向量互相 pin。
- **工作量**：S

#### E-03【安全/infra】admin-api 宿主端口绑 0.0.0.0 + 初始管理员默认弱口令，新部署可被直接接管

- **位置**：`docker-compose.yml:105-106,131`
- **证据**：
  ```yaml
  admin-api:
    ports:
      - '3105:3105'                      # 未加 127.0.0.1 前缀 → 0.0.0.0
  ...
      INITIAL_ADMIN_PASSWORD: ${INITIAL_ADMIN_PASSWORD:-Admin@123456}
  ```
- **影响**：与本项目给执行器/registry 统一施加的 S9「loopback-only 宿主映射」纪律相反，admin-api 的 3105 直接暴露在所有网卡。首次 `docker compose up -d` 且未填 `INITIAL_ADMIN_PASSWORD` 时（compose 缺省生效），任何能路由到该主机的人可用 `admin@autoflow.local / Admin@123456` 登录管理台、创建任务（= 在执行器上任意执行代码）、读取 secrets。执行器回程走的是 compose 内网 `http://admin-api:3105`，宿主映射对拓扑并非必需。
- **修法**：`ports: ['127.0.0.1:3105:3105']`（与 executor/registry 一致）；初始口令去掉 compose 缺省值（`${INITIAL_ADMIN_PASSWORD:?set in .env}` 强制注入），或在 UsersService seed 时拒绝弱口令清单。
- **工作量**：S

#### E-04【安全/py+node】SSRF 闸三处缺口：deploy/update-package 无私网拦截，且下载链对首跳附带执行器共享密钥

- **位置**：`apps/executor-node/src/routes/deploy.ts:250-260,433-435`；`apps/executor-node/src/routes/update-package.ts:69-79`；`apps/executor-node/src/lib/download.ts:107-110`；对照 `apps/executor-node/src/routes/execute.ts:372-376`
- **证据**：
  ```ts
  // download.ts：sendAuth 默认 true —— EXECUTOR_SECRET 作为 Bearer 发往任意首跳
  if (sendAuth && config.token) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }
  // deploy.ts validatePackageUrl：只校验 scheme，无私网/元数据拦截（execute.ts 有）
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { ... }
  ```
  ```ts
  // execute.ts 的 S7 守卫（deploy/update-package 没有同款）：
  const privateIpPattern = /(?:10\.\d{1,3}...|192\.168\...|localhost|127\...)/i;
  ```
- **影响**：三处纵深缺口——(1) `packageUrl`/`downloadUrl` 可指向 `169.254.169.254`（云元数据）、内网 RFC1918 或十进制编码 IP，execute.ts 的守卫管不到 deploy/update-package（同一执行器上的两条下载链）；(2) 下载请求对首跳无条件附带执行器共享 token，诱导/误配置的 URL 即把凭据送到任意外部主机（跨跳已剥离，首跳没有）；(3) execute.ts 自身的私网正则也缺 `169.254.0.0/16`、IPv6 与非点分 IP 形态。触发前提是 admin 侧权限（packageUrl 由 admin 下发），故定 P2 纵深而非 P1；但与「python 侧 SSRF 有 ADR、node deploy 面裸奔」的不一致值得立即收敛。
- **修法**：把 execute.ts 的私网/loopback 校验抽为共享 util（含 169.254/IPv6/十进制形态），deploy/update-package/download 三处接入（复用 `EXECUTOR_ALLOW_PRIVATE_NETWORK` 开关语义）；download.ts 增加可选 `authHosts` 白名单，仅对 admin-api 本机地址附带 Bearer。
- **工作量**：M

### 【P2】

#### E-05【可靠性/双端】回调落盘重试 5 轮即死信：admin 中断约 1~2 分钟，任务终态结果全部转入手工重放

- **位置**：`apps/executor-node/src/callback.ts:74-76,203-253,286-303`；`apps/executor-python/routers/execute.py:884-893,1109-1124`
- **证据**：
  ```ts
  // node：每轮回调间隔仅 1s（processCallbacks 主循环 callbackDelay(1000)），
  // 每轮失败 retries+1，5 轮后 dead-letter
  const CALLBACK_FILE_MAX_RETRIES = 5;
  ...
  const next = retries + 1;
  if (next >= CALLBACK_FILE_MAX_RETRIES) { deadLetterCallbackFile(...); }
  ```
  ```python
  # python：有指数退避（base*2**retries, cap 60s），但同样 5 轮耗尽
  CALLBACK_FILE_MAX_RETRIES = 5
  CALLBACK_REPLAY_BACKOFF_MAX_SECONDS = 60.0
  ```
- **影响**：node 侧一轮 ≈ 1s+10s 超时，5 轮 ≈ 1 分钟；python 侧 1+2+4+8+16 ≈ 2 分钟。admin-api 滚动升级、网络抖动或 30s 级重启足以让**这期间完成的全部任务终态**（含 logs/exitCode/artifacts 清单）进入 dead-letter，admin 只能靠 stale sweep 把执行标成 executor_offline——真实失败原因/产物丢失，恢复需人工重放文件。死信机制本意是防毒丸文件，现被瞬时故障触发。
- **修法**：把「重试轮数」与「重试时长」解耦：轮数上限提高（如 60）并配合更陡的指数退避（cap 5~10min），或按 `persistedAt` 设 TTL（如 24h）+ 轮数上限只拦毒丸；心跳已上报 deadLetterCount，可再接 admin 侧主动 replay 端点（见架构建议 A3）。
- **工作量**：S

#### E-06【可靠性/node】artifacts 上传无任何超时：admin 挂起时终态回调被无限阻塞、容量槽被永久占用

- **位置**：`apps/executor-node/src/artifacts.ts:104-119`（对照 python `apps/executor-python/artifacts.py:162` 有 `timeout=30`）
- **证据**：
  ```ts
  const resp = await fetch(url, { method: 'PUT', headers, body: form });  // 无 AbortSignal/timeout
  ...
  artifacts: await collectTerminalArtifacts(executionId, workDir),  // runTask 成功路径 await 之
  ```
- **影响**：node 侧 100MB 产物走无超时 fetch；admin-api/网络半开（TCP 黑洞）时 `collectTerminalArtifacts` 永不返回 → `runTask` 不推终态回调 → `entry.release()` 永不执行 → 该并发槽被永久占用，累计几次即把执行器打成 429 拒单。python 侧已有 30s 超时，属 parity 缺口。
- **修法**：`AbortSignal.timeout(60_000)`（或配置化）+ 分块/流式上传替代 `fs.readFileSync` 整文件入内存；补一条超时单测。
- **工作量**：S

#### E-07【可靠性/双端】优雅停机不停止 pull 循环：排水窗口内仍接新任务，随后被树杀

- **位置**：`apps/executor-node/src/main.ts:265-268,150-203`；`apps/executor-python/main.py:101-103,113-117`
- **证据**：
  ```ts
  // node：startPullLoop() 返回的 interval 被丢弃，gracefulShutdown 无从清除
  if (config.pullMode) {
    startPullLoop();                      // ← 返回值未接
    ...
  }
  ```
  ```python
  # python：_pull_task 在 lifespan 内创建，shutdown 段只 cancel _heartbeat_task
  if settings.executor_pull_mode:
      _pull_task = asyncio.create_task(pull_task())
  ...
  yield
  _heartbeat_task.cancel()                 # ← pull task 未取消
  ```
- **影响**：SIGTERM 后的排水窗口（node 最长 30s + 回调 drain）内 pull 循环仍在领件并 accept——新任务刚被 admin 标记 RUNNING 就被随后的 `killRunningTaskProcesses` 树杀，或更糟：在 grace 计时之后才开始跑、被 `process.exit` 遗留为孤儿。与「停机前先停入口」的既有设计（node `server.close()` 关 push 入站）不对称。
- **修法**：node 保存 interval 并在 `gracefulShutdown` 首步 `clearInterval`（改名 `stopPullLoop`）；python 在 `yield` 后第一步 `_pull_task.cancel()` 并 await。补一条停机不再 accept 的单测。
- **工作量**：S

#### E-08【可靠性/node】工作目录 TTL 清理无活跃执行保护：timeout=0 长跑任务的工作目录可被整体删除（python 侧有保护）

- **位置**：`apps/executor-node/src/file-logger.ts:292-302`（对照 `apps/executor-python/maintenance.py:63-82,175-179` 的 `_live_workdir_names` 保护）
- **证据**：
  ```ts
  // node：只按 mtime 判 TTL，不查 liveExecutions —— 清理与执行互不知晓
  const baseEntries = fs.readdirSync(config.workDir, { withFileTypes: true });
  for (const entry of baseEntries) {
    if (PROTECTED_WORKDIR_NAMES.has(entry.name)) continue;
    ... if (stat.mtimeMs < cutoff) { if (removePath(full)) workDirs++; }
  ```
  ```python
  # python 同功能的实现明确带保护（fail-safe）：
  if live_names is None:
      # liveness unknown — fail safe, delete nothing
      return counts
  ...
  if entry.name in live_names: continue
  ```
- **影响**：node 上 `timeout=0`（不限时）或超长任务（日志写到别处、工作目录 7 天无 mtime 更新）在清理扫描（启动时即跑一次，此后每 6h）中被 `rmSync -r` 连根删掉——运行中的任务输入/产物目录消失，任务要么读文件失败要么把输出写进已删除路径。python 侧同一功能有 liveness 保护，属 node 侧 parity 回退。
- **修法**：node `cleanupWorkDir` 注入与 `listActiveExecutionIds()`（execute.ts 已导出）联动跳过活跃 executionId 目录（并跳过其 taskId 对应的 `.node_modules/<taskId>`），与 python `register_live_entries_provider` 同构。
- **工作量**：S

#### E-09【安全/infra】一键安装脚本以 root 运行执行器且无任何 systemd 加固——裸机路径与容器姿态脱节

- **位置**：`scripts/install.sh:209-231`（admin-api 下发的 `install-script.content.ts` 同）
- **证据**：
  ```bash
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
  [Service]
  Type=simple
  WorkingDirectory=${INSTALL_DIR}
  EnvironmentFile=${INSTALL_DIR}/.env
  ExecStart=${EXEC_CMD}
  Restart=always
  ```
- **影响**：`curl .../install.sh | bash` 是文档化的标准装机路径，产出的 unit 无 `User=`/`NoNewPrivileges`/`ProtectSystem`/`PrivateTmp`——代码执行服务（/api/execute 即 RCE 面，暴露面见 E-25）以 root 常驻。容器内同样的服务已是 non-root + cap_drop ALL + no-new-privileges（compose SEC-07），两条部署路径的安全基线不一致。
- **修法**：unit 增加 `User=`（新建专用用户）、`NoNewPrivileges=true`、`ProtectSystem=strict` + `ReadWritePaths=$WORK_DIR $INSTALL_DIR`、`PrivateTmp=true`；`.env` 追加 `REQUIRE_TOKEN=true`（当前 install.sh 生成的 .env 没写该键，裸机一旦 token 缺失即回到 dev-mode allow-all）。
- **工作量**：S

#### E-10【安全/infra】registry-pypi 默认弱口令 fail-open、容器以 root 运行、无 compose 加固

- **位置**：`apps/registry-pypi/main.py:42-52`；`apps/registry-pypi/Dockerfile`（全文无 USER）；`docker-compose.yml:327-356`
- **证据**：
  ```python
  REGISTRY_USER = os.getenv("REGISTRY_USER", "autoflow")
  REGISTRY_PASS = os.getenv("REGISTRY_PASS", "autoflow123")
  # Warn (don't exit) when using default credentials so dev environment still works
  ```
- **影响**：三连：直接 `docker run` 镜像（不经 compose）时弱口令只 warn 不拒启，而该服务管着「任务依赖的包来源」（投毒 = 污染全部任务）；镜像以 root 运行且 compose 未对其施加 cap_drop/no-new-privileges（与 executor 的 SEC-07 待遇不同）；Basic 凭据全程明文 HTTP（内网可接受，但至少应文档化 + 默认拒启）。compose 部署因 `REGISTRY_PASS` 无缺省值而被迫注入，风险集中在裸镜像使用面。
- **修法**：REGISTRY_PASS 取默认值时 `sys.exit(1)`（提供 `ALLOW_DEFAULT_CREDS=1` 逃生阀）；Dockerfile 增加 non-root USER（与 executor-pypi 的 Q-08 做法一致）；compose 补 cap_drop。
- **工作量**：S

#### E-11【可靠性/py】token 刷新无失败退避：admin 不可达时每个入站 /api 请求都被 10s 超时拖住（node 有 30s 退避）

- **位置**：`apps/executor-python/auth.py:188-198,275-286`（对照 node `middleware/auth.ts:24-25,120-129` 的 `TOKEN_FETCH_BACKOFF_MS = 30_000`）
- **证据**：
  ```python
  async def _refresh_token_if_needed() -> None:
      # ...failed fetch leaves the schedule untouched and the next call retries
      if _token_expires_at is None or now >= _token_expires_at - timedelta(minutes=5):
          new_token = await _fetch_token()      # httpx timeout=10
  ```
- **影响**：python 侧注释自认「Unlike executor-node there is no fetch-failure backoff」。admin 宕机期间，每个带 `verify_token` 依赖的入站请求都先同步等待 10s 的 `/token` 超时——部署在弱网/NAT 后的执行器会表现为 API 整体 10s 级迟滞（admin 恢复前还叠加每请求重试），与 node 行为漂移。pull 循环不受影响（出站有自愈），纯入站面退化。
- **修法**：移植 node 的 `tokenFetchFailedAt + 30s` 退避（模块级单调时钟时间戳即可），`force_token_refresh` 的注释语义同步更新。
- **工作量**：S

#### E-12【可靠性/node】应用部署的 releases 历史与 app.log 永不回收：磁盘无界增长

- **位置**：`apps/executor-node/src/routes/deploy.ts:573-575,195-196` + `apps/executor-node/src/file-logger.ts:194-196`
- **证据**：
  ```ts
  removePathIfExists(paths.finalReleaseDir);   // 只删同名 releaseKey
  fs.renameSync(paths.extractDir, paths.finalReleaseDir);
  switchCurrentRelease(paths.currentLink, paths.finalReleaseDir);
  // file-logger.ts：清理保护名单——'apps' 整体跳过，releases/app.log 永不被扫
  const PROTECTED_WORKDIR_NAMES = new Set(['logs','meta','callbacks','.git_cache','.node_modules','.pkg-updates','apps']);
  ```
- **影响**：每次升级都新增 `apps/<appId>/releases/<version>-<deploymentId>/`（含完整 node_modules/venv），旧 release 无任何回收路径；daemon 应用的 `app.log` 以 append 模式无限增长。工作目录清理明确把 `apps` 列入保护名单。长期运行的执行器磁盘被部署历史填满（同 review 早已为 git_cache/.node_modules 装了 TTL 回收，唯独 apps 缺席）。
- **修法**：cleanupWorkDir 为 `apps/<appId>/releases` 增加「保留最近 N 个 + current 指向项」的回收；app.log 接入大小上限/轮转（如 50MB×3）。python 侧若启用部署功能需同步。
- **工作量**：M

#### E-13【测试/ci】HA 与 pull 模式的行为保证依赖 8 个从未进 CI 的自检脚本

- **位置**：根 `package.json` scripts（`test:arch31-multi-instance/outbox/outbox-dup/rollout`、`test:pull-dispatch`、`test:qa05-callback-tier`、`test:oidc-sso`、`test:nginx-sse`、`test:ha-compose`、`test:registry-npm`）；`.github/workflows/ci.yml`（全部 24 个 job 中仅 `check-migrations` 与 `private-registry-contract` 调用了 scripts/ 下脚本）
- **证据**：
  ```yaml
  # ci.yml 中 scripts/ 的全部引用（grep 实证仅两处）：
  - run: node scripts/check-migrations.mjs && node scripts/check-migrations.selftest.mjs
  - run: node scripts/bug18-private-registry-selftest.mjs --dry-run
  ```
- **影响**：`docker-compose.ha.yml` 头注声明「多实例行为一致性已由 ARCH-31 闭环（npm run test:arch31-multi-instance 15/15…）」，pull 派发（ARCH-32）、回调分级（QA-05）、nginx SSE、SSO 也各有 selftest——但这些保证只在开发者本机手跑，CI 全绿并不覆盖。后续任何一侧重构打破 Leader 选举/pull 契约/回调去重时，CI 无感知，HA 承诺失效于生产。
- **修法**：新增一个 `selftests` job（零依赖 node 脚本，秒级~分钟级）串跑 8 个 `.mjs` selftest；或收敛为 `npm run test:selftests` 一条命令后接入 ci.yml。
- **工作量**：S

#### E-14【测试/ci】python-packages-test 安装失败也照跑测试——假阳性绿灯

- **位置**：`.github/workflows/ci.yml:536-541`
- **证据**：
  ```yaml
  - run: pip install -e . 2>/dev/null || pip install .
    working-directory: packages/${{ matrix.package }}
    continue-on-error: true      # ← 安装失败被吞，测试照跑
  - run: python -m pytest tests/ --tb=short
  ```
- **影响**：四个 autocodeflow-http/notify/db/ai 包的安装步骤失败（pyproject 语法、依赖解析、构建后端缺失）时 CI 不红；pytest 从工作目录直接 import 包源码 + 全局已装依赖继续通过——「包能装」这一发布前置从未被 CI 验证。与 lockfile-integrity（npm 侧装不上即红）的严格度不对称。
- **修法**：去掉 `continue-on-error`，或改为 `pip install . && python -m pytest`（用 `&&` 语义短路）；若历史上确有可选依赖问题，改为显式 skip 并输出原因。
- **工作量**：S

#### E-15【Bug/py】启动注册失败后，补注册永不收敛：每次 token 刷新都重发一次 register

- **位置**：`apps/executor-python/main.py:245-272`（对照 node `main.ts:76-133` 在 `registerExecutor` 内置位 `registerSucceeded`）
- **证据**：
  ```python
  async def maybe_re_register() -> None:
      global _re_register_backoff_until
      if _register_succeeded:      # ← 只反映「启动那次」的结果
          return False
      ...
      ok = await register_executor()   # ← 成功后没有 _register_succeeded = True
  ```
- **影响**：启动期 register 失败过的 python 执行器，此后每个 token 刷新周期（~25 分钟）都会再发一次补注册，进程存续期内永不停止。admin 侧 register 幂等所以无旋转风暴，但这是无意义的周期性写流量 + 日志噪声，与 node「补注册一次即收敛」的设计意图（N41）不符。
- **修法**：`register_executor()` 成功分支内 `global _register_succeeded; _register_succeeded = True`（或 maybe_re_register 成功后置位）。
- **工作量**：S

#### E-16【打磨/infra】start-isolated.sh 与 config/redis 硬编码他人主目录绝对路径——对任何其他环境不可用

- **位置**：`scripts/start-isolated.sh:13-20`；`config/redis/autoflow-redis.conf:7-13`
- **证据**：
  ```bash
  REDIS_CONF="/home/yongsheng/project/AutoCodeFlow/config/redis/autoflow-redis.conf"
  API_DIR="/home/yongsheng/project/AutoCodeFlow/apps/admin-api"
  ```
  ```conf
  # config/redis/autoflow-redis.conf
  dir /home/yongsheng/project/AutoCodeFlow/data/redis
  logfile /home/yongsheng/project/AutoCodeFlow/data/redis/redis.log
  ```
- **影响**：隔离启动脚本与配套 Redis 配置把某位开发者的家目录写死进仓库——其他人一跑即错，且脚本注释还在说「不影响本机 MySQL」（本项目用 PostgreSQL），属三重过时。停机对偶脚本 stop-isolated.sh 也只按 /tmp pid 文件收尾，与 start 脚本一样从未接入 CI 或文档主流程。
- **修法**：路径改为 `$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)` 推导；redis conf 的 dir/logfile 改相对路径或由脚本生成临时 conf；过期注释一并清理（或整对脚本归档删除，infra/docker-compose.yml 已覆盖其用途）。
- **工作量**：S

#### E-17【打磨/infra】start-dev.sh 硬编码错误容器名：`autoflow-postgres-1` 实际不存在

- **位置**：`scripts/../start-dev.sh:57,64`
- **证据**：
  ```bash
  if ! docker exec autoflow-postgres-1 pg_isready -U autoflow; then
  ...
  if ! docker exec autoflow-redis-1 redis-cli ping | grep -q PONG; then
  ```
- **影响**：compose 项目名默认取目录名（`AutoCodeFlow` → `autocodeflow`），实际容器是 `autocodeflow-postgres-1`（除非显式设置 COMPOSE_PROJECT_NAME/容器名）。脚本在健康检查步必然失败退出，新用户按 README 走 start-dev.sh 直接卡死。同脚本还用根 docker-compose.yml 起 postgres/redis（要求 .env 填全 POSTGRES_PASSWORD 等），与 infra/docker-compose.yml 的定位重叠。
- **修法**：`docker compose ps -q postgres` + `docker exec` 按 service 名取容器；或改用 infra compose 并去掉容器名假设。
- **工作量**：S

#### E-18【测试/双端】根级 46 例 e2e 只注册 executor-node——executor-python 全链零端到端覆盖

- **位置**：`scripts/e2e-full.sh:5-6,283-300`（脚本只启动 executor-node 并等待其注册 online）
- **证据**：
  ```bash
  # 链路：PG + Redis → admin-api(:3105) → executor-node(:8002 注册在线)
  #       → admin-web vite(:5176) → 根级 e2e-full.spec.js（43 例，chromium）
  ...
  echo "══ [4/6] 启动 executor-node(:$PORT_EXECUTOR) ══"   # 无 python 执行器
  ```
- **影响**：任务派发→执行→日志回捞→kill→部署审批→RBAC 的全部 e2e 都落在 node 执行器上。python 执行器仅被 243 个进程内单测覆盖——而单测与 e2e 的差距恰恰是本轮发现的问题集中带（E-01/E-02/E-05 的 python 面在 e2e 型流量下才暴露：pull 并发、stop 排水、HTTP 语义）。python 执行器的「真注册 + 真派发 + 真回调」从未在 CI 的全链环境跑过。
- **修法**：e2e-full.sh 增加 executor-python(:8001) 注册段（env 对齐 E2E_ENV），e2e spec 增加 1~2 例「派发到 python 执行器的任务全链 + kill」；CI 的 e2e-full job 无需额外服务。
- **工作量**：M

### 【P3】

#### E-19【Bug/双端】`requirements` 类型未校验：字符串会被逐字符当作包名迭代

- **位置**：`apps/executor-node/src/routes/execute.ts:387-393,701-706`；`apps/executor-python/routers/execute.py:1553,404-415`
- **证据**：
  ```ts
  const reqs: string[] = (body.task.requirements as string[]) || [];
  for (const pkg of reqs) { if (!npmNameRe.test(pkg)) ... }   // 字符串会按字符迭代
  ```
- **影响**：admin 侧或 manifest 把 requirements 误传为字符串时，node 侧逐字符通过校验并把 `l`,`o`,`d`,`a`,`s`,`h` 当作 6 个包去 npm install（浪费一轮安装并报依赖失败）；python 侧 `_validate_requirements` 对非字符串逐项报 400，行为也不一致。防御性修复，防止上游 DTO 演进时的静默错装。
- **修法**：两侧入口 `Array.isArray(requirements)` 校验（node 400 / python HTTPException 400），spec 固化。
- **工作量**：S

#### E-20【Bug/双端】就绪探针端点漂移：node `/health/ready` vs python `/health/readiness`，health 主端点指标口径也不同

- **位置**：`apps/executor-node/src/routes/health.ts:94-109`；`apps/executor-python/routers/health.py:57-75`
- **证据**：
  ```ts
  healthRouter.get('/health/ready', ...)       // node
  ```
  ```python
  @router.get('/health/readiness')             # python
  ```
- **影响**：运维按文档/习惯为两类执行器配统一探针路径时必有一类 404；node /health 的 cpuUsage 取 `os.loadavg()[0]`（Windows 恒 0）、diskUsage 用 `statfsSync('/')`（Windows 失败返回 -1），而心跳用的是 psutil 式真实采样——同一执行器两处健康口径不一致，/health 的 degraded 判定在 Windows 上失真。
- **修法**：统一探针路径（保留旧路径 alias 一个版本）；node /health 复用 scheduler 的 CPU 采样（或缓存最近一次心跳值），Windows 下 statfs 失败时显式上报 null。
- **工作量**：S

#### E-21【性能/py】python 日志读取整文件入内存：64MB 上限的日志每请求全量 read_text

- **位置**：`apps/executor-python/routers/logs.py:40-43`（对照 node `routes/logs.ts:19-45` 的流式 pageLogLines）
- **证据**：
  ```python
  all_lines = log_file.read_text(encoding='utf-8', errors='replace').splitlines()
  total = len(all_lines)
  sliced = all_lines[fromLine:fromLine + limit]
  ```
- **影响**：python 侧单文件日志上限 64MB（MAX_LOG_FILE_BYTES），admin LOG-01 回填按 2000 行/页翻页——每页请求都把整个 64MB 文件读入并 splitlines（~3 倍峰值内存），回填一个大日志 = 数十次全量读。node 侧同一问题早已用 readline 流式化并注释了动机（「admin backfill and the UI page through here repeatedly」），python 是 parity 缺口。
- **修法**：两遍流式（第一遍计数、第二遍切片）或单遍环形缓冲；FastAPI sync 端点已在线程池执行，不会卡 loop，但内存尖峰依旧。
- **工作量**：S

#### E-22【Bug/py】`/config/reload` 不支持 workDir 热更：admin 推送被 pydantic 静默忽略，双端能力漂移

- **位置**：`apps/executor-python/routers/config.py:16-42`（对照 node `routes/config.ts:87-128` 完整支持 workDir 切换）
- **证据**：
  ```python
  class ConfigReloadRequest(BaseModel):
      max_concurrent_tasks: int | None = ...
      task_timeout_seconds: int | None = ...
      heartbeat_interval_seconds: int | None = ...
      admin_api_url...          # 无 workDir 字段；BaseModel 默认 extra='ignore'
  ```
- **影响**：admin 对 python 执行器下发 workDir 热更时，pydantic 丢弃未知字段并返回 `success:true, updated_fields:[...]`（不含 workDir）——调用方拿 200 误以为生效。node/python 对同一运维操作的响应语义分叉。
- **修法**：python 增补 workDir 字段（复用 node 的绝对路径/`..`/symlink/活跃执行四闸，python 侧对应 `list_live_execution_ids`），或至少 extra='forbid' + 明确 422。
- **工作量**：S

#### E-23【打磨/py】`_send_callback_with_retry` 的 docstring 写在函数体中段——实际 docstring 丢失

- **位置**：`apps/executor-python/routers/execute.py:804-826`
- **证据**：
  ```python
  async def _send_callback_with_retry(url: str, payload: dict, token: Optional[str]) -> bool:
      traceparent_headers: dict = {}
      if payload.get('traceparent'):
          traceparent_headers = {'traceparent': payload['traceparent']}
      """POST the execution callback with bounded retries.     # ← 这不是 docstring
  ```
- **影响**：大段 R4-C P2/E3 语义说明位于两条语句之后，`__doc__` 为 None、IDE/help 不显示，纯字符串表达式。文档资产实质丢失。
- **修法**：docstring 移到 def 下一行，traceparent 逻辑后移。
- **工作量**：S

#### E-24【可靠性/双端】verify_token 对非 ASCII Bearer 抛 TypeError → 500 而非 401（python）

- **位置**：`apps/executor-python/auth.py:244-253`（对照 node `middleware/auth.ts:175-181` 已按 Buffer 长度分流）
- **证据**：
  ```python
  scheme, _, token = authorization.partition(' ')
  token_valid = scheme.lower() == 'bearer' and any(
      hmac.compare_digest(token, vt) for vt in valid_tokens   # str/str 要求 ASCII
  )
  ```
- **影响**：`Authorization: Bearer 密码` 这类非 ASCII 头使 `hmac.compare_digest` 抛 `TypeError: comparing strings with non-ASCII characters is not supported`——FastAPI 返回 500（应为 401），污染错误率指标，也和 node 侧的 timing-safe 比较实现不对齐。
- **修法**：比较前 `token.isascii()` 预检或统一 `compare_digest(a.encode(), b.encode())`。
- **工作量**：S

#### E-25【安全/双端】执行器监听缺省绑全接口，裸机安装路径未写 REQUIRE_TOKEN——token 缺失即任意代码执行面公开

- **位置**：`apps/executor-python/main.py:312`；`apps/executor-node/src/main.ts:248`；`scripts/install.sh:182-190`
- **证据**：
  ```python
  uvicorn.run('main:app', host='0.0.0.0', port=settings.port, reload=False)
  ```
  ```ts
  const server = app.listen(config.port, async () => {   // 未传 host —— 默认全接口
  ```
  ```bash
  # install.sh 生成的 .env（第 182-190 行）：无 REQUIRE_TOKEN 键
  EXECUTOR_SECRET=${EXECUTOR_SECRET}
  WORK_DIR=${WORK_DIR}
  MAX_CONCURRENT_TASKS=10
  ```
- **影响**：compose 部署已有三重收敛（127.0.0.1 端口映射 + REQUIRE_TOKEN=true + token 必配），但裸机路径（install.sh 是文档化装机入口）监听 `0.0.0.0:8002` 且 `.env` 不含 `REQUIRE_TOKEN=true`——若运维漏配 token，两侧执行器都落入 dev-mode allow-all：能路由到该主机的人即可 `POST /api/execute` 在主机上执行任意代码（auth.ts/auth.py 的 fail-open 分支在 REQUIRE_TOKEN 缺省时生效）。main.ts 对该状态只打 warn（`No EXECUTOR_SHARED_TOKEN ... /api/* accepts UNAUTHENTICATED requests`），不拒启。
- **修法**：install.sh 生成的 .env 追加 `REQUIRE_TOKEN=true`；进一步可给两执行器加 `BIND_ADDRESS` 配置（缺省 127.0.0.1，容器场景由 compose 显式设 0.0.0.0），把 fail-open 从「告警」升级为「需要显式选择」。
- **工作量**：S

#### E-26【Bug/node】Windows 下 npm install 走 `shell: true` 且 `--prefix` 路径不加引号：WORK_DIR 含空格即安装错位

- **位置**：`apps/executor-node/src/routes/execute.ts:718-728,754-764`
- **证据**：
  ```ts
  const npmArgs = ['install', '--prefix', nodeModulesDir];
  ...
  return await runCommand(npmCmd, npmArgs, {
    ...
    shell: process.platform === 'win32',   // args 拼接不做引号转义
  ```
- **影响**：`spawn(cmd, args, {shell:true})` 按 `join(' ')` 拼命令行且不加引号；`WORK_DIR=C:\My Tasks\...` 时命令变为 `npm.cmd install --prefix C:\My Tasks\... pkg`——npm 把 `Tasks\...` 当包名。当前各默认路径（/data/tasks、C:/af-work）无空格，故列为 P3 防御项；同文件对 entrypoint 已做 workDir 约束，唯独没有对 WORK_DIR 本身的空语感校验。
- **修法**：win32 分支对含空格路径预先加引号（或改用 `shell:false` + `npm.cmd` 全路径 / `cmd /c npm.cmd ...` 显式构造）；启动时对 WORK_DIR 含空格告警。
- **工作量**：S

#### E-27【打磨/双端】refreshTokenIfNeeded 无 in-flight 去重：并发请求各自发一次 /token

- **位置**：`apps/executor-node/src/middleware/auth.ts:120-141`；`apps/executor-python/auth.py:188-198`
- **证据**：
  ```ts
  async function refreshTokenIfNeeded(): Promise<void> {
    const now = new Date();
    if (tokenFetchFailedAt !== null && ...) return;   // 只有失败退避，无 in-flight 合并
    if (tokenExpiresAt === null || ...) { const newToken = await fetchToken(); }
  ```
- **影响**：token 过期瞬间的一批并发回调/心跳各自触发 fetchToken（node 最多 N 次并发 POST /token；python 同）。admin 侧 issueToken 按 (address, startupId) 幂等兜住了「旋转风暴」后果，但执行器侧仍是放大流量 + 多余延迟。R9 注释里也承认依赖服务端幂等兜底。
- **修法**：模块级 in-flight promise 复用（node）/ asyncio.Lock（python），一次刷新全体等待。
- **工作量**：S

#### E-28【打磨/infra】deploy.sh / Makefile 仍绑定 docker-compose v1（EOL），健康检查端点也已过时

- **位置**：`deploy.sh:76,91,96,102`；`Makefile:13,44,50,55,59,63,99,102`
- **证据**：
  ```bash
  if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}错误: Docker Compose 未安装..."   # v1 独立二进制 2023 年起 EOL
  ...
  docker-compose down && docker-compose up -d
  ```
- **影响**：现代 Docker Desktop/Engine 只带 `docker compose` 插件，deploy.sh 直接拒绝工作（Makefile build/start/stop/logs 同）；dev.sh 已写 `docker-compose || docker compose` 双写回退，说明问题已知但只修了一处。且脚本内健康检查注释（S2 说 /api/health/live）与实际 grep 的 /api/health、dev.sh/Makefile status 用的 /health（admin-api 实际是 /api/health/live）三处漂移——status 恒报「admin-api 未运行」。
- **修法**：统一 helper：`compose() { docker compose "$@" || docker-compose "$@"; }`；status 健康端点改 `/api/health/live`；deploy.sh 补 `set -uo pipefail`。
- **工作量**：S

#### E-29【打磨/infra】init-db.sh 迁移命令疑似失效 + 初始密码打印到终端 + set -e 下的死分支

- **位置**：`init-db.sh:64,66-71,151-158`
- **证据**：
  ```bash
  cd apps/admin-api && npx typeorm migration:run     # admin-api 的实际用法带 -d
  if [ $? -eq 0 ]; then                              # set -e 下永不到达 else
  ...
  echo -e "${YELLOW}密码: ${INITIAL_ADMIN_PASSWORD:-admin123}${NC}"   # 明文回显
  ```
- **影响**：(1) admin-api package.json 的规范用法是 `npm run typeorm -- migration:run -d src/data-source.ts`，裸 `npx typeorm migration:run` 在 typeorm 0.3 需要 ormconfig/datasource 文件，仓库中未见（**待复核**：若 admin-api 存在隐式 ormconfig 则可用）；(2) 初始口令回显进终端记录/CI 日志；(3) `if [ $? -eq 0 ]` 在 `set -e` 下是死代码，误导维护者以为有失败分支。
- **修法**：改用 `npm run migration:run`；删除密码回显；删除死分支。
- **工作量**：S

#### E-30【打磨/infra】Makefile clean 全仓 `rm -rf node_modules`——连根 node_modules 与工具缓存一起删除

- **位置**：`Makefile:109-114`
- **证据**：
  ```make
  clean:
  	find . -name 'node_modules' -type d -prune -exec rm -rf {} +
  	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
  	find . -name 'dist' -type d -prune -exec rm -rf {} +
  ```
- **影响**：从仓库根 `make clean` 会删除根 package.json 的 node_modules（`npm run test:all`/lint:all 的载体）、`.zcode` 目录下任何 node_modules，以及 docs-site 等全部子项目依赖——"清理构建产物"变成了全量重装。`-name dist` 还会误删任何名字为 dist 的数据目录。
- **修法**：范围限定到 `apps/* packages/*` 并排除 `.zcode`/`uploads`；或逐项目 `npm run clean`。
- **工作量**：S

#### E-31【打磨/infra】install.sh 默认安装 Node 20，与同文件头注「安装 Node.js 24.x」自相矛盾且处于弃用周期

- **位置**：`scripts/install.sh:16,30`
- **证据**：
  ```bash
  echo "  1) 安装 Node.js 24.x；2) 配置 .env（...）；" >&2
  ...
  NODE_VERSION="20"
  ```
- **影响**：apt/yum 自动安装走 nodesource setup_20.x；release.yml 注释明确「node 20 已入弃用周期；lockfile 由 npm 11 生成，node 20 自带 npm 10 解析有差异」——裸机执行器会在与 CI（node 24）不同的 npm 解析行为下安装依赖。
- **修法**：`NODE_VERSION="24"`（或抽 EXECUTOR_NODE_VERSION env 可覆盖）。
- **工作量**：S

#### E-32【打磨/ci】ci-local.sh 的 npm audit 阈值（high）弱于 CI（moderate）——本地门禁静默放行 moderate 漏洞

- **位置**：`scripts/ci-local.sh:180` vs `.github/workflows/ci.yml:247`
- **证据**：
  ```bash
  # ci-local.sh:180
  ( cd "$p" && npm audit --registry=... --omit=dev --audit-level=high )
  # ci.yml:247
  npm audit ... --audit-level=moderate --json ...
  ```
- **影响**：ci-local.sh 自称「本地一条命令等价跑 ci.yml 的全部 CI job」，但 SEC-06 的门槛升格（high→moderate）只改了 CI——本地全绿推送后 CI 才红，违背该脚本的存在目的。头注（第 11 行）也仍写着旧阈值。
- **修法**：对齐为 moderate（或抽成变量两处引用同一默认）。
- **工作量**：S

#### E-33【测试/双端】playwright 根配置无 retries、无 workers 约束：43+2 两文件可并行打同一后端

- **位置**：`playwright.e2e.config.js:1-20`
- **证据**：
  ```js
  module.exports = {
    testDir: '.',
    testMatch: '**/e2e-*.spec.js',
    timeout: 60000,
    // 无 retries / workers / fullyParallel 配置
  ```
- **影响**：默认 workers = CPU/2：e2e-full.spec.js（写型，注册/建任务/审批全链）与 e2e-ui09-mobile.spec.js 可能分到两个 worker 并行执行，共用同一个 admin/executor 后端，产生限流级联（脚本虽放大了 THROTTLE）与数据竞争面；同时无 retries 让 Windows e2e 的已知 flake 直接红。CI e2e-full 40 分钟 timeout 也说明该套件对偶发失败没有缓冲。
- **修法**：`workers: 1`（全链共享态的显式表达）+ `retries: process.env.CI ? 1 : 0`；mobile spec 若确需并行，改为同 file 内串行用例。
- **工作量**：S

#### E-34【打磨/infra】compose 杂项：`version: '3.9'` 已弃用、minio 用 `latest`、`PYPI_API_KEY` 是死配置

- **位置**：`docker-compose.yml:5,190,339`；`apps/registry-pypi/main.py`（无任何 PYPI_API_KEY 读取）
- **证据**：
  ```yaml
  version: '3.9'
  ...
    image: minio/minio:latest        # 其余服务均 pin 了版本（postgres:16-alpine/redis:7）
  ...
      PYPI_API_KEY: ${PYPI_API_KEY}  # main.py 从未读取
  ```
- **影响**：compose v2 对 version 字段发弃用警告；minio 浮动 latest 使日志存储组件升级不可复现（jaeger 都 pin 到 1.57）；PYPI_API_KEY 让运维误以为存在 token 鉴权通道（实际只有 Basic），应删除或实现。
- **修法**：删 version 行；minio pin 具体版本；删除 PYPI_API_KEY 或在 README 标注为预留。
- **工作量**：S

#### E-35【打磨/ci】release-please 的 token 回退链是 fail-unsafe 缺省：未配 secret 时发布链路静默断开

- **位置**：`.github/workflows/release-please.yml:63-70`
- **证据**：
  ```yaml
  # 未配置该 secret 时回落 `github.token`：Release PR/Release 仍可建，
  # 但 tag 不级联，需人工重推 tag 触发发布（恢复路径见 docs/sdk-guide.md）
  token: ${{ secrets.RELEASE_PLEASE_TOKEN || github.token }}
  ```
- **影响**：默认形态下 Release PR 正常合并、GitHub Release 正常创建，但 release.yml（npm/PyPI 发布）永不触发且无任何工作流级报错——只有读过 workflow 注释的人知道要去人工推 tag。v1.1.1 已实爆过一次（注释自述）。fail-unsafe 的静默降级不适合发布链。
- **修法**：加一步 `if: env.RELEASE_PLEASE_TOKEN == ''` 的显式 `::warning::`/失败提示（或用 GitHub Actions 的 required-secret 检查 job），把「tag 不级联」变成显式信号。
- **工作量**：S

#### E-36【打磨/infra】根级脚本 set 纪律不齐：5 个脚本缺 `-u`/`pipefail`

- **位置**：`deploy.sh:3`、`dev.sh:3`、`start-dev.sh:3`、`init-db.sh:3`、`scripts/start-isolated.sh:5`、`scripts/stop-isolated.sh:4`
- **证据**：grep 实证根级脚本均为 `set -e`；scripts/ 下新脚本（e2e-full/chaos-drill/install/load-test-stack/bundle）均为 `set -euo pipefail`。
- **影响**：未定义变量静默为空（如 .env 缺键时 `PGPASSWORD="" psql` 用空口令尝试）、管道中途失败被吞（`curl | grep` 类健康检查永远成功）。
- **修法**：统一升级为 `set -euo pipefail`（dev.sh 的 `pkill ... || true` 容错已存在，不受 -e 影响）。
- **工作量**：S

#### E-37【打磨/双端】执行器版本号双事实源：config.ts/`EXECUTOR_VERSION='1.0.0'` 与 package.json `version` 各自维护

- **位置**：`apps/executor-node/src/config.ts:59`、`apps/executor-node/package.json:3`；python 侧同理（`config.py:95` 与 FastAPI `main.py:277 version='1.0.0'`）
- **证据**：
  ```ts
  export const EXECUTOR_VERSION = '1.0.0';   // register/heartbeat 单一上报源（注释自称）
  ```
- **影响**：EXE-VER-1 的版本门禁依赖这里上报的值，但「升级执行器 = 重跑安装」并不会自动 bump 该常量（release-please 只管 packages/ 三个 SDK）；常量与包版本、与 FastAPI title version、与 desktop 内嵌 bundle 版本之间没有一致性检查。版本漂移告警节流逻辑（好设计）将建立在永不变化的版本号上。
- **修法**：node 侧 `EXECUTOR_VERSION` 从 package.json 读取（构建期注入或 `require('../package.json').version`）；python 侧从 importlib.metadata 或单常量导出给 main.py 复用。
- **工作量**：S

#### E-38【打磨/双端】install.sh 与 install-script.content.ts 双拷贝：守卫仅运行于「仓库可见」环境

- **位置**：`scripts/install.sh:2`（头注「互为拷贝…修改时请同步两处」）；`apps/admin-api/src/modules/executor/install-script.content.ts:273-285`（`repoInstallScriptOrNull` 读取失败返回 null 跳过比对）
- **证据**：
  ```ts
  export function repoInstallScriptOrNull(): string | null {
    try {
      const p = resolve(__dirname, "../../../../../scripts/install.sh");
      return readFileSync(p, "utf8");
  ```
- **影响**：两份 260+ 行脚本靠人工同步；防漂移守卫在 dist 部署形态（`__dirname` 下五层不可达）返回 null 直接跳过——CI 中没有独立的「两副本 diff」步骤（对照 desktop-bundle-drift 对 ncc 产物有专门 job）。任何一侧改动（如 E-09/E-31 的修复）只落一份即静默分叉。
- **修法**：content.ts 改为构建期由 scripts/install.sh 生成（脚本 + prebuild），CI 加 `git diff --exit-code` 守卫；或至少在 ci.yml 加一步直接 `diff scripts/install.sh <(node -e '...extract INSTALL_SCRIPT...')`。
- **工作量**：S

#### E-39【安全/打磨】registry-pypi CORS `allow_origins=["*"]` 与双上传端点重复

- **位置**：`apps/registry-pypi/main.py:29-34,354,430-438`
- **证据**：
  ```python
  app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET","POST","OPTIONS"], ...)
  ...
  @app.post("/")  ...  """twine-compatible upload endpoint."""
  @app.post("/upload")  ...  """Alternative upload endpoint."""
      return await upload_package(content=content, name=name, version=version, _user=_user)
  ```
- **影响**：Basic-auth 接口配 `*` CORS 收益为零（浏览器本就无法跨域携带 Basic 凭据）但扩大了预探面；`/` 与 `/upload` 双端点让审计/限流/文档各需维护两份。上传鉴权（compare_digest）与 409 防覆盖质量都不错，这两处属收尾。
- **修法**：CORS 收敛到 admin-web 实际来源（或删除中间件——pip/twine 不用 CORS）；/upload 保留 alias 一版后下线。
- **工作量**：S

#### E-40【安全/打磨】deploy 写 .env 用 `k=v` 裸拼接：值含换行即注入额外键

- **位置**：`apps/executor-node/src/routes/deploy.ts:568-571`
- **证据**：
  ```ts
  const envContent = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(paths.extractDir, '.env'), envContent, ...);
  ```
- **影响**：envVars 来自 admin 下发的应用环境（用户可配）：值内嵌 `\nEVIL=1` 即向被部署应用注入额外环境变量；含引号/反斜杠在 dotenv 解析下同样变形。输入本就来自管理面，属纵深问题；但 .env 是应用进程唯一的配置入口，值得收紧。
- **修法**：值做 `\n`/`\r` 拒绝或转义（`\\n`），键名做 `[A-Za-z_][A-Za-z0-9_]*` 白名单。
- **工作量**：S

#### E-41【打磨/ci】executor-node 无 ESLint（lint:node 是 echo 占位），CI 亦无任何 lint 面

- **位置**：根 `package.json` `"lint:node": "echo 'executor-node has no eslint config...'"`
- **证据**：
  ```json
  "lint:node": "echo 'executor-node has no eslint config (ESLint v9 needs eslint.config.*) — skipped, see ARCH-20 verification notes'"
  ```
- **影响**：executor-node 是核心执行面（1,375 行 execute.ts），却是全仓唯一没有静态检查的 TS 项目；arch/ver注释记录了「待补」，但没有任何跟踪项。admin-api/web 均 lint 全绿基线，唯独执行器裸奔。
- **修法**：补 eslint.config.mjs（typescript-eslint recommended + no-floating-promises），lint:all 接入。
- **工作量**：S

#### E-42【打磨/双端】python 心跳/回调载荷细节与 node 尚有三处小漂移（pull 拒绝无 failureReason、TASK_NAME 未 str()、health token 口径）

- **位置**：`apps/executor-python/routers/execute.py:782-801`；`apps/executor-python/routers/execute.py:1598-1599`；`apps/executor-python/routers/health.py:16-18`
- **证据**：
  ```python
  # ① reject_pulled_execution 的失败回调无 failureReason（node 同路径也无——但该场景
  #    属容量竞态，归类为 killed/unknown 都失真，见 E-01 修法一并解决）
  # ② env['TASK_NAME'] = task.get('name', '')   # name 可能是非 str；node 用 String()
  # ③ health tokenValid 只读静态 env（node getExecutorAuthToken 同）——动态 token
  #    生效与否在 /health 不可见
  ```
- **影响**：均为观测/健壮性毛边：TASK_NAME 非 str 会在 spawn env 构造时抛 TypeError（任务失败原因难定位）；health 的 tokenValid 恒 true 当静态 token 存在，动态链路坏了探针不报警。
- **修法**：随 E-01/E-20 一并收口；TASK_NAME 显式 `str()`；health tokenValid 改报「静态+动态」双布尔。
- **工作量**：S

#### E-43【打磨/双端】update-package 的自述（「extract and replace → self-update」）与实现漂移：只下载不更新

- **位置**：`apps/executor-node/src/routes/update-package.ts:4-6,128-134`
- **证据**：
  ```ts
  /** Update strategy: download to temp dir -> verify SHA-256 -> extract and replace -> send confirmation callback */
  ...
  // 实际只做了 1-3 步：下载 → 校验 → 上报 status:'downloaded'，无 extract/replace
  ```
- **影响**：执行器包推送链路（admin 包管理 UI 的「推送更新」）实际终点是「包已下载到 .pkg-updates 并最多保留 3 份」（file-logger.ts:337 MAX_PKG_UPDATES=3），执行器本体从未被替换——运维语义与 UI 期望不符（（FEAT 假设的自更新能力未闭环）。下载/校验/看门狗实现本身质量好。
- **修法**：要么补齐 replace+重启确认（需 supervisor/systemd 配合，M），要么把端点语义更名 pull-package 并在 admin 侧 UI/文档标注「需人工安装」。
- **工作量**：M（补齐）/ S（改语义）

#### E-44【可靠性/双端】回调重试与心跳重试均无抖动（jitter）

- **位置**：`apps/executor-node/src/callback.ts:273`（`BASE_DELAY_MS * Math.pow(2, attempt)`）；`apps/executor-python/scheduler.py:126-132`（tenacity wait_exponential 无 jitter 参数）
- **证据**：
  ```ts
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);   // 纯指数，无随机
  ```
- **影响**：admin 短暂故障恢复瞬间，全集群执行器（同时断连、同相位重试）的第一波重发同时到达——admin 恢复窗口被同步尖峰打二次。当前执行器规模小、相位天然分散（各自启动时间），属前瞻性收敛项。
- **修法**：延迟乘 `(0.5 + Math.random())`；tenacity 加 `wait_random_jitter`。
- **工作量**：S

#### E-45【测试/双端】e2e 未覆盖的关键链路：pull 模式、artifacts 全链、token 轮换自愈、回调死信重放

- **位置**：`e2e-full.spec.js`（46 例标题全列核对：覆盖登录/任务/部署/kill/RBAC/审批/SSRF/私服依赖，但无下列项）
- **证据**：pull 模式仅有本地 `test:pull-dispatch`（selftest 桩）；FEAT-05 artifacts 无 e2e（pytest 侧 test_artifacts 为桩级）；R10/R11 token 自愈仅有两侧单测；E-05 的死信/重放无任何自动化。
- **影响**：这些恰是「断连/轮换/产物」类最难在生产排查、又最容易回归的路径；轮换自愈（R10）坏掉的第一个征兆是执行器集体离线 30 分钟，当前 CI 无法预警。
- **修法**：优先补两条：(1) admin rotate-token → 心跳 401 → 自愈后心跳恢复（复用 e2e 骨架）；(2) artifacts：任务写 AUTOFLOW_ARTIFACTS_DIR → 详情页可见清单。pull/dead-letter 由 selftest 进 CI（E-13）补位。
- **工作量**：M

---

## 三、架构升级建议专节

### 3.1 执行器协议契约化：把「注释里的 parity」变成机器强制的契约（对应 E-01/E-02/E-20/E-22/E-45）

- **现状**：dispatch 载荷（timeout=0/glueLanguage/requirements/traceparent）、回调载荷（failureReason 枚举/日志截断常量/artifacts）、运维端点（/health/ready vs /health/readiness、/config/reload 字段集）三方语义靠两侧注释互相引用（"node execute.ts:339-342 parity"）维持，每轮一致性修复都在补漏。
- **建议**：抽出 `packages/executor-protocol`（JSON Schema 或 zod/pydantic 双生成）：定义 ExecuteRequest/CallbackItem/ConfigReload 三个载荷与 4 个运维端点的最小集合；两侧执行器 + admin-api 三方在 CI 用同一组测试向量（timeout=0、requirements=字符串、failureReason 全枚举、errorMessage 4096 边界）互 pin。
- **收益**：E-02 类「同一字段两种语义」从「发现于生产」变为「红在 CI」；python 执行器新增能力（E-22）不再依赖人工抄 node。
- **风险**：契约包成为三方发布耦合点——建议只 pin「线上已存在语义」，新增字段全部 optional + 单向弃用流程。工作量 L（可先做 timeout/readiness 两个向量的最小切片，M）。

### 3.2 回调可靠性分层：从「5 轮死信 + 手工重放」到「admin 侧对账 + 自动重放」（对应 E-05/E-13/E-44）

- **现状**：执行器已把终态回调落盘（含 meta 重试计数/死信目录/心跳上报积压数），缺的是对账闭环——admin 有 `runningExecutionIds` 活性保护，却没有「执行器声明已终态但 admin 仍是 RUNNING」的反向核对通道。
- **建议**：(1) admin 新增 `GET /executors/:address/terminal-states?since=` 只读端点；(2) 执行器死信目录定期（如每小时）对账——admin 已终态的直接清理，仍 RUNNING 的重发；(3) 重试预算改为时长型（24h TTL）+ 毒丸文件数上限。
- **收益**：admin 滚动升级/网络抖动不再丢失任务结果；deadLetterCount 心跳字段从「运维感知」升级为「自动收敛」。
- **风险**：对账端点扩大 admin 查询面（需限流 + 分页）；重放风暴需沿用现有批次上限 100。工作量 M。

### 3.3 registry 面收敛：registry-pypi 补齐 verdaccio 级别的运维特性，或统一到单一 registry 形态（对应 E-04/E-10/E-39）

- **现状**：两个 registry 是两种技术栈、两种鉴权模型（verdaccio htpasswd+JWT vs 自研 Basic）、两种部署加固（npm 侧只读挂载 config + loopback 端口有文档矩阵；pypi 侧 root 容器 + 弱口令 fail-open）。npm 侧凭据能进任务 .npmrc（NPM_REGISTRY_TOKEN 机制完整），pypi 侧刻意无凭据通道（config.py ADR），能力不对称。
- **建议**（按投入排序）：短期——E-10/E-39 的加固（fail-closed 凭据、non-root、CORS 收敛），pypi 对齐 npm 侧 README 的「权限矩阵 + 加固建议」文档格式；中期——pypi 增加 token 鉴权（与 admin 下发的任务依赖凭据机制对齐，闭环 python 任务私服依赖用例——BUG-18 目前只覆盖 npm）；长期评估——统一到支持双协议的成品（如 devpi/Artifactory）或保持双栈但在 admin 侧抽统一 registry 凭据分发层。
- **收益**：任务依赖投毒面（目前 pypi 全靠 Basic 明文 + 无审计日志）收敛；BUG-18 的 python 用例可从「设计上不成立」变为可闭环。
- **风险**：自研 registry 的轻量是它的价值（438 行、零依赖、测试全），引入成品会带来部署重量；建议只做「短期加固 + 中期 token」，不动栈。工作量：短期 S、中期 M。

### 3.4 CI 自检整合 + workflow 去重：composite action 化（对应 E-13/E-14/E-32/E-33）

- **现状**：ci.yml 1,010 行中大量复制块——三处重复的 PG+Redis services 段、五处重复的 npm ci + setup-node(cache) 段、两处 chrome apt 源清理、两处 e2e artifacts 上传；8 个行为自检脚本散落在 package.json 无 CI 入口。
- **建议**：(1) 新增 `.github/actions/setup-node-project`（checkout+setup-node+cache+npm ci）与 `.github/actions/pg-redis-services`（或抽 reusable workflow）；(2) 新增 selftests job 串跑 8 个 .mjs（全部零依赖、无需服务容器）；(3) python-packages 去掉 continue-on-error 并补 pip cache。
- **收益**：ci.yml 预计缩减 200+ 行；ARCH-31/32/SSO/SSE 的回归从「本地自觉」变为门禁；新人理解成本显著下降（当前 24 个 job 的注释密度极高，恰说明重复面已超载）。
- **风险**：低——均为结构重构不改语义；reusable workflow 的 job 并行度需重排。工作量 M。

### 3.5 裸机部署路径与容器部署路径的安全基线对齐（对应 E-03/E-09/E-11/E-31）

- **现状**：项目把容器内执行器加固到了非标准水准（non-root + cap_drop ALL + no-new-privileges + loopback 端口 + REQUIRE_TOKEN=true），但三条裸机路径掉队：install.sh 的 systemd unit（root、无沙箱、无 REQUIRE_TOKEN）、deploy.sh 的 compose 面未收敛 admin 端口与初始口令、dev.sh 生成的 .env 全是占位密钥。
- **建议**：定义「执行器部署最小基线」清单（专用用户/沙箱项/REQUIRE_TOKEN/端口绑定/初始口令强度）写进 docs/deployment.md，install.sh、compose、Windows 手动部署三处各自核对；deploy.sh 增加部署后自动改密提示或首登强制改密（admin-api 侧 support）。
- **收益**：消除「同一产品两种安全 posture」的运维认知负担；云上部署（0.0.0.0 暴露 + Admin@123456）这类事故面直接消失。
- **风险**：无（纯加固）。工作量 M。

---

## 四、待复核项

1. **init-db.sh:64 `npx typeorm migration:run` 是否真失败**（E-29）：typeorm 0.3 CLI 无 `-d` 时会查找 ormconfig/`data-source` 约定文件；未逐项排查 admin-api 目录下的隐式配置（ormconfig.js/json/ts 均未 grep 到，倾向失效，但未运行验证）。
2. **E-26（Windows `shell:true` 路径空格）**：基于 Node 文档「spawn with shell:true 时 args 不做引号转义」的推导 + npm.cmd 行为常识，未在真实 Windows 环境复现 `--prefix` 含空格的实际解析。
3. **E-33（playwright 双 spec 并行）**：未显式确认 CI runner 的默认 workers 值（ubuntu-latest 4 vCPU → 2 worker）；若 Playwright 版本行为有变可能实际串行。
4. **E-05 死信时限的精确值**：node 侧「5 轮 ≈ 1 分钟」按单 admin URL + 10s 超时推算；多 admin URL（HA）下每轮含 failover 串行，时限会拉长（偏有利方向）。
5. **admin 侧对 pull 429 的处置**（E-01 修法依赖）：admin-api `executor-pull.service` 领取即出队还是有可见性超时回队，属 r1 审查范围，未展开核验；若已有回队机制则 E-01 的实际严重度下调一档。
6. **start-dev.sh 容器名**（E-17）：若用户环境设置了 `COMPOSE_PROJECT_NAME=autoflow` 则容器名成立；默认安装路径下按目录名推断为必错。
7. **`.env` 文件是否曾入库**：当前 `git ls-files` 无任何 `.env`（仅 .env.example），apps/*/`.env` 为本地未跟踪文件；未做历史全量检查（gitleaks CI 在跑，视为已覆盖）。
8. **E-43 的 admin 侧语义**：executor-packages UI 是否已明确「推送=下载待装」，属 r1 范围，未核验 admin-web 文案与 executor 侧 status:'downloaded' 的对齐程度。

---

## 附：最重要 10 条（Top10）

| 编号 | 一句话摘要 |
|---|---|
| E-01 | pull 模式下容量竞态会把被拒的拉取任务直接回调为**永久失败**（node+python 同病） |
| E-02 | `timeout=0`（不限时）在 node 无限跑、在 python 被 300s 默认值杀——同一字段三种语义 |
| E-03 | compose 把 admin-api 暴露在 0.0.0.0:3105 且初始管理员缺省口令 Admin@123456，新部署可被直接接管 |
| E-04 | deploy/update-package 下载链无私网 SSRF 闸且首跳附带执行器共享 token（execute.ts 有闸，这两条链没有） |
| E-05 | 回调落盘重试 5 轮（node ≈1 分钟 / python ≈2 分钟）即死信，admin 短暂中断即丢任务终态 |
| E-06 | node 产物上传 fetch 无超时：admin 挂起时任务槽被永久占用（python 侧有 30s 超时对照） |
| E-08 | node 工作目录 TTL 清理无活跃执行保护（python 侧有），timeout=0 长跑任务目录可被整体删除 |
| E-13 | HA/pull/SSO/SSE 等 8 个行为自检脚本从未进 CI——compose.ha 与 ARCH-32 的保证只靠本地手跑 |
| E-14 | python-packages-test 安装失败也照跑测试（continue-on-error），CI 绿灯不能证明包可安装 |
| E-18 | 46 例根级 e2e 只注册 executor-node，executor-python 全链零端到端覆盖 |
