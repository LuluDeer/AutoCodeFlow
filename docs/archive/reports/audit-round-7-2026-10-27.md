# 审计轮 #7（2026-10-27）：五轴只读调研 → 主控判定与落地

> 形式：**先并行派 5 个只读 subagent 分区调研，再由主控汇总、判定、落地、逐条自证**
> （改前红 → 改后绿）。目的不是"多跑一遍检查"，而是把"一个人顺着读"换成
> "五个方向同时逼近 + 只信可复现证据"。
>
> 与轮 #6 的分区**刻意不重叠**：轮 #6 覆盖 admin-web / admin-api / 执行器+协议 /
> packages+CLI / 文档+CI；本轮覆盖 **executor-desktop / 测试体系有效性 / 运维可部署性 /
> 首次成功漏斗 / 安全纵深**。
>
> 纪律：5 个 subagent 全部只读（不写文件、不 git 写操作、不 install），每条结论要求
> file:line 证据并区分「实测」与「读码推断」。工作区中轮 #6 的 ~20 个未提交文件
> **未被当作缺陷、未被回滚、未被提交**。

---

## 1. 五轴结论速览

| 轴 | 成熟度判定 | 最高级别 |
|---|---|---|
| executor-desktop | 骨架硬（IPC sender 闸 / 配置消毒 / start-stop 互斥 / bundle 漂移闸 / CI 真跑自测），**边缘失败路径系统性偏软** | 1×P1（worker 管道 EPIPE 打死主进程） |
| 测试体系有效性 | 守卫"接线"面好于多数仓库（37 个 check-*.mjs 全有 CI 调用者、多数带 --selftest），但存在**两条"测试存在却不产生保护"** | 2×P1（覆盖率分母含测试代码；332 行用例从未被收集） |
| 运维/部署 | 观测面与迁移面成熟（告警指标名 30/30 命中、迁移 each 事务 + advisory lock、迁移与代码不同批已有显式处理）；短板集中在 `deploy.sh` 这条"一键部署"链 | 4×P1（source 模式 nginx 缺 /uploads、rsync --delete 删上传包、首部署自举必崩、docker 缺 --build 假部署） |
| 首次成功漏斗 | `./scripts/demo.sh` 主干**真的成立且扎实**；断裂点全在**文档化的手动 Docker 路径**与 **deploy.sh 生成 .env 的路径** | 2×P1（CORS 守卫打死默认组合；deploy.sh 生成 .env 后跳过校验） |
| 安全纵深 | 认证/授权/注入/密钥四条线大面积硬化，**无 P0** | 1×P1（回调限流桶键取自客户端可伪造 header） |

五轴**均无 P0**。所有 P1 的共同形态是同一类：**"看起来有防线/看起来成功了"** ——
闸门存在但分母塌了、测试存在但没被收集、部署脚本报成功但代码没换、代理少一条
location 就返回 200 + HTML。

---

## 2. 本轮落地（全部带反证）

### 2.1 python 覆盖率分母含测试代码（测试体系 P1）

- **问题**：`apps/executor-python/pytest.ini` 的 `--cov=.` 把 tests/ 算进分母，而
  tests/（约 20648 行）比源码（约 13094 行）还多。实测 `.coverage` 里 72 个被测文件
  有 45 个在 tests/。
- **后果**：85% 地板折算成**源码侧约 59%**，可放行 28pt 退化；测试写得越多数字越好看。
- **落地**：新增 `apps/executor-python/.coveragerc`（`[run] omit = tests/*`）+ pytest.ini
  说明。注意 pytest-cov **没有** `--omit` 开关（实测 `unrecognized arguments`），
  必须落在 coverage 自己的配置面。
- **自证**：改前 TOTAL 15853 stmts / 94.52%；改后 5273 stmts / **87.31%**，地板提到 86
  （余量 1.3pt）。全量 585 例仍绿。

