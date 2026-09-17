# 集成验证基线（INTEGRATION BASELINE）

> 用途：把「改动引入的失败」与「改动前就存在的失败」分开，避免收尾时误判。
> 方法：`git archive HEAD apps/<app> | tar -x` 到临时目录，装入同一 venv 后跑同一测试文件。
> 日期：2026-09-16

---

## 1. executor-python —— 预先存在的失败（**非本次改动引入**）

在**未改动的 HEAD 快照**上复跑 `tests/test_maintenance.py`，得到 **3 failed / 14 passed**：

| 失败用例 | 性质 | 判定 |
|---|---|---|
| `test_cleanup_skips_active_execution_workdir` | 测试隔离缺陷：用例依赖 `main.py` lifespan 里才注册的 live-entries provider；单跑该文件时 provider 仍是 `maintenance.py` 的默认空列表，于是 live 目录被当成过期目录删除 | **预先存在**（HEAD 同样失败） |
| `test_cleanup_skips_active_task_venv` | 同上（同一 provider 依赖） | **预先存在** |
| `test_disk_cleanup_task_defers_first_run` | 时序敏感：断言 `len(sweeps) >= 2`，依赖 interval 内能跑满两轮；高负载机器上抖动 | **预先存在**（且为 flaky） |

**结论**：本特性在 executor-python 侧**未引入任何新的测试失败**。
本机在 7 个并行 agent 满载（实测 CPU 94.7%~97.2%、内存 89.4%）下运行时，
`test_health.py::test_readiness_alias_paths_agree` 亦会因
`_resources_ok()` 的真实资源阈值（`cpu >= LIMIT or mem >= LIMIT → not_ready`）而
**合理地**返回 503 失败——属环境负载效应，非代码缺陷（单跑该文件 15/15 通过）。

> 交付口径：以上 3 项为存量问题，不作为本特性的回归证据；已在最终报告中如实登记，
> 未通过修改测试断言的方式掩盖。

---

## 2. 本特性引入并已修复的缺陷（记录以备复盘）

| # | 缺陷 | 严重度 | 发现方式 | 处置 |
|---|---|---|---|---|
| D-1 | D12 解释器池 LRU 回收会**摧毁依赖该解释器的既有 venv**（venv 的 `pyvenv.cfg#home` 指向池目录，回收后 venv 变砖：实测 `No Python at ...` exit 103） | **高**（生产级破坏） | 实测复现 | 改为**引用感知回收**：扫描 `.venvs/*/pyvenv.cfg` 的 `home`，有依赖者跳过；全部被占用时只告警不删除 |
| D-2 | `ensure_venv` 仅凭 `venv_dir.exists()` 复用 venv，无法识别"存在但已损坏"的 venv（池被回收/卷被重挂） | 中高 | 实测复现 | 复用前校验 `pyvenv.cfg` 的 `home` 仍存在 + python 二进制存在 + `version_info` 与声明版本一致；不合格则删除重建（不失败任务） |
| D-3 | zip 渠道触发条件 `codeSource=='application_zip' or applicationId` 会让**存量 gitRepo+applicationId 并存任务**先 clone 再被 zip 覆盖解压（违反兼容红线 §4.4） | **高**（存量行为变更） | 代码审查 + DESIGN.md §2.6 佐证 | 按 `git > glue > application_zip` 优先级显式化；`applicationId` 单独存在时仅在派发载荷确实带 `packageUrl` 时才走 zip |
| D-4 | 离线预填指引用了 **python-build-standalone 平台三元组**（`x86_64-unknown-linux-gnu`），而 uv 只识别自己的词汇（`linux-x86_64-gnu`），且对不匹配目录名**静默忽略** → 运维按提示操作必然失败且无从诊断 | **高**（特性主用例 3.7 直接不可用） | WS7 发现 + 我独立复现 | 改正代码提示、测试夹具、CONTRACT.md（新增 §0.2 勘误 + 对照表） |
| D-5 | 失败分因顺序：解释器获取失败文本含 "timeout" 会被既有 timeout 规则吞掉；含 `No interpreter found` 会被 `exitCode!=0` 判成 `script_error` | 中 | 用真实正则模拟现有规则链 | 要求 `interpreter_unavailable` 规则**置于最前**（先于 timeout 与依赖规则），两侧执行器同款 |
| D-6 | `protocol.json` / `autoflow-sdk` / `executor-node callback.ts` 三处失败原因枚举需同步，否则 admin 回调 DTO `@IsIn` 会拒掉**整批**回调 | 中高 | 交叉核对四方契约测试 | 由我（集成方）统一落地 protocol.json + SDK；node 侧由 WS5 落地 |
| D-7 | 两个新迁移未在 `docs/PLAN-CLAIMS.md` 登记 → CI `check-migrations` 必红 | 中（CI 阻断） | 读 CI 工作流 | 由我预先登记 1790000000024 / 1790000000025 |
| D-8 | **"失败分类共 12 类"的任务书前提本身是错的**——仓库实为 **11** 类（`protocol.json.failureReason.all` @HEAD = 11，独立复核确认）。若按"12→13"改文档/测试，会写进一个仓库并不满足的数字 | 中（**会污染后续所有计数**） | WS6 子代理反驳 + 我用 `git show HEAD:` 独立复核 | 新增 `interpreter_unavailable` 后为 **12** 类；`failure-runbook.ts` 注释显式记录该笔误与口径（以 protocol.json 为准），测试**刻意不断言总数**以免再次被数字绑死 |

