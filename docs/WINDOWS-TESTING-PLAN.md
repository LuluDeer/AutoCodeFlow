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

目标：仓库在 Windows 上"能装、能测"。全部通过后打勾。

- [ ] 1.1 clone（记录 `git config core.autocrlf` 实际值）+ 确认 `git status` 干净（若大量文件标 modified 即 CRLF 生效，改 config 后重新 clone）
- [ ] 1.2 admin-api：`npm ci`（官方源）→ `npx tsc --noEmit` → `npx jest`（**预期 873/873**；需可连 PG/Redis——docker 或 WSL2，env 同 `.env.example`）→ `npx eslint` 0/0
- [ ] 1.3 executor-node：`npm ci` → `npm run build` → `npx jest`（**预期 158/158**）
- [ ] 1.4 executor-python：venv + `pip install -r requirements.txt` → `python -m pytest -q`（**预期 125**）
- [ ] 1.5 admin-web：`npm ci` → `npx vitest run`（35）→ `npm run lint`（0/0）→ `npm run build`
- [ ] 1.6 acf-cli：`npx vitest run`（48）+ `npx tsc --noEmit`
- [ ] 1.7 mcp-server：`npx vitest run`（61）+ `node dist/index.js --help` / `--version` 正常输出（R-11 编码观察）
- [ ] 1.8 发布包消费：临时目录 `npm install @autocodeflow/sdk autocodeflow-mcp-server` + `pip install autoflow-sdk`（Windows 装的是含 platform 轮子的真实用户路径）
- [ ] 1.9 registry-pypi：`pip install -r requirements.txt` → `python -m pytest tests/ -q`（33）
- [ ] 1.10 三包/单测在 Windows 的失败项**全部记录**（哪怕预期内失败）——这是 R14 修复输入

## R14：Windows 功能冒烟（真链路）

前置：PG+Redis 起来（Docker Desktop 或 WSL2），admin-api `npm run start:prod`、executor-node `node dist/main.js`（**手动启动替代 systemd**——R-02 预期）。

- [ ] 2.1 executor-node 注册上线（共享 token 对齐）→ GET /api/executors 显示 online
- [ ] 2.2 手动任务全链：创建 glue node 任务 → trigger → 执行 success → 日志回读（R-09：shell 任务预期失败，node/python 任务预期成功——分别取证）
- [ ] 2.3 固定节奏任务 15s × 2 分钟（R11 基线：gap 均值 15.000s ±0.5s，Windows setInterval 精度可能略差，验收放宽到 ±1s，超了记录）
- [ ] 2.4 任务超时 kill：建 timeout=10s 的死循环任务 → 观察执行被杀 + **孙进程是否残留**（R-03 重点：任务管理器/`tasklist` 对照）+ 槽位释放
- [ ] 2.5 401 自愈：admin 界面轮换 token → 30s 内（一个心跳）出站请求自动对齐（node 侧）；reload-config 推送成功（R11 修复的 Windows 复验）
- [ ] 2.6 日志/磁盘回收：产生日志 → TTL/清理路径不因 EBUSY 报错（R-07）
- [ ] 2.7 中文+空格路径：WORK_DIR 设 `C:\测试 目录\af` 重跑 2.2（R-06）
- [ ] 2.8 Playwright：`npx playwright install chromium` 后 `e2e-full.spec.js` 29 例（admin-web dev + admin-api + executor-node 全栈）——预期通过数如实记录（Windows 首跑，无基线）
- [ ] 2.9 优雅退出：Ctrl+C / taskkill /auto 后确认无孤儿进程、无锁残留（R-08）

## R15：Windows 兼容修复批（消化 R13/R14 findings）

- [ ] 3.1 R13/R14 findings 逐项修复（Linux 侧主导，Windows 复验）
- [ ] 3.2 `.gitattributes` 补齐（`*.sh text eol=lf`、`* text=auto`）——治 R-01
- [ ] 3.3 install.sh 加平台探测：非 Linux 直接给明确指引（指向 Windows 手动路线），避免误导
- [ ] 3.4 env 白名单按 Windows 实测补缺（R-04）
- [ ] 3.5 Windows CI job（`runs-on: windows-latest` 跑 executor-node + acf-cli/mcp-server/admin-web 的 vitest/jest——把 Windows 基线固化进 CI）
- [ ] 3.6 文档：docs/deployment.md 补 Windows 部署章节（以实测为准写）

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