### 2.2 admin-api 332 行用例从未被任何 jest 配置收集（测试体系 P1）

- **问题**：`test/factories/__tests__/{user,task}.factory.spec.ts` 落在 `rootDir: "src"`
  之外，也不匹配 e2e 的 `.e2e-spec.ts` 面 → 从未运行；且**没有任何守卫会发现**
  （`jest --listTests` 无论怎么跑都不列它们）。
- **落地**：jest 配置加 `roots: ["<rootDir>", "<rootDir>/../test"]`（e2e 因 testRegex
  要求字面量 `.spec.ts` 结尾不会被误收）。
- **收编第一层就炸出第二层**：这两个 spec 即使被收集**也跑不起来**——
  `@faker-js/faker@10` 是**纯 ESM**（`"type": "module"`，dist 只有 ESM 入口），而本仓
  测试入口是 `npx --node-options=--experimental-vm-modules jest` + ts-jest(CJS)：
  vm-modules 模式下 faker 的 `dist/index.js` 被当 ESM 求值，import 期直接
  `ReferenceError: exports is not defined`（实测 2/2 套件 failed to run）。
  于是这两个文件是**三重假绿**：断言写了 → 没进收集面 → 即便进了也在 import 期炸。
- **落地（第二层）**：新增 `test/factories/deterministic.ts`（进程内递增序号 +
  固定基准时间 + 字母词表），把 `user.factory.ts` / `task.factory.ts` 改造成
  **确定性工厂**，不再依赖 ESM-only 包。
- **自证**：`--listTests` 351 → **353**；`npm test -- test/factories` **29/29 绿**，
  裸 `npx jest test/factories` 亦 29/29（两种跑法都过）。改造过程中顺带修掉一条真缺陷：
  旧实现用 faker 的 `pattern: /[a-zA-Z0-9]/` 只约束**字符集**、不保证出现数字
  （12 位全字母概率 ≈ 12%），而 spec 断言的正是"含字母和数字"——现在密码是
  `Passw0rd<seq>` 构造出来的，确定性成立。

### 2.3 source 模式 nginx 缺 `/uploads/`（运维 P1，APP-002 必复现）

- **问题**：`deploy.sh install_nginx_site()` 的 heredoc 只代理 `/` `/api/` `/metrics`；
  `/uploads/` 落进 SPA 回退 → **HTTP 200 + index.html** → 执行器 zip-guard 报
  `unparseable`（错误指向执行器，根因在代理层）。而 source 模式是 deployment.md 的
  "生产推荐"路径，两份仓库内 nginx 配置是绿的 ⇒ 闸给不出任何信号。
- **落地**：补 `location ^~ /uploads/`（含 300s 读超时 / 510m body / 不带 URI 的
  proxy_pass）；同时删掉指向**不存在路径**的 `location /metrics`（真实端点是
  `/api/metrics` 且需鉴权，Prometheus 抓它只会拿到 SPA 回退），横幅同步改
  `/api/metrics`。
- **扩闸**：`uploads-proxy-consistency.spec.ts` 现在把 **deploy.sh 的 heredoc 当作第三份
  配置**（截取文本 + 反转义 `\$` 模拟 heredoc 展开），断言同一组判据 + 禁止再出现
  `location /metrics`。用例 5 → **7**。
- **反证（实测）**：从模板里删掉 `location ^~ /uploads/` → 该 spec 立即红
  （`expect(conf).toMatch(...)` 失败）；恢复后 7/7 绿。`deploy.selftest.sh` 50/50 绿。

### 2.4 `rsync --delete` 每次 source 部署删光运行时上传目录（运维 P1）

- **问题**：`sync_source_tree` 的 `rsync -a --delete` 未排除 `uploads`，而 admin-api 的
  上传目录就是 `process.cwd()/uploads`（systemd WorkingDirectory 在安装目录内）——
  每次升级都会删光应用包/执行器包（`packageUrl` 立刻 404、部署与回滚链断），
  还会把开发者本机脏包反向灌进生产，且**无任何日志**。