---

## 3. 无法在本机执行的验证（如实登记，未伪造）

| 项 | 原因 | 替代验证 |
|---|---|---|
| `docker compose config` | 本机无 docker CLI | WS7 用 js-yaml + PyYAML 双解析器 + 40+ 断言校验 compose |
| `npm run swagger:export` | **需 PostgreSQL + Redis**（本机 5432/6379 均未监听）。实测：`jest --config test/jest-e2e.json -t "OpenAPI export"` 在 `AppModule` 装配阶段抛 `AggregateError`，导出必然失败 | 改为**按 DTO 装饰器逐字段等价补写** `openapi.json`（新增 4 个字段：`CreateTaskDto.codeSource`、`UpdateTaskDto.codeSource`、`CallbackItemDto.result`、`ExecutorHeartbeatDto.interpreters`、`ExecutorRegisterDto.interpreters`），再用 `openapi-typescript` 正常生成 `api-types.ts`（已验证**字节幂等**）。<br>⚠ **遗留风险**：手工补写的 schema 键序/描述可能与被 boot 出来的产物**不完全一致**；具备 PG+Redis 的环境**必须**重跑 `npm run swagger:export && npm run gen:api-types` 复核 `git diff` 应为空 |
| `admin-web` 全量 vitest | 16GB 机器上 Node 进程 **`JavaScript heap out of memory`**（实测崩溃，42 个用例未执行）。本仓 `vite.config.ts` 已记录该负载敏感性 | 分片运行 + 失败文件单独复跑：**全部通过**。已确认 5 个"失败"均为超时/内存抖动而非断言失败（单独跑 35/35、15/15、23/23 全绿） |
| e2e（playwright） | 需 admin-api + 执行器 + DB/Redis 全栈启动 | 仅静态审查 e2e spec 与既有编排脚本 |
| 3.7 端到端真实运行 | 需 Linux 执行器镜像 | 已在 Windows 上端到端实测「pbs 3.7.9 → 池目录（uv 三元组）→ `uv venv --python 3.7` → venv 内 Python 3.7.9」全链打通 |

---

## 4. 最终验证记录（集成收尾，实测命令与结果）

