# Windows 深度测试发现记录（R13+）

> 配套任务书：`docs/WINDOWS-TESTING-PLAN.md`。本轮由 Windows 侧直接接手开发与修复，findings 同时作为修复输入。
> 状态标记：🔴 阻断 ⚠️ 功能缺陷 🧪 测试断言问题（生产代码无碍） ℹ️ 记录/体验

## 环境基线（2026-09-05 记录）

| 项 | 实际值 | 与要求对照 |
|---|---|---|
| OS | Windows 11 (build 26200) x64 | ✅ |
| Node.js | v24.17.0 / npm 11.13.0 | ✅ 与 CI 对齐 |
| Python（系统） | 3.14.6（`C:\Python314`），另有 uv 托管 3.13.13 | ⚠️ 高于要求 3.12.x；R13-1.4/1.9 用 `uv venv --python 3.12` 隔离 |
| Git | 2.55.0.windows.2，`core.autocrlf=true` | ⚠️ 触发 R-01，见 W-01 |
| Docker（Windows 原生） | 未安装 | — 走 WSL2 Ubuntu；实际用其**原生 PostgreSQL 16.13 + Redis 7**（Docker Hub 拉镜像 TLS 超时，国内网络不可达，镜像方案备用） |
| WSL 网络模式 | **mirrored**（Windows↔WSL localhost 直通，实测 5432/6379 可达） | ✅ R14 真链路可全在 Windows 跑 |
| Playwright | 待装（R14-2.8 前 `npx playwright install chromium`） | — |
| 代理 | 无 HTTP(S)_PROXY | ✅ 已知坑不触发 |
| npm registry | npmmirror 镜像（非官方源） | ℹ️ lockfile 一致；1.8 发布包消费实测镜像同步正常 |

---

## R13 结果总览

| 项 | 结果 | 说明 |
|---|---|---|
| 1.1 clone/autocrlf | ⚠️ | `core.autocrlf=true` + 无 `.gitattributes`，R-01 实锤（W-01） |
| 1.2 admin-api | tsc ✅；jest **872/873**；eslint ❌→✅* | 唯一 jest 失败与 eslint 37078 错误**全部是 W-01 CRLF 连锁**；修 .gitattributes 后复跑确认 |
| 1.3 executor-node | build ✅；jest **153/158** | 5 失败全为测试 POSIX 假设（W-03），生产代码已有 win 分支（npm.cmd/shell 等） |
| 1.4 executor-python | pytest **113/125** | **2 个生产阻断/安全缺陷**（W-02 setsid、W-04 路径守卫绕过）+ 测试断言问题（W-05） |
| 1.5 admin-web | vitest 34/35→**35/35**（复跑）；lint ✅；build ✅ | 首跑 1 例 flaky（W-06）；build chunk 体积警告为既有问题 |
| 1.6 acf-cli | vitest **48/48** ✅；tsc ✅ | |
| 1.7 mcp-server | vitest **61/61** ✅；`--help`/`--version` 正常输出 | Git-Bash UTF-8 下无乱码（帮助文本全 ASCII，R-11 风险不成立）；ℹ️ `--help` 路径也先打 `AUTOCODEFLOW_API_TOKEN` WARNING（W-07 体验） |
| 1.8 发布包消费 | npm `@autocodeflow/sdk`+`autocodeflow-mcp-server` ✅（bin 可跑、require 可导入）；pip `autoflow-sdk` ✅（3.12 venv 导入正常） | Windows 真实用户路径 OK |
| 1.9 registry-pypi | pytest **33/33** ✅ | |
| 环境可复现性 | ℹ️ | 两个 Python 项目的 requirements.txt **均不含 pytest/pytest-asyncio**，Linux 侧靠手动装——新用户按 README 在 Windows 装完跑不了测试（W-08） |

---

## Findings

### W-01：⚠️→🔴 R-01 实锤——无 `.gitattributes` + `core.autocrlf=true`，全仓工作树 CRLF 化
- 环境 Windows 11 26200 / Git 2.55.0
- 轮次与用例：R13 1.1（风险点 R-01）
- 现象与连锁证据：
  1. `file scripts/install.sh` → CRLF；`.sh` 全家（install/deploy/dev/init-db/start-dev）受影响；
  2. **admin-api eslint 37078 个错误**，逐条 `prettier/prettier: Delete ␍`（Linux 基线 0/0）；
  3. **admin-api jest 唯一失败**：`GET /executors/install.sh › backend copy is byte-identical to repo scripts/install.sh`——`install-script.content.ts`（内存 LF 字符串）与工作树 CRLF 文件逐字节比对，250 行全差异；
  4. `git status` 干净**不能**作为无污染判据（autocrlf 归一化特性）。
- 复现步骤：任何 Windows clone（autocrlf=true 默认值下）→ `npx eslint .`。
- 预期 vs 实际：任务书预期 install.sh 必须 LF → 实际 CRLF；bash 下 `\r` 报错。
- 严重级：对 Windows 开发体验=阻断（lint/单测守卫全挂）；生产影响：若 CI/打包产物带 CRLF .sh 则安装脚本不可用。
- 修复：`.gitattributes`（R15-3.2）+ `git add --renormalize .` + 本地 `core.autocrlf=input`。

### W-02：🔴 executor-python 生产代码 `os.setsid`/`os.killpg` 在 Windows 不存在——任何真实任务执行即崩
- 环境 Windows 11 / Node 24 / Python 3.12 venv（uv）
- 轮次与用例：R13 1.4；风险点 R-03（进程组）
- 位置：`apps/executor-python/routers/execute.py:555`（`preexec_fn=os.setsid`）、`:643`（`os.killpg(os.getpgid(proc.pid), SIGKILL)`）
- 现象：`AttributeError: module 'os' has no attribute 'setsid'`——pytest 中 9 个用例由此引发（含 mock spawn 的用例：kwargs 构造时即访问 `os.setsid` 失败）。**等价于 Windows 上 python executor 全任务失败**。
- 复现步骤：对 python runtime 任务 POST /execute → 返回 success=false，errorMessage=该 AttributeError。
- 预期 vs 实际：预期跨平台任务执行 → 实际崩。executor-node 已有对应处理（`process-group kill` 的 Windows 回退），python 侧缺失。
- 严重级：阻断。
- 修复方向：win32 用 `creationflags=CREATE_NEW_PROCESS_GROUP|DETACHED_PROCESS`，kill 用 `taskkill /T /F /PID`（树杀）或 `proc.kill()`；`_terminate_group` 平台分支。