- **落地**：`--exclude 'uploads' --exclude 'logs'` + 说明为什么不排除源码、排除产物。

### 2.5 首次成功：默认组合被 CORS 守卫打死（漏斗 P1）

- **问题**：compose 默认 `NODE_ENV=production` + `CORS_ORIGINS` 默认 `http://localhost`，
  而生产守卫（`configuration.ts:1004-1015`）拒绝回环来源，除非
  `ALLOW_LOOPBACK_CORS=true`；该开关在 `.env.example:72` 是**注释状态**，
  quickstart / README 都没提 ⇒ 照文档走必死在启动。
- **落地**：README Option 1 与 quickstart 路径 B 各加可执行的一行（含"真实域名部署
  不要打开"的反向提示）；compose 的 admin-api `environment` 显式列出
  `ALLOW_LOOPBACK_CORS: ${ALLOW_LOOPBACK_CORS:-}`（语义不变，默认仍 fail-fast——
  验证：未设 → `""`，设为 true → `"true"`，`docker compose config` 实测）。
  注释里写清了"env_file 本已注入、这里显式列出是为了让依赖在部署面可见"，
  避免把"显式声明"误读成"默认放开"。

### 2.6 桌面端：worker 管道 EPIPE 会打死整个应用（桌面 P1）

- **问题**：`agent-worker-process.ts` 的 `child.stdin?.write(...)` 没有 `'error'` 监听。
  worker 退出（自愈重启 / shutdown 超时 SIGKILL）与 30s tick 写管道之间没有同步，
  写已断开的管道按 EventEmitter 语义 emit `'error'` → 无监听者即 uncaughtException
  → crash-guard 退出桌面端（用户视角："RPA 客户端自己关了"）。
- **落地**：`child.stdin?.on('error', () => undefined)`（照抄同仓先例
  `gui-windows.ts:319`）+ 新增 selftest `testStdinErrorIsContained`：用
  `stdin.destroy(new Error('EPIPE'))` 造真实故障形态，并**临时接管
  uncaughtException** 把"有没有被升级"变成断言。
- **反证（实测）**：注释掉那行监听 → selftest 转红（`captured` 是 Error，期望 null）；
  恢复 → `all assertions passed`。

### 2.7 两条守卫的"分母塌了永远绿"（测试体系 P2）

- `check-constant-time-compare.mjs`：扫描 965 个文件、命中 0 处 —— 但如果扫描根改名/
  glob 失效就会变成"0 个文件 → 0 处命中 → 永远绿"。加 `MIN_FILES = 900` 下界。
- `check-shell-multibyte-var.mjs`：40 个目标文件，加 `MIN_TARGETS = 30` 下界。
- **反证（实测）**：把 `MIN_FILES` 改成 100000 跑 → exit 1 并打印
  "只扫到 965 个文件（下界 100000）——分母塌了，不是代码变干净了"。

### 2.8 两条死文档（漏斗 P2）

- `docs/quickstart.md` 排障段 `docker compose logs nginx` → 本栈**没有** nginx 服务
  （入口走 admin-web 内置 nginx），照抄得到 `no such service`。改为 admin-web + admin-api。
- `docs/tutorials/01-first-scheduled-task.md` 仍教点「设置 → 个人信息」——该菜单 W8 已移除
  （`MainLayout.tsx:432`、`logout.test.tsx:111` 断言其不存在）。改为「系统 → 用户管理 →
  重置密码」。

---

## 3. 判定「本轮不做」与「不是问题」（防止下轮重开）

### 3.1 明确推迟（附理由与前置条件）