| 套件 | 命令 | 结果 |
|---|---|---|
| executor-python | `.venv\Scripts\python.exe -m pytest -q` | **765 passed**（含此前 3 项"预先存在"的维护用例——全量顺序下通过） |
| executor-node | `npx jest --silent` | **594 passed** / 7 skipped / 1 suite skipped |
| admin-api | `npx jest --silent` | **2960 passed** / 177 suites |
| admin-api 类型 | `npx tsc --noEmit -p tsconfig.json` | **exit 0** |
| admin-web 类型 | `npx tsc -b` | **exit 0** |
| executor-node 类型 | `npx tsc --noEmit` | **exit 0** |
| executor-desktop 类型 | `npx tsc -p tsconfig.json --noEmit` | **exit 0** |
| executor-desktop 自检 | `npm run test:main` | 6 个 selftest 全绿（含新增 `uv-wiring.selftest`） |
| mcp-server | `npx vitest run` | **113 passed** |
| acf-cli | `npx vitest run` | **99 passed** / 1 skipped |
| autocodeflow-node-sdk | `npx jest` | **79 passed** |
| autoflow-sdk | `uv run --with pytest --with respx --with pytest-asyncio python -m pytest -q` | **115 passed** |
| registry-pypi | `uv run --with pytest --with python-multipart … python -m pytest -q` | **84 passed** |
| CI 闸：迁移 | `node scripts/check-migrations.mjs` | ✔ 70 个迁移唯一且已注册 |
| CI 闸：枚举漂移 | `node scripts/check-enum-drift.mjs` | ✔ 13 个 TS enum ⊆ PG enum |
| CI 闸：消费方路由 | `node scripts/check-consumer-routes.mjs` | ✔ 178 method+path 全命中 |
| CI 闸：协议生成物 | `npm run check:protocol-sync` | ✔ 7 个 schema，生成物无漂移 |
| CI 闸：失败原因四方对齐 | `node scripts/check-failure-reasons.mjs`（**本次新增并接入 CI**） | ✔ all=12 / reportable=11，四处一致 |
| CI 闸：文档站同步 | `npm run check:docs-site-sync` | ✔ 七面无 drift（**曾被本特性打破**：`CallbackItemDto.result` 加入后站点字段表缺该行 → 已补 `packages/docs-site/contract.md`） |
| 汇总门禁 | `npm run typecheck:all` | **exit 0**（7 个 target 全过） |
| 汇总门禁 | `npm run lint:all` | admin-web ✓（0 error）、executor-node ✓（0 error）；admin-api 仅剩 **6 个 prettier 报错，全部位于未改动文件**（`auth.controller.ts`、`task.processor.ts`、`task.processor.spec.ts`——经 `git status` 逐一确认与 HEAD 一致，属存量基线） |

### 集成方自查的对抗性验证（不依赖子代理结论）
| 检查项 | 结论 |
|---|---|
| 兼容红线 §4.4：存量 `gitRepo`+`applicationId` 任务不得进入 zip 渠道 | ✔ 4 条专项用例通过，实测"暂时改回朴素条件即变红"，证明测试是**有效**的 |
| `interpreters` 的 `null` vs `[]` 语义 | ✔ 38 条单测显式覆盖（`null`→兜底 3.12；`[]`→不回退；`3.1` 不匹配 `3.13.0`） |
| 钉住执行器（`task.executorId`）版本不符 | ✔ **占坑前**失败，`runningTaskCount` 未 +1（已断言） |
| D14：绝不回退宿主解释器 | ✔ python 侧无依赖分支与 glue 分支均"取不到即明确失败"（`spawns == []` 断言）；node 侧本轮**追加显式断言**（见下） |
| zip 安全上限两侧一致 | ✔ python `ZipSafety` 与 node `zip-guard` 默认值逐项相同（ratio 100 / entries 10000 / 1GiB / 2GiB / nesting 1）；node 复用既有 `zip-guard.ts` 而非另写一套 |
| 下载 SSRF 防护 | ✔ 两侧均有 fail-closed 闸；python 额外用 `not ip.is_global` 兜底 CGNAT（100.64/10）与 multicast |
| 池回收不得"砖化"既有 venv（D12） | ✔ 18 条单测，含"引用中的超大版本被跳过""pyvenv.cfg 畸形""拒绝池外路径/池根自身" |