### W-04：🔴 entrypoint 逃逸守卫在 Windows 被 `/xxx` 形式路径绕过（安全）
- 轮次与用例：R13 1.4 `test_entrypoint_absolute_outside_workdir_rejected`（DID NOT RAISE）
- 位置：`routers/execute.py` `_ensure_entrypoint_in_workdir`（~L194）
- 现象：`Path('/etc/passwd').is_absolute()` 在 Windows 上为 **False**（ntpath：无盘符不算绝对），且无 `..` parts → 守卫放行；实际 `cmd.exe /c /etc/passwd` 会以 work_dir 相对路径解析。同文件 `run_task` 的 executionId 穿越守卫（L412）用 `startswith(base+os.sep)` 同样依赖 ntpath 语义，`/etc/passwd` 类输入在 Windows 上 resolve 成 `C:\etc\passwd` 仍会被判为穿越，问题较小，但 entrypoint 守卫是明确绕过。
- 复现步骤：runtime=shell、entrypoint=`/etc/passwd` 提交任务 → 不返回 400。
- 严重级：功能不可用+安全缺陷（R4 安全模型在 win32 弱化）。
- 修复方向：绝对性判定补 `entrypoint.startswith(('/','\\'))`；跨平台 `os.path.isabs` 不够，用显式前缀检查。

### W-03：🧪 executor-node 5 个 jest 失败=测试 POSIX 假设（生产代码已有平台分支）
- 轮次与用例：R13 1.3
- 明细：
  1. `killRunningTaskProcesses › ...(POSIX)`、`app-stop kills the app process group (POSIX)`：断言 `process.kill(-pid,'SIGKILL')` 负 PID 进程组调用；win32 生产代码走 TerminateProcess 回退，不产生该调用——用例未跳过 win32；
  2. `versioned deployment paths` ×2：期望 `/tmp/work/apps/...` 正斜杠拼接；`buildDeploymentPaths` 用平台分隔符（win32 返回 `\tmp\work\...`）——断言应改用 `path.join`；
  3. `npm install subprocess env is whitelisted too`：断言找 `spawn` 调用且 `cmd==='npm'`；生产代码 win32 正确用 `npm.cmd + shell:true`（deploy.ts:92-96）——测试应匹配平台命令名。
- 严重级：仅测试；不修会永久压住 Windows CI 基线。
- 修复：三处用例平台化（`process.platform==='win32'` 分支断言或双预期）。

### W-05：🧪 executor-python 测试断言 Windows 不适配（非生产 bug）——修复进度
- `test_child_process_env_isolation`、`test_task_params_injected_as_env_vars`：`subprocess.run(['python3', ...])` → Windows exit 9009（无 `python3` 命令，Store stub 占位）；应改 `sys.executable`。
- `test_build_shell_cmd_uses_positional_params`：断言 `['bash','-c',...]`；win32 生产分支返回 `['cmd.exe','/c',...]`（execute.py:156-158）——应平台化断言。
- shell 任务执行类用例（`test_shell_task_runs_normal_entrypoint`、`test_shell_glue_script_executes`、log-cap/timeout/truncation 三例）：脚本内容为 POSIX bash 语法（`#!/bin/bash`、`seq`、`for`），win32 下经 cmd.exe 执行预期失败（R-09 范畴）——测试应改用跨平台入口（如 `python -c` 或按平台生成脚本）。
- ✅ W-02/W-04 修复后复跑：**12 失败 → 8 失败**；setsid 报错全消；`test_run_task_*` 回调三例与 `test_entrypoint_absolute_outside_workdir_rejected`（W-04 守卫）已转绿。剩余 8 例均属本条测试平台化范畴（另见新记录 W-09）。

### W-09：⚠️ win32 cmd.exe 分支丢失 work_dir 上下文 + pytest 复跑出现 "Event loop is closed" 噪音
- 轮次与用例：R13 1.4 修复复跑（W-02 后新证据）
- 现象 A（生产）：`_build_shell_cmd` 的 win32 分支返回 `['cmd.exe','/c',entrypoint]`，而 POSIX 分支显式 `cd "$1"`。当前 run_task 以 `cwd=work_dir` spawn，相对路径 glue 可解析；但 git 部署链/绝对 entrypoint 场景 cmd.exe 的 CWD 依赖隐式继承——与 POSIX 分支的显式 cd 语义不对称，记录待 R14 真实链路验证（2.2 shell glue 任务）。
- 现象 B（测试噪音）：修复复跑尾部出现 `RuntimeError: Event loop is closed` resource warning（asyncio.run 反复起停 loop + Windows ProactorEventLoop 清理时机），不影响计数但会随 R15-3.5 Windows CI 固化——评估是否需在测试 fixture 统一 loop 关闭策略。

### W-06：ℹ️ admin-web vitest 首跑 1 例 flaky（复跑 35/35）
- 首跑 34/35，同命令复跑 35/35；未留下失败用例名。R15 Windows CI job 建立后观察是否复现（jsdom/计时类概率）。

### W-07：ℹ️ mcp-server `--help`/`--version` 先打 `AUTOCODEFLOW_API_TOKEN is not set` WARNING
- R11 修复的 bin 分支存在，但 token 告警在 parse 之后、help 输出之前无条件打——`--help`/`--version` 属"纯查询"路径，不应告警。体验级。

### W-08：ℹ️ Python 测试依赖不在 requirements.txt（Linux 侧手动装的隐性状态）
- `apps/executor-python/requirements.txt`、`apps/registry-pypi/requirements.txt` 均无 pytest/pytest-asyncio；Windows 全新环境按 README 装完无法跑测试。补 `requirements-dev.txt`。

### W-10：ℹ️ cmd.exe 子进程输出为 GBK（936），executor 按 UTF-8 解码
- 轮次与用例：R13 修复期附带观察（风险点 R-11/R-12 同源）
- 现象：`cmd.exe /c` 的中文报错字节为 GBK（0xb2 等），两侧 executor 均以 UTF-8+`errors='replace'` 解码 → 不崩但非 ASCII 输出会乱码。生产任务多为 node/python（自报 UTF-8），影响面小。
- 处置：记录为体验项；如需彻底解决应 win32 下按 `GetOEMCP`/chcp 探测解码，或任务脚本统一要求 UTF-8——留待产品决策，不在本轮强行改。

### R14 结果（真链路冒烟，2026-09-05）