| 项 | 级别 | 为什么这轮不动 | 建议形态 |
|---|---|---|---|
| 回调限流桶键可被 `x-executor-address` 轮换（`executor-aware-throttler.guard.ts:136-139`） + 55MB/16MB 预认证 body 解析（`main.ts:208-221`） | P1 | 真正修法是**双层限流**（per-executor 60/min + per-IP 硬顶），需要决定 NAT 大机队与单 IP 上限的取值口径；`getTracker` 单返回值语义下必须改 `generateKey`/命名 throttler，属全链路回归面（callback/register/heartbeat/pull/command-result 全部机器面） | @nestjs/throttler 6 命名 throttler 双层 + pre-auth Content-Length 闸（照抄 `registry-pypi/main.py:412-445` 的 411/413 形态，留 64KiB 余量）；落地前先定 per-IP 硬顶数值并做一次压测 |
| `?token=` 查询参数承载机队共享令牌（`executor.controller.ts:1091-1095`，全仓已无消费者） | P2 | 属**凭证出 URL** 的收紧，删分支会让任何存量外部脚本 401 → 必须走 deprecation + CHANGELOG 点名 | 下轮：删 query 分支 + 文档两处 + spec 反证；或改短时效 artifact 票据 |
| deploy.sh 的"假部署"（缺 `--build` 仍报成功并写 manifest，`deploy.sh:628-634/920/1266-1289`） | P1 | 改判据（`manifest.gitCommit != HEAD` ⇒ warn/die）会改变既有用户的部署习惯，需要 release note 同批 | 下轮：warn 起步 + manifest 增 `imageId`；`deployment.md:136` 示例补 `--build` |
| deploy.sh 就绪失败被 `|| true` 吞掉（`deploy.sh:1162-1163`）；compose healthcheck 只探 `/live`（`docker-compose.yml:230-235`） | P1 | 收紧会让"依赖抖动"环境从绿变红，必须同时给逃生门（`--allow-degraded`）与 manifest 记 readiness | 下轮：ready 失败 ⇒ 默认 die + `--allow-degraded` + manifest `readiness`；healthcheck 换 `/api/health/ready`（需先确认没有 `depends_on: service_healthy` 在启动早期死等） |
| config_phase 生成 .env 只补 5 键且**跳过**生产校验（`deploy.sh:463-495`） | P1 | 与上条同源（是否"生成即视为合规"是部署策略决定），且要避开 dry-run 误报（先写盘再校验） | 下轮：补 `INITIAL_ADMIN_PASSWORD`/`REGISTRY_PASS`/Grafana 口令 + 生成后无条件校验，dry-run 只跳过写盘 |
| 桌面端更新链诚实化（`quitAndInstall` 用 `isUpdaterActive()` 当"有已下载更新"判据；deb 安装上「检查更新」永久静默） | P2 | 需要同时改 updater 状态机 + 渲染层文案 + i18n，且 `electron-updater` 的 `isUpdaterActive` 语义只能靠读上游源码确认（本轮已确认：只判 isPackaged） | 下轮：记 `downloadedVersion` + 纯函数 `canInstall()`；非 AppImage 安装返回 `UPDATER_UNSUPPORTED_INSTALL`，渲染层出双语"请用包管理器升级" |
| 桌面 tick 无看门狗（worker 卡住 ⇒ 托管永久空转 + 身份替换永久 defer） | P2 | 超时值需要与单指派上限同源定档，且要保证"超时=当 worker 已死"不会误杀长任务 | 下轮：tick 看门狗（kill + 自愈重启）+ defer 次数上限 |
| agent 写工具 `resourceKind:"none"` 跳过 scope 白名单（当前 latent，写执行体未接线）/ registry-npm 任意命名空间可发布 | P2/P3 | 前者只需 tripwire spec（零运行期风险）；后者是私服策略，需要产品判断是否限制 `@autoflow` scope | 下轮：`tier !== read ⇒ resourceKind !== none or approvalRequired` 断言；`test:registry-npm` 加命名空间断言 |
| test:guards 仍是 CI 的真子集（本地 60 个脚本 vs CI 82 个，19 个 CI 脚本本地不跑） | P2 | 与轮 #6 刚建立的 `test:guards` 分组同批演进，改 package.json + ci.yml 两处，需要逐个实跑确认离线可跑（subagent 只按"无 DB/无网络引用"判定，未逐个实跑） | 下轮：19 个脚本逐个实跑 → 能离线的并入 `test:guards:repo`，不能的写清依赖并在注释里点名 |