### 本轮集成方追加的加固（超出各工作流原始范围）
1. **`executors.interpreters` 的探测兜底**（`interpreters.py` + `interpreters.ts`）：uv 整体探测失败时退到本地目录扫描，避免"一个坏条目致盲整池"（§0.3）。
2. **`D14` 显式兜底断言**（`apps/executor-node/src/routes/execute.ts`）：在 `pythonBinFromVenv || resolvedInterpreter || 'python3'` 之前加显式检查——声明了版本却没有解析出解释器时**直接失败**，而不是静默落到 `python3`。原逻辑"理论不可达"，但正是这种"理论不可达"最容易被后续重构破坏，而破坏后是无声的。
3. **`scripts/check-failure-reasons.mjs`**：四方失败原因枚举对齐闸，已接入 CI。
4. **`packages/docs-site/contract.md`**：补 `CallbackItemDto.result` 字段行（否则 DOC-09 闸必红）。

> `autoflow-sdk` 与 `registry-pypi` 用 `uv run --with …` 跑是**环境权宜**：本机
> `executor-python/.venv` 是 uv 托管的、**不含 pip**，直接借用该 venv 跑别的包会
> 报 `ModuleNotFoundError`（缺 `respx` / `python-multipart` 等各自声明的开发依赖）。
> 装入各自声明的依赖后**全部通过**，因此那不是回归。CI 中这两个 job 走
> `pip install -e ".[dev]"`，不受影响。

### 4.1 最终计数（第三轮收尾时的实测值）

| 套件 | 结果 |
|---|---|
| executor-python | **769 passed**（D-13 修复 +2、D-14 修复 +2，共较起点 +4 条回归用例） |
| executor-node | **596 passed** / 7 skipped（D-15 修复 +2） |
| admin-api | **2960 passed** / 177 suites |
| admin-web（本特性相关 4 个文件） | **98 passed** |
| `typecheck:all` | **exit 0**（7 个 target） |
| executor-node lint | **exit 0** |
| admin-web lint | **exit 0**（0 error） |
| 5 个 CI 闸 | 迁移 / 枚举漂移 / 消费方路由 / 失败原因四方对齐 / 文档站同步 —— **全绿** |

> 所有新增回归用例都做过**载荷性验证**：临时把对应实现改回缺陷态，确认用例**变红**
> 且报出的正是缺陷症状，再恢复实现确认全绿。没有"写了测试但测试不咬人"的情况。

### 4.2 端到端实测（真实工件，非构造）

| 能力 | 实测方式 | 结果 |
|---|---|---|
| zip 渠道 | 真实 zip 归档走 `safe_extract` | 正常包解出 `main.py`/`requirements.txt`/`pkg/util.py`；zip-slip → `zip_slip`；绝对路径 → `absolute_path`；20MiB 全零炸弹 → `ratio_too_high`（三者均**拒绝**） |
| uv 多版本 | 真装 3.11 进池，走 `discover_installed` → `resolve_python_bin` → 执行 | 解析出真实路径，该解释器自报 `3.11.13`（exit 0）；`is_online_downloadable('3.7')=False`、`('3.8')=True` |
| 池归属不变量 | 池内仅 3.11.13，混入系统 Python/shim/别的池 | 修复前宣称 5 个版本、仅 1 个可解析；修复后 `advertised == resolvable == ['3.11.13']` |
| 缺失池根 | `UV_PYTHON_INSTALL_DIR` 指向不存在目录 | 不抛异常，返回空池，`pool_summary` 正常 |

### 本次集成新增的回归闸
`scripts/check-failure-reasons.mjs` —— 校验 `failureReason` 的**四方**清单一致
（protocol.json 事实源 / admin TS 枚举 / autoflow-sdk Python 校验集 /
executor-node 可上报集），已接入 CI 的 `check-migrations` job。
动机是实测发现该枚举此前**没有任何一处**守卫：漏改任何一方都是静默故障，
其中最严重的是 admin 回调 DTO 的 `@IsIn` —— 执行器上报未登记值会让**整批**
回调 400 被拒（不是单条失败），任务会永远停在运行中。

---

## 5. 第二轮：CI 全量 job 覆盖排查（30 个 job 逐一对照）

首轮只跑了 5 个闸。本轮把 CI 的 **30 个 job** 全部过了一遍，补齐可离线执行的项，
并如实登记不可执行的项。

