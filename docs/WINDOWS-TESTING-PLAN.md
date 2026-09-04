# Windows 深度测试任务书（R13-R16 路线）

> 背景：项目至今 12 轮全部在 Ubuntu（Linux x86_64）环境开发与测试，v1.0.1 已发布（npm `@autocodeflow/sdk` / `autocodeflow-mcp-server`、PyPI `autoflow-sdk`）。本文档供 **Windows 环境拉取仓库后的深度兼容验证**使用——逐轮任务、验收标准、已知风险点（附源码位置）与问题回传格式。
> 使用方式：在 Windows 机器上 clone 后按轮推进；每个 checkbox 完成打勾；发现的问题按文末模板记录到 `docs/windows-findings.md`（新建），回传后由 Linux 侧修复。

## 环境准备（R13 前置，一次性）

| 项 | 要求 | 说明 |
|---|---|---|
| OS | Windows 10 21H2+ / Windows 11 | 记录版本号 |
| Node.js | **24.x**（与 CI 对齐） | `node -v`；npm 11 |
| Python | **3.12.x** | `python --version`；建议 venv 隔离 |
| Git | 最新版 | `core.autocrlf` 建议 `input` 或 `false`（见风险 R-01） |
| Docker | Docker Desktop（WSL2 后端）或跳过 | admin-api 的 PG/Redis/MinIO 依赖；无 Docker 则用 WSL2 内起容器 |
| Playwright | `npx playwright install chromium` | **Windows 上首次必须单独装**（Linux CI 装的不通用，R11 在 Linux 都踩过） |
| 代理 | ⚠️ 清理 `HTTP_PROXY/HTTPS_PROXY` 或设 `NO_PROXY=localhost,127.0.0.1` | **已知坑**：R9-R11 真机验证时全局代理会劫持 localhost 调用返回 502，Linux 侧靠 `NO_PROXY='*'` 绕过 |

## 已知平台风险点（按代码审查，附源码位置——测试时重点盯）

| # | 风险 | 位置 | Windows 表现预期 |
|---|---|---|---|
| R-01 | 行尾 CRLF/LF | 全仓；`.gitattributes` 未配置 | clone 后若 `autocrlf=true`，`.py`/`.sh`/迁移文件可能被改写——jest/pytest 一般无感，但 **install.sh 必须保持 LF** |
| R-02 | install.sh 是 bash 脚本 + systemd unit | `scripts/install.sh` | **Windows 原生不可用**（systemd 不存在）；Git-Bash/WSL2 下可跑前几步但 `systemctl` 必失败——预期走"手动 node 启动"路线（R14 验证） |
| R-03 | 子进程树终止：process-group kill | executor-node R4 改造（process.kill 进程组） | Windows 无 POSIX 进程组，Node 回退 TerminateProcess 语义——**任务超时 kill 是否连带杀掉孙进程**是重点观察项 |
| R-04 | 环境变量白名单 | `apps/executor-node/src/env-whitelist.ts`（已含 SYSTEMROOT/WINDIR/COMSPEC/PATHEXT） | 任务子进程在 Windows 上是否缺关键系统变量（如 `APPDATA`/`ProgramData` 类未白名单变量被剥） |
| R-05 | 路径拼接与软链 | executor-node 部署链（release 目录 + current 软链）、日志路径 | Windows `mklink` 需权限；**软链 fallback 是否实现/生效** |
| R-06 | 长路径与特殊字符路径 | 日志/工作目录 | `WORK_DIR` 放深目录（>260 字符）+ 含空格/中文路径各测一次 |
| R-07 | 文件锁 | 日志轮转、BoundedLogBuffer、TTL 磁盘回收 | Windows 文件被进程占用时 unlink 报 EBUSY——日志清理与热更新路径重点盯 |
| R-08 | 信号处理 SIGTERM/SIGINT | 优雅退出链（OnModuleDestroy / before-quit） | Windows 下 Ctrl+C / taskkill /auto 到达路径不同——admin-api 与 executor-node 优雅退出是否完整 |
| R-09 | spawn shell 语义 | executor-node shell 任务（白名单+位置参数 R4 改造） | shell 任务在 Windows 用 cmd.exe 执行——POSIX 语法的 glue 脚本预期失败（如实记录，非 bug） |
| R-10 | py 侧 asyncio/uvicorn | executor-python（fastapi 0.136.3） | event loop policy（Windows ProactorEventLoop）差异——心跳/回调偶发连接错误重点盯 |
| R-11 | mcp-server stdio | `packages/mcp-server`（bin 已有 --help/--version，R12） | Windows 终端编码 GBK vs UTF-8——`--help` 中文输出是否乱码 |
| R-12 | acf-cli 终端输出 | `packages/acf-cli`（commander/ora/colors） | 同 R-11 编码问题 + spinner 在非 TTY 的行为 |
| R-13 | executor-desktop（Electron） | `apps/executor-desktop` | **从未在任何平台打包验证**（路线图 #12）——Windows 打包 + 托盘生命周期 + resources 路径（win32）是最大未知面 |