### 3.2 对上一轮结论的一处纠正

- 轮 #6 把「`acf executor online` 逆操作缺失」列为**真实缺口**（见 OPEN-DECISIONS A3）。
  本轮实测：**心跳/注册会无条件把该行置回 ONLINE 并清 `offlineReason`**
  （`executor.service.ts:2694-2701`，注释明写"遗留 P1-24：恢复在线即清除离线原因"）——
  即 `set-offline` 是**自愈的**，最迟一个心跳周期（30s）后恢复。
  结论修正为：**不需要新增 `executor online` 命令**；它的唯一收益是省掉 ≤30s 等待，
  代价是一条新的写端点 + 权限面。若确实要即时生效，应先问"为什么不能等一个心跳"。

### 3.3 复核为「不是问题」（防重开，证据在五份调研报告里）

- 迁移安全整体到位：`migrationsTransactionMode: "each"` + 会话级
  `pg_try_advisory_lock` 轮询互斥（boot 与 CLI 同键）+ 脏数据迁移自带确定性去重。
- 告警与指标同源：30 条规则指标名全部命中注册清单；阅读版 `alerting-rules.yml` 是
  **允许子集**，不是漂移。
- RolesGuard 无 `@Roles` 即放行**不是** fail-open：被 `route-authz-matrix.spec.ts` 的
  五形态穷举约束。
- 桌面 IPC sender 闸不是纸面：44 个 handler 全经 `createGuardedIpcMain`，preload 54 个
  通道全部在主进程有真实 handler（剥注释后逐通道核对，靠注释撑住的 = 0）。
- `configBefore` 不是自比较别名 bug（conf 16 的 `store` getter 返回冻结缓存、写入清缓存）。
- agent 的 SSRF 正则残缺当前**无可达 sink**（工具表里没有 URL 消费型工具）——
  一旦新增 fetch 类工具立即升 P1，届时必须改调 `assertSafeHttpUrl`。

---

## 4. 遗留清单（下轮可直接认领，按 收益/风险 排序）

1. **回调限流双层 + pre-auth Content-Length 闸**（安全 P1，唯一未认证 DoS 放大面）。
2. **deploy.sh 三连**：假部署告警（缺 --build）、ready 失败默认 die + `--allow-degraded`、
   config_phase 补键 + 无条件校验。三条同属"部署报告说绿但实际不可用"。
3. **桌面更新链诚实化 + tick 看门狗**（用户可见："点重启并安装没反应"、
   "改完 token 旧身份还在收单"）。
4. **test:guards 补 19 个 CI 脚本 + vitest `dangerouslyIgnoreUnhandledErrors` 收窄**
   （后者让浮空 promise 拒绝永不红）。
5. **两处弱断言**：`jwt-auth.guard.apikey.spec.ts` 的裸 `catch {}`（抛 TypeError 也算过）、
   `agent-trigger.service.spec.ts:292` 的 `expect(true).toBe(true)`（用例名却是"清理过期桶"）。
6. **桌面 P2/P3 三小项**：`spawnSync('uv --version')` 5s 冻主线程、健康面板每次刷新往
   workDir 写临时文件、`src/preload/index.js`（2026-06 编译产物）仍被 git 跟踪。
7. **漏斗 P2**：demo.sh 缺 node 版本门与 curl 预检、seed 脚本头注的 `ACF_API_URL` 不存在、
   demo 收尾无条件宣称"3 tasks + 3 SOPs 已 seed"（SOP 全失败也这么打印）、
   docs-site 镜像教程 4 篇 vs 源头 5 篇且无条数守卫。