| 用例 | 结果 | 证据 |
|---|---|---|
| 2.1 executor-node 手动启动+注册 | ✅ | `Registered to admin-api (runtimes: shell,node,python)`；GET /api/executors → `online` |
| 2.2 手动任务全链 | ✅ | node/python **glue**（无 glueLanguage）/shell/batch 四类全 success，日志回读正常；shell 修复见 W-11 |
| 2.3 固定节奏 15s×2min | ✅ 超预期 | 9 次全 success，gap 均值 15.007s，min 14.994 / max 15.016（验收 ±1s，实测 ±0.02s） |
| 2.4 超时 kill + 孙进程 | ✅ | timeout=10s 死循环任务：`Task timeout after 10s`；4 个 detached 孙进程 `setTimeout(600000)` 计数 kill 后=0（**P-7 taskkill /T /F 树杀实证**）；槽位释放（re-trigger 成功） |
| 2.5 401 自愈 + reload-config | ✅ | rotate-token 后下一心跳即 `Idempotent token reuse (same startupId)`（N4/N50 冷缓存语义，无 401 风暴）；轮换后新任务全链 success；`POST /executors/:id/reload-config` → `{success:true, updatedFields:[taskTimeoutSeconds]}` |
| 2.6 日志/磁盘回收 | ✅ | 执行器**活进程持有句柄**时跨进程 `deleteOldLogs(0)` 成功删除当日目录，无 EBUSY（`fs.rmSync(force)` OK） |
| 2.7 中文+空格 WORK_DIR | ✅ | `WORK_DIR=C:/测试 目录/af` 下 node/python/batch 三类任务全 success + 日志回读 |
| 2.8 Playwright e2e | ✅ 16/16 → **29/29** | **W-12**：任务书所指 29 例为 Linux 侧未跟踪根级文件（后由 Linux 侧提交入库）；先跑仓内 `e2e-full.spec.cjs` 16 例（首跑 15/16 → 修 W-13 后 16/16）；W-12 入库后 Windows 首跑 29 例遇登录节流级联 429 → 揪出 W-22/P-16 修复，纯 `.env` 栈 **29/29** 全绿（2.4min） |
| 2.9 优雅退出 | ✅（经 W-14/15 修复后） | 详见 W-14/15 |

### W-12：⚠️ e2e 29 例基线为 Linux 侧未跟踪文件，Windows/CI 不可复现（流程债，已修）
- 轮次与用例：R14-2.8
- 现象：R9-R11 验证报告使用的根级 `e2e-full.spec.js`（29 例）+ `playwright.e2e.config.js` 是 C-agent 未跟踪产物（VERIFY-round9/11 明文记录），仓库只跟踪 `apps/admin-web/e2e-full.spec.cjs/.js`（16 例版）。Windows 新 clone 即无 29 例基线。
- 严重级：流程债（测试资产未入库）。
- 建议：把 29 例版纳入仓库（或在其原始机器提交），否则 R15-3.5 Windows CI 只能固化 16 例基线。
- 修复（Linux 原始机器）：根级 29 例版 + `playwright.e2e.config.js` 入库（`.gitignore` 撤销忽略）；test#16 移植 W-13 修复（`request` fixture + 鉴权 `GET /api/metrics`）。运行：`cd apps/admin-web && NODE_PATH=$(pwd)/node_modules npx playwright test --config=../../playwright.e2e.config.js`（前置 admin-api:3105 + admin-web:5176；`--list` 实测枚举 29/29）

### W-13：🧪 16 例版 test#16「Prometheus 指标端点」断言路径错误（跨平台测试 bug，已修）
- 原实现 `page.goto('http://localhost:3105/metrics')`——实际端点是 **`/api/metrics` 且带 JwtAuthGuard**（metrics.controller.ts R7）。旧路径 404，任何平台都拿不到指标。
- 修复：.cjs/.js 两副本同步改为带 globalSetup token 的请求式断言（200 + `# HELP`/`autoflow_` 前缀）。复跑 16/16。
- 另记：`.cjs`/`.js` 双副本并存易发散（.js 因 type:module 不可被 .cjs 配置加载），长期应删一留一。

### W-14：🔴 Windows 下任务进程与执行器共享控制台——Ctrl+C/Break 直杀任务、绕过优雅收割链（已修 P-9）
- 轮次与用例：R14-2.9（风险点 R-08/R-03）
- 取证：执行器带运行中任务收 CTRL_BREAK：gracefulShutdown 正常进入（W-15 修复后日志链完整），但任务的 `node.exe` 直接子进程**先于**执行器被控制台事件杀死（`exit 0xC000013A`，close 事件令 runningCount 归零），其自己 spawn 的 detached 孙进程树因此逃过 `killRunningTaskProcesses` 全部泄漏（实测 4 孙存活）。
- 根因：`runProcess` spawn 时 win32 分支 `detached:false` → 子进程继承执行器控制台，控制台 Ctrl 事件广播给所有附加进程。Linux 无此问题（detached:true 独立进程组）。
- 修复（P-9）：任务 spawn 加 `windowsHide:true`（CREATE_NO_WINDOW，独立隐藏控制台）→ Ctrl 事件不再波及任务，收割权交还 gracefulShutdown 链。

### W-15：🔴 executor-node/executor-python/admin-api 未注册 SIGBREAK——Windows 唯一可达的优雅退出信号被忽略（已修 P-10）
- 取证：未修前 CTRL_BREAK 使进程**立即**以 0xC000013A 退出，零条 graceful 日志。
- 平台语义（R-08 结论）：`taskkill`（无 /F）对控制台程序**完全无效**（"只能强行终止"）；`taskkill /F` = TerminateProcess，不跑任何 handler。Windows 上可达的优雅信号只有控制台事件：Ctrl+C→SIGINT（前台有效）、Ctrl+Break→**SIGBREAK**（对后台/新进程组唯一可用）。Node 需显式 `process.on('SIGBREAK')`。
- 修复（P-10）：executor-node `main.ts` 注册 SIGBREAK→gracefulShutdown（复验：`Received SIGBREAK → Waiting → offline → shutdown complete`，exit 0x0）；admin-api `main.ts` SIGBREAK→app.close()；executor-python `main.py` getattr 守卫注册 SIGBREAK。
- 部署文档要点（R15-3.6 落笔）：Windows 服务化必须用 NSSM/任务计划程序「停止任务」（转发 Ctrl+C）而非 `taskkill /F`，否则运行中任务树必泄漏。