---

## R13：Windows 环境基线（安装 + 五端单测跑通）

> **状态：2026-09-05 全部完成，结果见 `docs/windows-findings.md`。** 关键：R-01 实锤（W-01，已补 `.gitattributes`+renormalize）；三包/单测首轮暴露 2 枚生产阻断（W-02 setsid、W-04 路径守卫绕过）+ 5 类测试 POSIX 假设，已全部修复并复跑全绿。

目标：仓库在 Windows 上"能装、能测"。全部通过后打勾。

- [x] 1.1 clone（`core.autocrlf=true`）+ `git status` 干净——但 R-01 实锤：autocrlf 下 status 干净不代表无污染，install.sh 检出为 CRLF（W-01）
- [x] 1.2 admin-api：`npm ci`（npmmirror 镜像）→ tsc 0 err → jest **873/873**（修 W-01 后全绿，唯一失败本是 CRLF 字节守卫）→ eslint **0/0**（此前 37078 全是 prettier `␍`，W-01）
- [x] 1.3 executor-node：`npm ci` → build → jest **158/158**（首轮 153，5 失败均测试 POSIX 假设，已平台化，生产代码本就有 win 分支）
- [x] 1.4 executor-python：`uv venv --python 3.12` → pytest **125/125**（首轮 113，12 失败=2 生产阻断 W-02/W-04 + 测试假设 W-05；glue shell 用例改双平台实跑后 0 skip）
- [x] 1.5 admin-web：vitest **35/35** → lint 0/0 → build ✓（首跑 34/35 一例 flaky，复跑 35，见 W-06）
- [x] 1.6 acf-cli：vitest **48/48** + tsc ✓
- [x] 1.7 mcp-server：vitest **61/61** + `--help`/`--version` 正常（帮助全 ASCII 无乱码，R-11 不成立；W-07 token 告警移出 import 副作用已修）
- [x] 1.8 发布包消费：npm 两包（bin 可跑+require 可导入）+ `pip install autoflow-sdk`（3.12 venv 导入正常）全 ✓
- [x] 1.9 registry-pypi：pytest **33/33** ✓
- [x] 1.10 失败项全部记录 → findings W-01~W-09（+修复期新增 W-10~W-15）

## R14：Windows 功能冒烟（真链路）

前置：PG+Redis 起来（Docker Desktop 或 WSL2），admin-api `npm run start:prod`、executor-node `node dist/main.js`（**手动启动替代 systemd**——R-02 预期）。

> **状态：2026-09-05 全部完成。** R-03/R-06/R-07/R-08 是真风险且已实测处置——见 findings「R14 结果」表与 W-11~W-15。