8. **运维 P2**：operations.md 的灾备命令（容器内 `npm run migration:show` 用 ts-node，
  镜像只有 dist）、`pg-restore.sh` 未挂进 pg-backup 容器、uploads 卷描述与 compose 相反。

---

## 5. 验证矩阵（本轮真实跑过）

| 项 | 命令 | 结果 |
|---|---|---|
| python 全量 | `cd apps/executor-python && python3 -m pytest -q` | 585 例绿；覆盖率 5273 stmts / **87.31%**（地板 86） |
| python 改前对照 | 同上（改前） | 15853 stmts / 94.52%（**含 tests 分母**） |
| admin-api 收集面 | `npx jest --listTests \| wc -l` | **353**（改前 351），含 2 个 factory spec |
| admin-api 孤儿用例 | `npm test -- test/factories` 与裸 `npx jest test/factories` | 两种跑法均 **29/29 绿**（改前：从未运行；收编后先红——faker ESM 崩 + 密码不含数字——再修） |
| admin-api 收集面（含 vm-modules） | `npx jest --listTests` | 353（含新增 2 个 factory spec） |
| uploads 代理闸 | `npx jest uploads-proxy-consistency` | **7/7 绿**；删掉模板 location 后红 |
| deploy 脚本自检 | `bash scripts/deploy.selftest.sh` | **50 通过 / 0 失败** |
| deploy 语法 | `bash -n deploy.sh` | OK |
| compose | `docker compose config --quiet`（补 5 个必填变量） | OK；`ALLOW_LOOPBACK_CORS` 默认 `""`、设为 true 时 `"true"` |
| 桌面 worker 自检 | `npx tsc -p tsconfig.selftest.json && node dist-selftest/agent-worker-process.selftest.js` | all assertions passed；去掉监听后转红 |
| 仓库守卫组 | `npm run test:guards:repo` | exit 0（含 docs / 发布接线 / compose-sandbox / mcp 工具面 56 项） |
| 新增下界反证 | 临时把 `MIN_FILES` 改 100000 跑 | exit 1 + "分母塌了" |
| 文档守卫 | `npm run check:docs` | 死链/孤儿/裸路径指针全绿 |
| admin-api 规格类型 | `npx tsc -p tsconfig.spec.json --noEmit` | 0 错 |

**没跑（如实）**：任何 `docker compose up`、Playwright/_electron e2e、`test:unit` 全量
（admin-api 351 套件 / admin-web 249 文件）、Windows/macOS 侧。因此"部署链四条 P1"的
**崩溃形态**是读码 + 官方语义推断（有既有 spec 旁证），不是实机复现。

---

## 6. 交付边界（谁该做什么）

- 本轮改动**未提交**（与轮 #6 的 ~20 个在途文件共存于工作区）。两者足迹**不重叠**
  （本轮 13 个修改文件里没有轮 #6 改过的任何一个：docs/PLAN-CLAIMS、OPEN-DECISIONS、
  AGENT_HANDOFF、ROADMAP、atlas、admin-web、sop-media/app-deployment/task.service、
  executor-python/routers/config.py、scripts/docs/*、mcp-tools-probe.cjs、
  check-publishable-wiring.mjs、根 package.json、ci.yml）——可以分两笔 commit 提交，
  也可以一笔，但**评审时请分开看**。
- 本轮新增文件：`apps/executor-python/.coveragerc`、本报告。
- 建议提交顺序：① 测试假绿三件（.coveragerc + pytest.ini + jest roots + user.factory）；
  ② 部署链（deploy.sh + compose + 两份文档 + 该 spec）；③ 桌面 EPIPE（2 文件）；
  ④ 守卫下界（2 脚本）；⑤ 本报告 + 认领板登记。