### 测试环境污染记录（非 bug）
- pytest 复用同名 tmp 目录（`pytest-of-<user>/pytest-N`）+ `git_checkout_to` 的 salted `.git_cache` 以 src 绝对路径哈希命名——当上一次运行被强杀留下半成品 cache 目录时，后续运行会确定性 `clone rc=128`（本轮曾复现 1 例，清空 temp 后 4/4 过）。Linux CI 每次 fresh /tmp 不受影响；建议（低优先）：`git_checkout_to` 的 clone 失败清理路径已有 rmtree，但 `cache_dir.exists()` 为真而目录非有效 bare repo 时无自愈——留作后续加固项。✅ **已加固（W-23/P-17）**：探针+隔离+重克隆自愈落地后，此类残留会被自动隔离为 `-broken-<ts>` 并重新克隆（python 侧同名测试直接覆盖该场景，不再需要手工清 temp）。

---

## 修复落地（R15 前置，Windows 侧主导，同日完成）

> 修复中发现的**额外生产缺陷**（超出 R13 原始 8 项）一并记录：

### 生产代码修复
| # | 修复 | 位置 | 说明 |
|---|---|---|---|
| P-1 | W-02a：`preexec_fn=os.setsid` → `_spawn_kwargs_for_platform()`（win32 用 `CREATE_NEW_PROCESS_GROUP\|DETACHED_PROCESS`） | `executor-python/routers/execute.py` | 阻断修复 |
| P-2 | W-02b：超时 kill win32 分支 `taskkill /T /F /PID` 树杀 + `proc.kill()` 包 `ProcessLookupError` 守护（修后新发现的二次崩溃：tree-kill 已收割子进程再 kill 抛错） | 同上 | 阻断修复 |
| P-3 | W-02c：venv 布局 `bin/python` → 平台分支 `Scripts\python.exe`（requirements 任务专用） | `ensure_venv` | **R13 测试全 mock 未暴露，修复期人工审查发现** |
| P-4 | W-02d：无 requirements 的 python runtime `['python3', ...]` → `[sys.executable, ...]` | `run_task` L549 | 同上——**python glue 任务在 Windows 全挂的真实原因** |
| P-5 | W-04：entrypoint 逃逸守卫补 `startswith(('/','\\'))` 判定（win32 上 `Path('/etc/passwd').is_absolute()===False` 的绕过） | `_ensure_entrypoint_in_workdir` | 安全修复，`test_entrypoint_absolute_outside_workdir_rejected` 转绿 |
| P-6 | W-09a：`_build_shell_cmd` win32 分支归一化 POSIX 风格入口（剥 `./`、`/`→`\`）——实测 `cmd.exe /c ./hello.bat` 报「'.' 不是内部或外部命令」 | `routers/execute.py` | 测试期实测发现 |
| P-7 | R-03 增强：`killProcessTree` win32 分支从「仅杀父进程（文档化限制）」升级为 `taskkill /T /F` 树杀，`killRunningTaskProcesses` 委托给它，与 python 侧语义对齐 | `executor-node/src/run-command.ts`、`routes/execute.ts` | 消除孙进程残留风险（R14-2.4 将实测验证） |
| P-8 | W-07：mcp-server token WARNING 从 api.ts 模块副作用移入 `main()`——`--help`/`--version` 输出恢复干净 | `packages/mcp-server/src/{api,index}.ts` | 61/61 vitest 通过 |
| P-9 | W-14：任务 spawn 加 `windowsHide:true`——win32 控制台 Ctrl 事件不再直接杀死任务进程、绕过优雅收割链 | `executor-node/src/routes/execute.ts runProcess` | 2.9 实测修复链完整 |
| P-10 | W-15：三端注册 SIGBREAK（executor-node 优雅链 / admin-api app.close / executor-python 守卫式）——Windows 后台部署唯一可达的优雅退出信号 | `executor-node/src/main.ts`、`admin-api/src/main.ts`、`executor-python/main.py` | 实测 `Received SIGBREAK→shutdown complete` rc=0x0 |
| P-11 | W-11：shell glue 缺 glueLanguage fallback（400）+ win32 glue 文件名 `.cmd` 化（`.sh` 经 cmd.exe 挂死）| executor-node/executor-python | 2.2 shell 两类转绿；python glue 用例从 skip 恢复双平台实跑（**125/125，0 skip**） |
| P-12 | W-17：executor-desktop `ExecutorProcess.stop()` win32 分支——`child.kill('SIGTERM')` 在 Windows 是 TerminateProcess（不跑执行器优雅链且漏杀任务子进程），改 `taskkill /T /F` 树杀；POSIX 保持 SIGTERM→8s→SIGKILL | `apps/executor-desktop/src/main/executor-process.ts` | desktop tsc ✓；before-quit 链路复用 stop() |
| P-13 | W-19：两侧任务 env 白名单补齐 Windows 系统+home/identity 变量族（python 侧此前零 Windows 变量；node 侧缺 home 族），附双侧白名单安全测试 | `executor-node/src/env-whitelist.ts`、`executor-python/routers/execute.py` | node 161 / python 126；真链路 homedir/getuser 实证 |
| P-14 | W-20a：node `buildChildEnv` win32 大小写不敏感匹配 + 按规范键转发（POSIX 保持精确匹配） | `executor-node/src/env-whitelist.ts` | env-whitelist.spec 双分支测试；node 162/162 |
| P-15 | W-20a：python 侧 `_build_child_env()` 同语义（python os.environ 在 Windows 大写归一，混拼白名单项此前永不命中） | `executor-python/routers/execute.py` | 新双分支测试；python 127/127 |
| P-16 | W-22：main.ts 预载 `.env` 后再动态引入 app.module——装饰器求值期读取的 env（LOGIN_THROTTLE_LIMIT）从死配置变真可配；同批 W-21 requirements 全栈接通（实体 jsonb+迁移/DTO 校验/normalize 防线/snapshot/admin-web 表单） | `admin-api/src/main.ts` + task 模块 + admin-web | 25 连登 0×429；29 例 e2e 纯 .env 跑 29/29；admin-api 884 零回归 |

| P-17 | W-23：git clone 缓存脏目录自愈——node/python 两实现统一"探针（HEAD+`rev-parse --is-bare-repository`）→ 损坏则**改名隔离**（`-broken-<ts>`，避 Windows 句柄锁+留现场）→ 重克隆"；node 版补齐 clone 失败清理（原缺） | `executor-node/routes/execute.ts`、`executor-python/routers/execute.py` | node 163 / python 128（各 +1 自愈用例，python 用真实 git 验取证保留） |
| P-18 | W-24：三处 spawn 站点（runProcess/runCommand/startApp）补 stdio socket error 守卫——spawn 失败不再崩整个执行器；ENOENT+超长 cwd 附 MAX_PATH 提示 | `executor-node/src/routes/execute.ts`、`run-command.ts`、`routes/deploy.ts` | W-24 回归用例 + 164/164；真实长路径复跑执行器存活（崩溃栈消失） |
| P-19 | W-25：main.ts unhandledRejection/uncaughtException → fatalShutdown（gracefulShutdown 链 + exit(1) + 45s 硬退出保险）；gracefulShutdown 增 exitCode 参数 | `executor-node/src/main.ts` | tsc/164 绿；语义对齐 admin-api OPS-06 |
| P-20 | W-26：download 部分文件清理重构——`removePartialFile(file,dest,expectFile)`：立即尝试 + 流 `close` 事件 + ENOENT/EBUSY/EPERM 有界轮询（ENOENT≠已清理，文件可能晚于 unlink 出现），不门控 promise；redirect-continue 用 expectFile=false 防与递归下载抢删；redirect 分支 destroy() 替代 close()（防双跟随）+ res.resume() 排空 | `executor-node/src/lib/download.ts` | download.spec 9×5/5、全量 164/164；redirect 2-hop 断言哨兵；Linux 晚建竞态由 ubuntu CI 终审 |

### 测试平台化修复
- executor-node（W-03）：POSIX kill 两例 → 平台分支断言（win32 验 taskkill spawn + proc.kill）；`versioned deployment paths` 两例 → `path.join` 构造期望；npm 白名单例 → 按平台找 `npm.cmd`/`npm`。**158/158 全绿（连跑 3 次稳定）**。
- executor-python（W-05，经 W-11 修复后最终形态）：`python3` → `sys.executable`（两例）；`_build_shell_cmd` 断言平台化并新增 W-09a 归一化覆盖；shell 执行例改平台原生脚本（win32 `.bat`/glue `.cmd`，**不再 skip**）；log-cap/timeout/truncation 三例从 POSIX 循环脚本改为 python runtime 生成等价输出。**125/125 全绿（0 skip）**。
- W-08：两项目新增 `requirements-dev.txt`。

### 环境记录（非代码问题）
- W-06 补充：executor-node `health.spec.ts` 与 admin-web 各出现 1 次并行负载下的偶发失败，单独/复跑均绿（3 次全量复跑 158/158）。Windows CI 若抖动可考虑 `maxWorkers: 1` 或对计时敏感用例加宽限。
- Redis requirepass 为本机既有配置，已写入 `apps/admin-api/.env`（未入库）。

## R16 executor-desktop Windows 打包结果（2026-09-05）

| 用例 | 结果 | 证据 |
|---|---|---|
| 4.1 打包链 | ✅ **路线图 #12 收口** | `build:executor`（ncc，bash 链在 Git-Bash 下可用）→ `build:main`（tsc）→ `build:renderer`（vite）→ `electron-builder --win nsis --x64` **全链首跑即通**；产出 `AutoCodeFlow Executor Setup 1.0.0.exe`（100.6MB，NSIS 未签名，electron-builder 默认自签 elevate.exe） |
| 4.2 产物冒烟 | ✅✅ | **win-unpacked 直跑**：4 进程存活、`App ready → Tray initialized → Wizard window opened`；**NSIS 安装级**（本轮补）：`Setup.exe /S` 静默装→`%LOCALAPPDATA%\Programs` 布局含 `resources/executor-node`+`resources/assets`（三态托盘图标）→安装版 exe 启动 5 进程无异常→`Uninstall /S` 干净移除；**内置 executor 独立冒烟**：node 直跑 bundle → admin 注册 online → 真实任务 success + 日志回读 |
| 4.3 与手动路线差异 | 见 W-16/17 | 功能等价；差异：① 托盘/窗口交互需 GUI 会话（服务化部署仍以手动/计划任务路线为主）；② 停止链路 win32 语义不同（W-17 已修）；③ 配置由 electron-store/向导承载而非 .env |

### W-16：✅ `assets/` 图标缺失（销账）——托盘 PNG 由并行会话入库（95363aa），应用图标 `icon.ico` 由本轮从 icon.png 生成
- 原始问题：electron-builder.yml 引用 `assets/`（`icon.ico`/`tray-*.png`）但目录不存在 → 打包回退默认 Electron 图标、托盘空白（有 fallback 不崩）。
- 关闭路径：① `95363aa`（Linux 侧）提交 icon.png(1024²) + tray 三态 @2x PNG，并修 .gitignore 全局 `*.png` 误伤的反白规则；② **本轮（Windows 侧）**发现 `win.icon: assets/icon.ico` 仍缺（构建日志继续报 default Electron icon）——用零依赖生成器把 icon.png 缩放 256² 后按 Vista PNG-in-ICO 格式封装为 `assets/icon.ico`（派生自既有设计源，非虚构素材），重打 NSIS **不再出现回退警告**，安装包内 `resources/assets/` 齐全。
- 残留（非 Windows 面）：~~mac 构建仍需 `icon.icns`~~ **已补**（本轮）：`icon.icns` 由同一 icon.png 派生（标准 icns 容器，ic07/08/09/10 = 128/256/512/1024 PNG entries，结构校验通过）。图标三格式（png/ico/icns）现均为 icon.png 的生成产物——长期建议把生成脚本入库（本轮为一次性生成），或由设计侧维护。

### W-23：⚠️ git clone 缓存脏目录无自愈（Windows 强杀语义放大）——已修（P-17，双侧对称）
- 轮次与用例：R13 待复验清单遗留项（Windows 侧自主推进）
- 现象（修复前）：clone 中途被强杀（`taskkill /F`、OOM）留下半成品 `.git_cache/<salted>` 目录时——python 版判据 `cache_dir.exists()` 视其为有效缓存 → 后续每次 checkout 走 `fetch --all` 对残缺 repo 失败，**永久失败无自愈**；node 版判据 `exists(HEAD)` 略好（半成品多无 HEAD → 走 clone 分支），但 `git clone` 对"存在且非空"目录直接报错，同样**每次重试必炸**，且 node 版 clone 失败还不清理残留。R14 实证过 taskkill 是 Windows 常规停服手段（无 SIGTERM），该场景在 Windows 上远比 Linux 常见。
- 修复（node/python 同一语义）：① 缓存有效性探针 = `HEAD` 存在 + `git rev-parse --is-bare-repository` 为 true（HEAD 前置检查兼防 rev-parse 上溯到外层无关仓库）；② 损坏时**改名隔离**为 `<dir>-broken-<ts>` 而非删除——保留取证状态，且 Windows 下刚被杀进程的文件句柄可能仍锁目录，rename 比 rmtree 更不易二次失败（rename 失败才兜底 rm）；③ 隔离后走正常重克隆；④ node 补 clone 失败清理（与 python 对齐）。真正的"部分完成但 fetch 可修复"的仓库（对象不全但结构完整）探针判有效，由 fetch 补全——符合既有设计。
- 测试：node +1（mock 驱动：探针→隔离→clone→checkout 序列与 `-broken-` 后缀断言）；python +1（**真实 git**：伪造 HEAD+垃圾对象目录 → 自愈成功检出文件 + 断言 `-broken-` 隔离目录保留取证）。基线：node 163 / python 128。

### W-17：🔴 desktop 停止链路 win32 语义失效（已修，P-12）
- `ExecutorProcess.stop()` 原依赖「executor-node 监听 SIGTERM 优雅退出」——Linux 成立；Windows 上 `child.kill('SIGTERM')`=TerminateProcess，执行器优雅链不执行、其任务子进程树整体遗留。修复后 win32 用 `taskkill /T /F` 树杀（POSIX 路径不变）。

### W-18：ℹ️ 生成物 prebuilt bundle 被 git 跟踪（漂移风险）——已由 CI 守卫闭环
- `apps/executor-desktop/resources/executor-node/index.js` 在库中跟踪（desktop `extraResources` 依赖其存在）。原建议 gitignore+构建生成，但会破坏"clone 即用"且 desktop 打包链需额外前置。
- **最终方案（更优）**：`ci.yml` 新增 `desktop-bundle-drift` job——离线重打 bundle（与 `scripts/bundle-executor.sh` 同参数）+ `git diff --quiet`，产物与源码不同步即红。前提**已在 Windows 侧验证**：ncc 0.44.0 产物字节确定性（同源码+同参数含 `--source-map` 输出与已提交文件逐字节一致；禁网可跑、`npm ci --ignore-scripts` 免 electron 二进制下载、输出目录不影响产物、`.map` 残留被 ignore 覆盖不误报脏树）。人工重打纪律自此由机器把关。

### W-19：⚠️ R-04 专项收口——两侧任务 env 白名单不对称，python 侧完全缺 Windows 变量族（已修+双端实证）
- 轮次与用例：R15-3.4 深挖（原风险点 R-04「已含 SYSTEMROOT/WINDIR/COMSPEC/PATHEXT」仅对 executor-node 成立）
- 现象：`executor-python/routers/execute.py` 的 `_ENV_WHITELIST` 无任何 Windows 变量；两侧都缺 home/identity 族（USERPROFILE/HOMEDRIVE/HOMEPATH/USERNAME/APPDATA/LOCALAPPDATA/ProgramData）。
- 实测影响（净化 env 子进程）：`os.path.expanduser('~')` 返回字面 `~`、node `os.homedir()` 失效、`getpass.getuser()` 抛 `KeyError: USERNAME`、pip/npm/uv 缓存与 git 用户配置定位全部退化——**真实 Windows 服务/计划任务部署（无 HOME）下用户任务会踩雷**；本机测试因 Git-Bash 注入 HOME 恰好掩盖。
- 修复：两侧白名单补齐同一 Windows 集合（与已放行的 USER/LOGNAME/HOME 同类，仅路径/身份，非机密；SECRET 三件套仍恒拒）。node 新增 `env-whitelist.spec.ts`（3 例：集合完整性/正向转发/ denylist 压制），python 新增 `test_env_whitelist_windows_parity_surface`。**基线更新：node 161、python 126。**
- 真链路实证（修复+重启后）：node 任务 `homedir: C:\Users\12154 / USERNAME: 12154 / LOCALAPPDATA ✓`；python 任务 `home: C:\Users\12154 / user: 12154 ✓`。

### R14 补充：executor-python Windows 真链路首次验证（6/6，2026-09-05）
> R14 原计划只冒烟了 executor-node——本轮补上 python 执行器（uvicorn/ProactorEventLoop R-10 面）。
- uvicorn 启动/注册/心跳/优雅下线：正常；端口 bind 失败时启动链的 graceful shutdown（offline 通知+退出码干净）被意外实证一次。
- 任务电池（直连或经 admin pinned 分发）：① python glue success（P-4 真链路 + `AUTOFLOW_CALLBACK_TOKEN` 注入 True，N33 Windows 成立）；② shell batch glue success（W-11 .cmd）；③ requirements 任务直连 `/execute`：`uv venv` 真实建 venv + `Scripts\python.exe` 解析 + httpx 0.28.1 安装运行 success（**P-3 真链路**）。
- ℹ️ 顺带发现（跨平台产品面，非 Windows）：admin-api 的 CreateTaskDto/dispatch 均不携带 `requirements`——executor 侧 venv 能力经 UI/API 正常链路不可达，只能由直连执行器或后续 manifest 特性触发。记作功能缺口，待产品决定是否接通。

### R-06 长路径结论（实测，2026-09-05）：node fs 能走长路径、CreateProcess 不能；衍生出 W-24
- 现场：本机 `LongPathsEnabled=0`（注册表未开，Win11 25H2 实测默认也未开）。
- 分层实测：`fs.mkdirSync`/`writeFileSync` 在 266/276 字符路径 **OK**（libuv 内部自动加 `\\?\` 前缀）；但 `spawn(cmd,args,{cwd:>260})` **失败**（CreateProcess 的 lpCurrentDirectory 无长路径支持，报 ENOENT/WinError 267）；python 进程连 listdir 长路径都看不到。
- **结论**：executor 的 workdir/日志用长路径本身可行，**把长路径作为任务进程 cwd 不可行**（OS API 层限制，代码无绕过手段——`\\?\` 前缀对 CreateProcess cwd 同样无效）。运维要求：WORK_DIR + executionId 拼接后保持 <260 字符，或在主机启用 `LongPathsEnabled`（组策略/注册表，重启生效）；已写入 deployment.md Windows 章节。python 执行器实测同源（WinError 267 被 generic except 捕获，干净失败）。

### W-24：🔴 spawn 失败经 stdio socket 未捕获 'error' 崩掉整个 executor-node 进程（任意 ENOENT 触发，长路径只是引子）——已修三站点+回归测试
- 触发面（Linux/Windows 通用，Windows 更易踩）：任务可执行文件不在 PATH、cwd 不存在/超限、EACCES…任何 `child_process.spawn` 失败。
- 机制：spawn 失败时 node 在 stdio **Socket** 对象上 emit 'error'（除 ChildProcess 的 error 事件外）。`runProcess`/`runCommand`/`deploy.startApp` 只挂了 `data`（或 `.pipe`）与 ChildProcess 级 `on('error')`——socket 上的 error 无监听 → uncaughtException → **整个执行器崩溃，连带所有在跑任务**。R-06 长路径实测中该签名（`read ENOTCONN` 栈）首次暴露。
- 修复（P-18）：三处 spawn 站点统一补 `child.stdout?.on('error', noop)`/`stderr` 守卫（失败路由回 ChildProcess 'error' → 单任务失败）；runProcess 的 ENOENT 且 cwd>259 时错误信息追加 `MAX_PATH/LongPathsEnabled` 提示（把不可读的 ENOENT 变成可定位的运维线索）。
- 验证：新回归用例（伪造 stdio socket error + 无监听即抛的 EventEmitter 语义，修复前必红）；全量 164/164；真实长路径复跑执行器存活（原崩溃栈消失）。executor-python 排查无同源问题（asyncio spawn 异常走 `await`，被 generic `except Exception` 捕获）。

### W-25：⚠️ executor-node 缺 unhandledRejection/uncaughtException 兜底（admin-api 有 OPS-06/ARCH-008，执行器没有）——已补（P-19）
- W-24 修复中意识到：三处 stdio 守卫只是移除了已知崩溃源，**兜底层**仍缺失——任何未来的意外异步错误依旧默认裸崩，绕过 gracefulShutdown → 任务进程树按 W-24 同款方式泄漏。
- 修复：`main.ts` 注册两类处理器 → `fatalShutdown()` 统一路由：记 FATAL 日志 → 走既有 gracefulShutdown（drain+树杀，新 exitCode 参数以 **exit(1)** 退出供监督重启）→ 45s 硬退出保险（graceful 自身 30s grace + 收尾裕量），`hardExit.unref()` 不拖住正常退出。gracefulShutdown 加 `exitCode=0` 默认参，信号路径语义不变。

### W-26：⚠️ download 包"部分文件清理"在 Windows 必漏（fd 关闭竞态）+ redirect 用 close() 有双跟随时序陷阱——已修（P-20）
- 暴露方式：W-25 后全量 jest 出现**确定性**的 `rejects HTTP error statuses and cleans the partial file` 失败（此前只在并行负载下偶发，被当成 W-06 类 flaky 记账）——追根因是生产缺陷而非测试抖动。
- 根因（两处，第一版修复只解了 A，被 ubuntu CI 抓出 B 后二次修正）：
  - **A（Windows）**：`fail()` 里 `file.destroy()` 后**立即** `fs.unlink`——写流 fd 还在异步关闭，unlink 吃 EBUSY/EPERM，而回调 `() => {}` 静默吞错 → **残件永久滞留 work_dir**（每次下载 404/超时/超限攒一个），404 清理用例负载下必红。
  - **B（Linux，CI executor-node-test 首跑抓出）**：`createWriteStream` **懒开文件**——首写在事件循环里排队，byte-cap 用例在首个 data 回调即 fail()：`unlinkSync` 扑空 ENOENT 直接"自认干净"，随后挂起的 open/write **把文件建了回来** → 残件泄漏。原异步 `fs.unlink` 恰好因排队延后被掩盖，改 `unlinkSync` 后暴露。**教训：ENOENT ≠ 已清理，unlink 竞态要按"文件可能晚于 unlink 出现"建模。**
- 最终形态（P-20，两次迭代收敛）：`removePartialFile(file, dest, expectFile)`——立即尝试 + 订阅流的 `close`（fd 释放、文件必然已显形）再试 + ENOENT/EBUSY/EPERM 40ms×10 有界轮询（`expectFile=true` 用于 fail 路径；**redirect-continue 路径 `expectFile=false`**：ENOENT 即停，绝不与紧随其后的递归下载在同一个 dest 上抢删除——那是"清理旧件"与"新件落地"两个生命周期，必须分开）。清理**不门控任何 promise**（deploy/update-package 套件的 mock fs 回调不触发，门控即挂起——第一版正是栽在这里）。
- 副作用修复（一并记录，我重构过程中捕获）：redirect 分支 `close()` 会让仍挂着的 `res.pipe(file)` 触发 data-after-end 'error' → 二次进入错误处理**双跟随重定向**；改 `destroy()` + `res.resume()` 排空。`keeps the token for same-host redirects`（seen 精确 2 元素）自此成为双跟随哨兵。
- 验证：download.spec 本地 9 连 5/5；全量 164/164；byte-cap 的 Linux 晚建竞态以 ubuntu CI 为最终裁决（本轮已推）。
- ✅ **已接通（W-21，同日）**：admin-api 全栈补齐——Task 实体 jsonb 列（幂等迁移 AddTaskRequirements1788581485026）+ CreateTaskDto 结构校验（数组/非空元素/≤50，UpdateTaskDto 经 PartialType 继承）+ service normalize（trim + 拒 option 形 `-` 前缀，镜像执行器防线，坏 spec 创建即 400）+ **version snapshot 收录**（否则回滚丢依赖）+ dispatch 零改动（task 实体整体透传）；application manifest 路径此前经 `as any` 传入被静默丢弃，现已真实落库。admin-web：表单 `Select mode=tags` 输入（tokenSeparators 特意留空——pip spec 合法含逗号）、编辑回填、详情页展示、提交序列化 `applyRequirementsPayload`（空集显式 null——PATCH 缺省=保留旧值的 N28 教训）。测试：admin-api +11（884/884）、admin-web +5（40/40）。文档：sdk-guide 平台任务配置表新增 requirements 行。

### W-22：🔴 `.env` 对"装饰器求值期读取"的环境变量永不生效——login 节流（N16）名义可配实为死配置（已修）
- 轮次与用例：W-12 入库后 Windows 首跑 29 例 e2e（16/29 → 定性）
- 现象：批量从 ~case 17 起级联 429 `ThrottlerException: Too Many Requests`（`/api/auth/login`）；单独/小批跑全绿。`.env` 设 `LOGIN_THROTTLE_LIMIT=100000` **完全无效**，改 shell 环境变量注入才生效。
- 根因：`auth.controller.ts` 的 `@Throttle({limit: Number(process.env.LOGIN_THROTTLE_LIMIT) || 20})` 在**类定义求值（import 图阶段）**读取，而 `.env` 由 `ConfigModule.forRoot` 在**生命周期**才灌入 `process.env`——晚于读取点。故经 `.env` 文件配置实为死配置；docker `-e`/compose `environment:`（真实进程环境）不受影响，这也是生产容器化从未暴露的原因。
- 修复：`main.ts` 入口在引入 app.module 前 `dotenv.config()` 预载 `.env`，app.module 改动态 `await importAppModule()`——`.env` 与真实环境自此行为一致（25 连登 0×429 实证）。已扫描全仓：装饰器/import 期读 process.env 的仅此前一处。
- 连带结论：29 例 e2e 纯 `.env` 配置下复跑 **29/29**（Windows，我提交的 main.ts 变更后）；非我 W-21 表单改动的回归（修复前前 16 例含任务向导全绿已证）。

### W-20：🔴 env 白名单/测试对 Windows 变量大小写与盘符假设失效——**由 Windows CI job 首跑抓出**（已修，双侧）
- 轮次与用例：R15-3.5 固化后的首次真机 CI（run 33942184554，executor-node windows job 4 失败）
- 根因 A（生产级）：Windows 环境变量块**大小写不敏感**，真实主机/runner 拼作 `Path`/`Temp`/`PROGRAMDATA`；`buildChildEnv`（node）与 `{k in _ENV_WHITELIST}`（python）都是**精确匹配**→ 混拼键被静默丢弃，任务子进程拿不到 PATH，一切依赖 PATH 的运行时解析（npm/git/node/python）全断。**双重掩盖史**：ubuntu CI 无此语义；本机测试在 Git-Bash 下跑（PATH 被规范成大写）恰好全绿——这正是"Windows CI job 必须上真 runner"的实证注脚。
- 根因 B（测试级）：`deploy.spec` 两处直接落盘 `/tmp/acf-download-test-*.bin`——GH windows runner 检出于 D: 盘 → `D:\tmp` 不存在 ENOENT；本机因 E:\tmp 存在而通过。
- 修复（P-14/P-15）：
  - `executor-node/src/env-whitelist.ts` `buildChildEnv`：win32 大小写不敏感匹配、按白名单规范键（PATH/TEMP/…）转发；POSIX 保持精确匹配。`env-whitelist.spec.ts` 新增双分支行为测试（win32 归一/POSIX 隔离）。
  - `executor-python/routers/execute.py` 新增 `_build_child_env()` 同语义（python 在 Windows 的 os.environ 本身键大写归一，helper 同时修掉 `ProgramData`/`npm_config_cache` 这类混拼白名单项永不命中的问题）；`test_build_child_env_windows_case_insensitive` 双分支断言。
  - `deploy.spec.ts` 两处 `/tmp` 硬编码 → `path.join(os.tmpdir(), ...)`。
- 验证：node **162/162**、python **127/127**（各 +1 测试）；ubuntu 首版修复的测试自身在 Linux 上即错过一次断言（win32/POSIX env 大小写语义差异），已按语义修正；待 push 后确认双平台 CI 全绿。

#### 后续 CI 复盘注记
- 同 run 还暴露：任务书 W-16 的图标资源已由并行会话提交（`95363aa`，.gitignore `*.png` 全局排除误伤 assets 的反白修复一并带上）；本轮 W-20 修复推送后 windows 4 job 全绿。

### 提交后待复验清单（Linux/CI 侧 & R14）——2026-09-05 CI run 33943007134 **22/22 全绿，全部闭环**
- [x] executor-node 在 Linux 的 POSIX kill 用例路径未改动语义（分支仅 win32 生效）——ubuntu job 162/162 ✓
- [x] executor-python 在 Linux 跑 127（win32 专属分支在 Linux 自然不触发）——ubuntu job ✓；windows 侧同名测试走 win32 分支 ✓
- [x] R14-2.4 实测 taskkill 树杀后孙进程无残留（见 R14 表 2.4 行：kill 后 `setTimeout(600000)` 计数=0）
- [x] W-20 修复经 Windows runner 真机二次确认（run 55abf07 windows 4 job 绿 → c00d065 全 22 job 绿）

### W-27：✅ 29 例根级 e2e 接入 CI（原"待拍板"基建项，已落地）——2026-09-05 Linux 侧
- 背景：W-12 入库 + W-22 修复后，29 例 e2e 已双平台手工可复现（Linux 1.6m / Windows 纯 .env 栈 2.4m），但 CI 只覆盖 admin-api jest 级 e2e，真浏览器全链（登录/节流/CORS/派发/回调/pinned 全链/RBAC）无门禁。Windows 侧建议接入并留给拍板，用户转 Linux 侧推进落地。
- 落地形态：
  - `scripts/e2e-full.sh` 自包含编排（**CI 与本地同一入口**）：空库建库（时间戳库名，drop+create 幂等）→ admin-api nest build + 空库全迁移链 → admin-api(:3105) → executor-node(:8002，/health + 注册 online 双等待) → admin-web vite(:5176) → 根级 spec 29 例。子进程全部 exec 化 + trap 清理，组件日志落 `/tmp/acf-e2e-logs.*`。
  - `ci.yml` 新增 `e2e-full` job：PG16/Redis7 services + `SKIP_DOCKER=1` 复用同款 env（与 admin-api-test 节对齐）；失败上传日志/截图 artifact。CI 总 job 数 22 → **23**。
  - 防抖清单（全部来自前轮教训，一条不落）：① 每次全新库——admin seed/任务/执行记录零残留，断言不漂移（W-12 种子残留债）；② `LOGIN_THROTTLE_LIMIT=10000` + `THROTTLE_LIMIT=10000`——29 例 ~40 次登录 + API 轮询，默认 20/60 必级联 429（W-22 同根）；③ `EXECUTION_CALLBACK_SECRET` 两端显式同值——消 fallback 语义漂移；④ `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`——派发目标 localhost:8002 是回环，safe-http SSRF 守卫默认阻断（round-9 VERIFY 同款配置）；⑤ `no_proxy` 导出——本机代理（http_proxy）会劫持 curl/浏览器对 localhost 的健康检查致 502（CI 无代理不受影响，本地复现必踩）。
- 验证：本地 docker 模式 29/29（1.6m）+ SKIP_DOCKER 模拟 services 29/29（同 1.6m，CI 实际路径）；CI run 33962387214 **e2e-full job 29 passed (2.1m)，全 run 23/23 绿**（head 53db654）。
- 教训：`bash xxx.sh | tail` 会把退出码掩盖成 tail 的 0——后台跑编排脚本不要套管道，用文件重定向 + 显式 echo EXIT。