### 5.1 补跑并通过
| CI job | 本机执行 | 结果 |
|---|---|---|
| `executor-node-test`（build 步） | `npm run build` | ✔ exit 0 |
| `windows-node-tests`（BUG-07 进程级自检） | `node scripts/bug07-windows-selftest.mjs` | ✔ **3/3 通过**（树杀/信号/无窗口形态） |
| `admin-web-build` | `npm run build` | ✔ exit 0 |
| `private-registry-contract` | `npm run test:private-registry` | ✔ 22 assertions（**修了脚本 bug 后才通过**，见 5.3） |
| `private-registry`（dispatch） | `npm run test:private-registry:dispatch` | ✔ 跳过（需 docker） |
| `selftests`（10 项行为自检） | 逐个 `npm run test:*` | ✔ 全部 exit 0（需 docker 的 8 项显式 skip） |
| `python-packages-test`（4 个包） | `uv run --with-editable . --with pytest … pytest` | ✔ http 31 / ai 34 / notify 21 / db 19 |
| `docs-site-build`（sync 步） | `npm run check:docs-site-sync` | ✔ 七面无 drift |
| `lockfile-integrity` | `cd apps/executor-desktop && npm ci --dry-run --ignore-scripts` | ✔ exit 0（scripts 变更不影响 lock 一致性） |

### 5.2 不可离线执行（如实登记，未伪造）
| CI job | 原因 |
|---|---|
| `docker-multiarch-build` / `desktop-linux-bundle` / `desktop-macos-bundle` / `e2e-full`(-windows) / `desktop-e2e-smoke` / `nginx-sse` / `ha-compose` / `oidc-sso` / `arch31-*` / `qa05-callback-tier` / `pull-dispatch` | 需 docker / 全栈 / PG / Redis / 多平台构建机 |
| `api-types-drift` | 需 PG+Redis（见 §3；已用等价方式补写 openapi.json 并生成 api-types） |
| `secret-scan` | gitleaks-action（GitHub Action，非本地可跑） |
| `npm-audit` | 需联网 registry 审计 |
| `admin-api-migrations` | 需 PG |

