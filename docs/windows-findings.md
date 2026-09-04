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

### W-05：🧪 executor-python 测试断言 Windows 不适配（非生产 bug）
- `test_child_process_env_isolation`、`test_task_params_injected_as_env_vars`：`subprocess.run(['python3', ...])` → Windows exit 9009（无 `python3` 命令，Store stub 占位）；应改 `sys.executable`。
- `test_build_shell_cmd_uses_positional_params`：断言 `['bash','-c',...]`；win32 生产分支返回 `['cmd.exe','/c',...]`（execute.py:156-158）——应平台化断言。
- 其余 9 例失败的根因是 W-02（setsid），修复 W-02 后需复跑确认（其中 log-cap/timeout/truncation 三例的脚本内容用 `seq`/`for` POSIX 语法，属 R-09"POSIX glue 在 Windows 预期失败"范畴——测试应改为跨平台脚本如 python -c）。

### W-06：ℹ️ admin-web vitest 首跑 1 例 flaky（复跑 35/35）
- 首跑 34/35，同命令复跑 35/35；未留下失败用例名。R15 Windows CI job 建立后观察是否复现（jsdom/计时类概率）。

### W-07：ℹ️ mcp-server `--help`/`--version` 先打 `AUTOCODEFLOW_API_TOKEN is not set` WARNING
- R11 修复的 bin 分支存在，但 token 告警在 parse 之后、help 输出之前无条件打——`--help`/`--version` 属"纯查询"路径，不应告警。体验级。

### W-08：ℹ️ Python 测试依赖不在 requirements.txt（Linux 侧手动装的隐性状态）
- `apps/executor-python/requirements.txt`、`apps/registry-pypi/requirements.txt` 均无 pytest/pytest-asyncio；Windows 全新环境按 README 装完无法跑测试。补 `requirements-dev.txt`。
