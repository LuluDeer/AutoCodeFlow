# 实施轮 #8（2026-10-27）：把轮 #7 的 P1 落成代码

> 形式：主控 1 + **实施型 subagent 2**（不是调研——这轮是写代码）。
> 文件面**硬切分**以防冲突：桌面端一组、脚本/演示一组、部署链与安全面主控自己做。
> 每条改动都要求「删掉这行会怎样」的自证（反证：改回旧行为 → 红；恢复 → 绿）。

承接：[审计轮 #7 报告](audit-round-7-2026-10-27.md)（五轴调研 + 已完成 8 项）。
本轮处理轮 #7 §3.1「明确推迟」里**不需要产品拍板**的全部条目，以及遗留清单前 3 条。

---

## 1. 落地清单

### A. 部署链（`deploy.sh`，主控）

| 项 | 改动 | 为什么（缺陷形态） |
|---|---|---|
| OPS-03 | 生成 .env 时**补 `INITIAL_ADMIN_PASSWORD`**（18 字节随机、只打印一次）；非生产写 `ALLOW_LOOPBACK_CORS=true`，生产缺真实域名则 **fail-fast**；生成后**不再整体跳过**生产校验 | 旧实现只补 5 个密钥、并以「本脚本生成的必然合规」短路校验——而它生成的键集里没有管理员口令，`.env.example` 的 `change_me_immediately` 会被 admin-api 的生产守卫直接 throw：首部署崩溃循环 + verify 超时 + doctor 报「必填 5/5 已设置」，运维无路可走 |
| OPS-03b | `validate_production_config` 改读 `CORS_ALLOWED_ORIGINS \|\| CORS_ORIGINS`；新增 `INITIAL_ADMIN_PASSWORD`（≥8 且非占位）；CORS 回环判定与 `configuration.ts` 同口径（显式 `ALLOW_LOOPBACK_CORS=true` 才放行） | 只读旧名会把「只设新名」的部署误判成未设置；不判回环口径则脚本报绿、容器随后崩 |
| OPS-04 | docker 模式缺 `--build` 时，比较**清单 gitCommit vs 当前 HEAD**：dry-run 只告警；生产 **die**（除非 `--allow-stale-image`）；dev/staging 告警。清单新增 `imageState` | 旧行为是「跳过构建 + 照常 up + 照常写清单 + 报部署完成」：`git pull` 后按文档示例跑一次 = 线上还是旧代码，而清单已记新 commit ⇒ 下一次 rollback 也空转 |
| OPS-05 | `/health/ready` 失败**默认判部署失败**（旧为 `\|\| true` 吞掉）；逃生门 `--allow-degraded`；清单新增 `readiness` | ready 会真连 DB/Redis，恒 503 表示「进程活着但服务不可用」；旧实现让这种半死实例部署报告全绿，用户侧只是间歇 5xx/登录失败 |
| OPS-09 | 删掉指向不存在路径的 `location /metrics`（真实端点是 `/api/metrics` 且需鉴权）；横幅同步 | Prometheus 抓它只会拿到 SPA 回退（200 + HTML）或 404，运维据此以为「指标没开」 |

自证（`scripts/deploy.selftest.sh`，50 → **58 例**）：新增 12a~12e 五条白盒用例
（tmp git 仓库里让清单 commit 与 HEAD 不同 ⇒ 生产拒绝 / 逃生门放行；覆写
`wait_http` 让 ready 恒 503 ⇒ 默认失败 / `--allow-degraded` 放行且在清单里记
`readiness=degraded`），以及 8 段里新增的「缺 `INITIAL_ADMIN_PASSWORD` 必须被拒」
「`ALLOW_LOOPBACK_CORS=true` 时回环 CORS 放行」。全量 **58 通过 / 0 失败**。

### B. 安全：回调面 per-IP 硬顶（主控）

- **新增** `apps/admin-api/src/common/middleware/ip-ceiling.middleware.ts`：
  `SlidingWindowCeiling`（纯逻辑 + 可注入时钟）+ `createIpCeilingMiddleware`；
  注册在 **55MB body parser 之前**（超限请求根本不解析）。
- **配置**：`configuration.ts` 的 throttle 段新增 `callbackIpCeilingPerMinute`
  （`CALLBACK_IP_CEILING_PER_MINUTE`，默认 12000/min）；`.env.example` 登记并写清
  取值口径（100 台 × 60/min = 6000，留 2 倍余量；多副本按副本独立计数）。
- **为什么这样修**（不改分桶）：回调的 60/min 按 `x-executor-address` 分桶（B-2 为
  NAT 后多执行器而改），而该头**客户端可设** ⇒ 换头即换桶、聚合无上限；而
  `@nestjs/throttler` 的 `getTracker` 只有一个返回值，无法同时计两个桶
  （OPEN-DECISIONS D7）。所以加**一条与头无关的 IP 边界**，而不是回退 B-2。
- **明着写的边界**：每副本独立计数；限额远高于正常机队；429 + `Retry-After`；
  告警按 IP 10 分钟一条（防「被攻击时日志自己放大」）。
- 自证：`ip-ceiling.middleware.spec.ts` **10 例**（窗口/恢复/键隔离/上界/429 与
  `Retry-After`/**换头换不到新桶**/告警节流/**main.ts 接线顺序早于 55MB parser**）。

### C. 桌面端（实施 subagent #1，主控复核）

- **更新链诚实化**：新增 `downloadedUpdateVersion`（`update-downloaded` 置位、
  `downloadUpdate` 起始清空——失败/取消时 electron-updater 会 `clear()` 安装包，
  不清就等于放行一次注定 no-op 的安装）+ 纯函数 `canInstall()` /
  `isSelfUpdateSupported()` / `surfaceUpdaterError()`；`quitAndInstall` 不再拿
  `isUpdaterActive()`（只判 `isPackaged`，AppImage 恒 true）当「有没有已下载更新」的判据；
  install 期失败不再被 `downloading=false` 吞掉；`setImmediate` 里的
  `quitAndInstall` 加 try/catch（同步抛出否则 uncaughtException → crash-guard 退出）。
- **deb/rpm 静默**：`updater:check` 判 `isSelfUpdateSupported(platform, APPIMAGE)`，
  不支持时回 `{ok:false,error:'UPDATER_UNSUPPORTED_INSTALL'}`；渲染层新增**中英双语**
  键 `cfg.gen.updateUnsupportedInstall`（「请用包管理器升级」），不再只闪一句「已发起检查」。
- **tick 看门狗**：`TICK_WATCHDOG_MS = DEFAULT_GATE_LIMITS.maxWallClockMs + 15min`
  （注释放明：低于它会误杀合法长指派，高于它只是多空转）；超时让 `tickPending`
  **落定**（不 reject）+ kill worker（下轮 tick 自愈 respawn）。
- **身份替换 defer 封顶**：`MAX_AGENT_HOST_DEFERS = 20`（30s 轮询≈10 分钟；
  注释放明为何不取 2h：旧身份每多收一单都是安全面），到顶转 `replace`。
- 自证：`tsc` 双工程 0；`updater` / `agent-worker-process` / `agent-host-lifecycle` /
  `renderer` 四个 selftest 全绿；**四条反证**（改回 `isUpdaterActive` / 改回
  `surfaceError \|\| downloading` / 删 `armTickWatchdog` / defer 永不封顶）各自转红，
  恢复后全绿。

### D. 首次成功漏斗（实施 subagent #2，主控复核）

- **`demo.sh` 预检**：node 主版本 ≥18（`node -e` 读 `process.versions.node`，失败给出
  可执行修复）与 `curl` 存在性——此前 Node<18 会在第 8 分钟以 `fetch is not defined`
  死掉、缺 curl 会被显示成「admin-api 240s 未就绪」。
- **`demo-seed.mjs` 别名 + 结构化计数**：`--base-url ← ACF_BASE_URL \|\| ACF_API_URL`、
  `--username ← ACF_USERNAME \|\| ACF_USER`（头注原本声明的是**不存在**的变量名，
  CI 里写 `ACF_API_URL` 会静默打默认地址）；结尾必打
  `ACF_SEED_SUMMARY {"{tasks,sops,sopFailed,…}"}`，任一不足即 `exitCode=1`。
- **`demo.sh` 收尾**：只解析上面的 summary 打印真实计数，SOP 未全部就位时给出补救命令
  并非零退出（旧文案是**无条件**宣称「3 tasks + 3 SOPs 已 seed」）。
- **三个 `demo-desktop-*.sh`**：预检 `apps/executor-desktop/node_modules/typescript`，
  缺失时打印 `npm --prefix apps/executor-desktop install` 并在 Xvfb 之前退出；
  构建改用本地 `./node_modules/.bin/tsc`（不再走 npx 的隐式下载）。
- **`sync-check` 新增判据 ⑧**：站点教程 sidebar ↔ 源头 `docs/tutorials/index.md`
  （按两位序号比条目集合 + 标题；05 未镜像以 `TUTORIAL_MIRROR_EXEMPT` 显式豁免，
  **豁免过期也红**）——此前「镜像 4 篇 vs 源头 5 篇」无人发现。
  主控把这条并入 `runAllChecks()`（面数 7 → **8**），沙箱基线补上源头索引 +
  sidebar + 被豁免条目（否则基线会因「豁免过期」假红），并同步 README 的「八面」措辞。
- 自证：`demo.selftest.sh` 全绿（+6 组断言）、`demo-seed.selftest.mjs` **26 条**、
  `sync-check` 8 面无 drift + 自检全绿；反向验证（删别名 / 放宽 node 门 /
  删 sidebar 04 / 改标题 / 多 06 / 豁免过期）逐条转红。

---

## 2. 判定：本轮**不做** pre-auth Content-Length 闸（原 F2）

轮 #7 安全轴建议「照抄 registry-pypi 的 411/413 预检」。复核后**不做**，理由：

1. `body-parser` 已经在解析前按声明的 `Content-Length` 判上限（超限 413），再加一层
   同判据的闸只是重复；
2. 它唯一能挡的是「chunked 无声明长度」，而本仓执行器回调走 **axios**（自动设
   `Content-Length`）、python 走 `json=`（同）、桌面 Agent 显式设该头 ⇒ 真能挡的
   只剩扫描器，而扫描器本来就会被速率边界挡；
3. 真正的放大器是**并发数**而非单请求大小 ⇒ 用 per-IP 硬顶（本轮 B 项）才对症。

结论记进 `OPEN-DECISIONS` D7 的选项 ③（"只加 pre-auth 闸"）并标注**已否决及理由**。

---

## 3. 验证矩阵（本轮真实跑过）

| 项 | 命令 | 结果 |
|---|---|---|
| 部署脚本自检 | `bash scripts/deploy.selftest.sh` | **58 通过 / 0 失败**（+8 例） |
| 端到端 dry-run（生产形态 .env） | 临时目录 `deploy.sh --env production --i-know-its-production --dry-run` | 校验通过 + 走完 ⑧ + 「部署完成」 |
| admin-api 单元 | `npm test -- src/common` | **57 套件 / 658 例**全绿 |
| 新中间件 | `npm test -- src/common/middleware/__tests__/ip-ceiling.middleware.spec.ts` | **10/10** |
| 配置面 | `npm test -- src/config/configuration.spec.ts` | **57/57** |
| 类型 | `npx tsc --noEmit`（admin-api） | 0 错 |
| 桌面 | 双 `tsc` + `updater`/`agent-worker-process`/`agent-host-lifecycle`/`renderer` selftest | 全绿（主控**独立复跑**过一遍） |
| 文档站 | `sync-check.mjs` + `sync-check.selftest.mjs` | 8 面无 drift / 自检全绿 |
| 演示面 | `demo.selftest.sh` / `demo-seed.selftest.mjs` | all checks passed / 26 assertions |
| 仓守卫 | `npm run test:guards:repo` | exit 0 |
| env 漂移 | `npm run test:env-drift` | 218 键覆盖 OK（新键已登记） |

**没跑（如实）**：任何 `docker compose up`、真 AppImage/deb 安装与更新链、三个
`demo-desktop-*.sh` 真机（需 Xvfb/xdotool/ffmpeg）、`test:unit` 全量、Playwright e2e。

---

## 4. 遗留（下一轮候选，按 收益/风险）

1. `test:guards` 与 CI 的 19 个脚本差集（需逐个实跑确认离线可跑）——**最大的
   "本地绿 CI 红"来源**。
2. 两处弱断言：`jwt-auth.guard.apikey.spec.ts` 的裸 `catch {}`（抛 TypeError 也算过）、
   `agent-trigger.service.spec.ts` 的 `expect(true).toBe(true)`。
3. `vitest dangerouslyIgnoreUnhandledErrors: true` 收窄（浮空 promise 拒绝永不红）。
4. 桌面 P2/P3：`spawnSync('uv --version')` 5s 冻主线程、健康面板每次刷新写临时文件、
   被跟踪的过期构建产物 `src/preload/index.js`。
5. 运维 P2：operations.md 灾备命令（容器内无 ts-node）、`pg-restore.sh` 未挂载、
   uploads 卷描述与 compose 相反；`deploy.sh` 的 `infra_phase` 在 docker 模式下
   多起一套 PG/Redis。
6. 站点补 05 教程镜像页（补完删 `TUTORIAL_MIRROR_EXEMPT`）。
7. D7 的 per-IP 硬顶取值仍需一次真机压测确认（当前 12000/min 是推算值）。

---

## 5. 交付边界

本轮改动**未提交**，与轮 #6（~20 文件）、轮 #7（16 文件）共存工作区；三批足迹互不重叠。
建议提交切分：①部署链（deploy.sh + compose + 2 文档 + deploy.selftest）②安全（middleware +
main.ts + configuration.ts + .env.example + spec）③桌面（10 文件）④漏斗（9 文件）
⑤文档站判据（3 文件）⑥本报告。