### 5.3 本轮新发现的缺陷
| # | 缺陷 | 严重度 | 证据 | 处置 |
|---|---|---|---|---|
| D-9 | **`desktop-bundle-drift` 闸的期望哈希本地不可复现** —— ncc 0.44 的产物字节随**绝对构建路径**变化（module id 由解析后绝对路径派生）。实测：同一份**未改动的 HEAD 源码**，在 `C:\acfh`、`E:\acfA\…`、`C:\Users\…\Temp\…` 下分别得到 `b658b21e…` / `80f77971…` / `0ea86f84…` 三个不同哈希；相对结构相同时才一致；同目录重复构建字节确定。**故 manifest 里的 `485e69c9…`（CI Ubuntu 产物）无法在本机产出，且此性质先于本特性存在** | 中（阻断本地改 executor-node 的人；不影响 CI 自身） | `docs/design/python-task-upload-and-multiversion/BUNDLE-DRIFT-FINDING.md` 全程实测表 | **不手工改写 manifest**（填入本地哈希会让闸"本地绿、CI 红"，比现状更糟）。已如实登记为遗留动作：**须由 CI 产出 actual 后回填**。同时记录 manifest 注释里"ncc 0.44 已不受绝对路径影响"的结论**经实测不成立**，并给出让产物路径无关的两种改法（供排期） |
| D-10 | `scripts/bug18-private-registry-selftest.mjs` 的 `ROOT` 用 `new URL(import.meta.url).pathname`，Windows 上得到 `/E:/…` → `path.resolve` 拼成 `E:\E:\…` → **CI 的 `private-registry-contract` 在 Windows 必崩**（CI 跑 Linux 故从未暴露） | 中（闸在本机形同不存在） | `BUG-18 selftest failed: ENOENT … 'E:\E:\…\apps\registry-pypi\main.py'` | **已修**：改用 `fileURLToPath`（跨平台正确），修复后 22 断言全过。全仓扫描确认仅此一处用了该写法 |
| D-11 | **本特性自查：`ACF_BUNDLE_UV=1 npm run build:executor` 在 Windows 上静默失效** —— `npm run` 把 `bash` 解析为 `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`（WSL 启动器 shim），该 shim **不继承 PowerShell 环境变量**，脚本于是静默走"跳过"分支。用户以为打进了 uv，其实没有。**这是我自己在 README 里写的用法，属本次交付的缺陷** | 中（打包能力静默缺失） | 实测：PowerShell 设 `$env:ACF_BUNDLE_UV='1'` 后 `bash -c 'echo $ACF_BUNDLE_UV'` 输出为空；Git Bash 输出 `1` | **已双修**：① README 补 Windows 专章（含两种实测可用的 Git Bash 调用方式）；② 脚本在跳过分支检测 `MINGW*/MSYS*/CYGWIN*` 并打印可执行的修复提示，把静默失败变显式。`ACF_BUNDLE_UV=1` 分支本身经 Git Bash 实测可用且**bad source 仍 exit 0**（"绝不让构建失败"契约成立） |
| D-12 | **存量**：`apps/executor-desktop` 的 renderer 自检失败 —— `renderer.selftest.mjs` 期望 `--shadow-md: 0 4px 6px rgb(0 0 0 / 0.1)`，而 `styles/app.css` 实际是 `0 4px 6px -1px rgb(0 0 0 / 0.12), 0 2px 4px -2px …`（token 存在但**取值不同**）。两个文件**均未改动 vs HEAD** → 失效的陈旧断言 | 低（且**未被 CI 覆盖**：`desktop-*-bundle` 只跑 `test:main`；`test:desktop` 的 renderer 半场无 job 调用） | `npm run test:desktop` → `Error: missing design token: --shadow-md…`；`git status` 两文件皆空 | **未修**（超出本特性范围，且不在任何 CI 闸内）。已登记供排期：要么更新断言取值，要么把该 selftest 纳入 CI 并修好 |
| **D-13** | **执行器向 admin「谎报」解释器可用性** —— `_parse_python_list` 照单全收 uv 的输出，把**系统 Python**（`C:\Python314\python.exe`）、PATH 上的 `.local/bin/python3.x.exe` shim、以及**别的池目录**里的解释器都当成"本池可用"上报。实测：池内**只有 3.11.13** 时，上报清单为 `['3.11.13','3.13.13','3.14.6','3.9.23','3.9.25']`（5 个），而 `resolve_python_bin()` 只解析得出 `3.11`，另 3 个版本**全部 None**。危害①admin 按快照把 3.14 任务路由到这台**根本没有 3.14** 的执行器 → 运行期必然 `interpreter_unavailable`（可复现的假失败）；②**挤掉真正预置了 3.14 的执行器**。且这是**跨实现对等性缺口**：executor-node 早就有 `isInsidePool` 这道闸（interpreters.ts L407/418/811），python 侧只在 `resolve_python_bin` 处兜（L722），**探测阶段不过滤** | **高**（静默误路由 + 资源错配，且是"客户端执行器全对等"要求的直接违背） | 端到端实测（见下） | **已修**：新增 `_is_inside_pool()`，在 `_parse_python_list` 内按 `resolve()` 后的包含关系剔除池外条目（符号链接逃逸同样拦下；单条不可解析只剔除、不抛）。修复后 advertised `['3.11.13']` 与 resolvable **完全一致**。新增 2 条回归测试并**验证其载荷性**（临时去掉过滤 → 两条都红，报 `3.14.6 被谎报为可用`；恢复后全绿）。契约已补 §0.4 |

### 5.4 D-13 的端到端复现证据（真实 uv 输出，非构造）