- [x] 2.1 executor-node 注册上线 → `Registered (runtimes: shell,node,python)`，GET /api/executors → online ✓
- [x] 2.2 手动任务全链：node/python/shell/batch 四类全 success（R-09 shell 已改平台原生 `.cmd`，不再必失败，见 W-11）
- [x] 2.3 固定节奏 15s×2min：9/9 success，gap 15.007s ±0.02s（远优于 ±1s）✓
- [x] 2.4 超时 kill：timeout=10s 死循环 → `Task timeout after 10s`，**4 个孙进程 killpg→taskkill 树杀后计数=0 无残留**（P-7/R-03 实证），槽位释放 ✓
- [x] 2.5 401 自愈 + reload-config：轮换后 `Idempotent token reuse`（无 401 风暴）、新任务全链 success、reload-config 推送 `{updatedFields:[taskTimeoutSeconds]}` ✓（R11 Windows 复验）
- [x] 2.6 日志/磁盘回收：活进程持句柄时跨进程 `deleteOldLogs` 成功，无 EBUSY（R-07）✓
- [x] 2.7 中文+空格路径：`C:/测试 目录/af` 下三类任务全 success（R-06）✓
- [x] 2.8 Playwright：**任务书 29 例为 Linux 未跟踪文件，Windows 无基线（W-12）**；跑仓内 16 例版 → 首跑 15/16（W-13 测试路径 bug）→ 修复后 **16/16**
- [x] 2.9 优雅退出：**taskkill /F 绕过优雅链致孙进程泄漏**（R-08 实证）→ 补 SIGBREAK + windowsHide 修复（P-9/P-10），复测 `Received SIGBREAK→树杀收割→shutdown complete` exit 0x0 ✓

## R15：Windows 兼容修复批（消化 R13/R14 findings）

> **状态：2026-09-05 完成 3.1~3.6**（本轮 Windows 侧直接改码，Linux 复验清单见 findings 末）。

- [x] 3.1 findings 逐项修复（W-01~W-15，含 5 枚生产缺陷 P-1~P-11）
- [x] 3.2 `.gitattributes` 补齐（`* text=auto eol=lf` + `*.sh/*.py eol=lf` + 二进制标记）——治 R-01
- [x] 3.3 install.sh 加平台探测（非 Linux 明确报错 + 手动路线指引），与后端 `install-script.content.ts` 副本字节同步、守卫测试通过
- [x] 3.4 env 白名单实测：R-04 系统变量（SYSTEMROOT 等）已满足，`sys.executable` 在净化 env 下可起（python 隔离测试覆盖）；无新增缺口
- [x] 3.5 Windows CI job：`.github/workflows/ci.yml` 新增 `windows-node-tests`（executor-node/acf-cli/mcp-server）+ `windows-admin-web`，固化本轮绿灯
- [x] 3.6 docs/deployment.md 补 Windows 部署章节（手动路线 + SIGBREAK/taskkill 服务化要点 + shell 语义 + 中文路径）

## R16：executor-desktop Windows 打包（路线图 #12 收口）

- [ ] 4.1 `apps/executor-desktop` Windows 打包流程（electron-builder/ncc 链）——最大未知面（R-13）
- [ ] 4.2 打包产物冒烟：托盘/生命周期/内置 executor-node 在 Windows 启动
- [ ] 4.3 与 R14 手动路线的行为差异记录

## 问题回传模板（写到 docs/windows-findings.md，每项一条）

```markdown
### W-<序号>：<一句话标题>
- 环境 Windows <版本> / Node <版本> / Python <版本>
- 轮次与用例：R1x <编号>
- 现象：<报错全文或截图路径；关键日志带时间戳>
- 复现步骤：<最小步骤>
- 预期 vs 实际：<对照>
- 严重级建议：阻断 / 功能不可用 / 有 workaround / 体验
```

## 优先级建议

R13 必做（半天）；R14 必做（半天到一天，R-03/R-07 是真风险）；R15 依赖前两轮产出；R16 可独立并行。发现阻断项不必等轮次走完，直接记录后跳下一项——回传后 Linux 侧立即修。