```
pool_root = C:\Users\…\Temp\acf-e2e-pool     （池内仅 uv 装入的 3.11.13）

修复前 discover_installed() 返回 9 条，其中 8 条在池外：
  3.14.6   *** EXTERNAL *** C:\Python314\python.exe
  3.14.6   *** EXTERNAL *** C:\ProgramData\chocolatey\bin\python3.14.exe
  3.13.13  *** EXTERNAL *** C:\Users\…\AppData\Roaming\uv\python\cpython-3.13.13-…
  3.13.13  *** EXTERNAL *** C:\Users\…\.local\bin\python3.13.exe
  3.11.13  POOL             …\acf-e2e-pool\cpython-3.11.13-windows-x86_64-none\python.exe
  3.11.13  *** EXTERNAL *** C:\Users\…\.local\bin\python3.11.exe
  3.9.25   *** EXTERNAL *** …\AutoCodeFlow\.tmp-uvprobe\cpython-3.9.25-…
  3.9.25   *** EXTERNAL *** C:\Users\…\.local\bin\python3.9.exe
  3.9.23   *** EXTERNAL *** …\Temp\acf-ws7-dup2\cpython-3.9.23-…

  advertised (admin 看到的) : ['3.11.13','3.13.13','3.14.6','3.9.23','3.9.25']
  resolve 3.14 -> None      ← 宣称可用，实则解析不到
  resolve 3.13 -> None
  resolve 3.11 -> …\acf-e2e-pool\cpython-3.11.13-windows-x86_64-none\python.exe
  resolve 3.9  -> None

修复后：
  advertised : ['3.11.13']        ← 与 resolvable 一致
  ADVERTISE==RESOLVABLE: True
```

> 附带发现：仓库根下残留一个 `.tmp-uvprobe/`（含 `.gitignore`/`.lock`/`vtest*`），
> 是**既往前序调试**留下的池目录，已被 gitignore 忽略、不影响 CI，但会被上面这条
> "别的池目录"路径命中。已清理。

| **D-14** | **同池「外来平台」条目被谎报可用** —— D-13 只挡住"**不在池内**"，但还有一类"**在池内、却不属于本机平台**"：compose 把解释器池做成**共享卷**，executor-python 是 Debian/glibc、executor-node 是 Alpine/musl，**两种产物天然共存**。Windows 上 `_is_executable` 只判存在性 → Linux 条目的 `bin/python3` 被判"可用"：实测池内只有 Linux 条目时，`_parse_python_list` 返回 `available=True`，且 **`resolve_python_bin('3.11')` 直接返回那个 Linux 二进制** → `uv venv --python <linux bin>` 必然失败。更要紧的是 `_scan_pool_directory`（本地兜底）**本来就有**这层平台过滤，于是"uv 成功"与"uv 失败走兜底"会给出**两个不同的池视图** —— 同一台执行器宣称的能力取决于 uv 是否恰好失败 | **高**（静默误路由；且同一执行器两种路径行为不一致） | 端到端实测（构造真实共享池目录，宿主 Windows + 池内 Linux 条目） | **已修**：新增 `_pool_key_matches_host_platform()`，在解析层按"池目录名平台段 == 本机 uv 三元组"过滤，与 `_scan_pool_directory` 对齐。判定不出本机平台或 key 取不出平台段时**放行**（不误杀）。新增 2 条回归测试（外来平台剔除 / 平台未知时宽容），并**验证其载荷性**（临时去掉过滤 → 红，报"实际保留 2 条"；恢复后全绿） |
| **D-15** | **§0.3 的探测兜底只在 python 侧落地，node 侧缺失**（对等性缺口）—— `executor-node` 的 `discoverInstalled` 在四条失败路径（uv 缺失 / 池不可建 / uv 非零退出 / JSON 不可解析）**全部 `return []`**。后果同 §0.3：池里一个坏条目让 uv 整体非零退出且**吞掉健康条目** → 客户端执行器对 admin 宣称**零解释器** → 所有声明版本的任务被拒，而池里健康版本其实可用。因本特性验收要求"客户端执行器全对等"，这是缺口而非可选优化 | **高**（客户端执行器上重演"一个坏条目致盲整池"） | 逐条比对两侧实现（contract §0.3 的兜底在 `.ts` 中不存在） | **已修**：新增 `fallbackDiscovery()` + `pythonBinCandidates()`，四条失败路径全部改走兜底；兜底含**三重过滤**（池内 / 本机平台 / 真实可执行）。新增 2 条回归测试（uv 失败时从本地扫描救回健康解释器；兜底剔除外来平台条目），并**验证其载荷性**（临时把兜底改回 `return []` → 红；恢复后 84/84 全绿）。node 侧 596 passed |
