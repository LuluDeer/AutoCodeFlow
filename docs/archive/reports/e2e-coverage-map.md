# E2E / 真库 selftest 覆盖地图与缺口（2026-10-25）

> 背景：5c 轮（`56aa2697`）三处真缺陷——zip 临时文件拍扁、rename 父目录、**迁移 63 缺
> createdAt/updatedAt 列（最重，设备版本事实从建表起从未落库）——全部在单测 mock 全绿
> 下合入，由 CI 的 arch31 cross-instance selftest（真 PG + 完整迁移链 + 真实部署进程）
> 暴露。教训已登记：**映射替身对 DDL 缺口零感知、单测对路径类改动的盲区在「真实 fs
> 中间目录」——真库 E2E 是唯一防线**。本报告盘点现有 selftest 覆盖地图、对照近 10 轮
> 改动风险面排序缺口，并给出 top1 补测方案。

## 1. 覆盖地图：scripts/ 下全部 selftest

### 1.1 行为级 selftest（真库 / 真进程 / 真 docker）

| 脚本 | 链路覆盖 | CI job | 形态 |
|---|---|---|---|
| arch31-multi-instance-selftest.mjs | 多实例一致性（静默跨实例/Leader 单点） | selftests | 真库+真双 admin-api 进程（docker PG/Redis） |
| arch31-rollout-cross-instance-selftest.mjs | **部署全链**：创建应用→真实 zip 下载→起进程→canary 灰度→心跳落非属主实例 | selftests | 真库+真双实例+真双执行器（**唯一一条部署 E2E 链**） |
| arch31-outbox-claim-selftest.mjs | outbox 行级 claim 双实例竞争（生产同款 SQL） | selftests | 真 PG 并发会话 |
| arch31-outbox-duplication-selftest.mjs | outbox webhook 重复投递边界 | selftests | 真库+真双实例+真 HTTP 接收器 |
| control-plane-pull-selftest.mjs | ARCH-33 控制面 pull 通道（部署/停止/配置热更新） | selftests | 真库+真两端进程 |
| pull-dispatch-selftest.mjs | ARCH-32 pull 派发端到端（NAT 零入站） | selftests | 真库+真进程 |
| qa05-callback-tier-selftest.mjs | 回调入口 10k 条/分钟（真实 RUNNING 池） | selftests | 真库+真进程 |
| oidc-sso-selftest.mjs | OIDC 授权码全流程（loopback mock IdP + RS256 真签发） | selftests | 真进程 |
| nginx-sse-selftest.mjs | 真实 nginx 反代下 SSE 长流 | selftests | 真 nginx 容器（原件配置） |
| ha-compose-selftest.mjs | 多副本 --scale + nginx 轮询 | selftests | 真 docker compose |
| bug18-private-registry-dispatch-selftest.mjs | 执行器私服依赖安装链（含 npmrc 不落工作树） | selftests | 真 Verdaccio+真执行器 |
| bug18-private-registry-selftest.mjs | 私服注册表契约（npm/pip 直连） | private-registry-contract（CI 只 --dry-run 契约面） | live 模式真私服（仅本地） |
| bug07-windows-selftest.mjs | Windows detached/信号进程树 | windows-node-tests（executor-node 矩阵腿） | 真进程树（非 win32 skip） |

### 1.2 守卫自检（`--selftest` 内嵌夹具，零依赖离线）

check-migrations / check-docs / check-no-hoisting / check-enum-drift / check-index-drift /
check-user-facing-language / check-error-i18n / check-error-migration / check-conditional-writes /
check-desktop-bundle-drift / check-desktop-agent-packaging / check-desktop-update-chain /
check-openapi-response-schema / check-dependency-review / check-consumer-routes /
check-password-policy-sync / check-env-drift / check-compose-sandbox / check-compose-service-env /
api-i18n inject-openapi-en / check-release-config / check-lint-gates / check-shell-multibyte-var /
check-alerts-rules / check-throttler-whitelist —— 全部在 ci.yml `check-migrations` job（793-1071 行）
或 desktop-bundle-drift job，形态 = 负向夹具 + 纯函数断言（**无 DB**）。

### 1.3 工具脚本自检（纯 stub / 纯函数）

| 脚本 | 覆盖 | CI job | 形态 |
|---|---|---|---|
| alertmanager-hmac-proxy.selftest.mjs | HMAC 签名代理 | check-migrations | 真 loopback HTTP + 真 HMAC |
| audit-verify.selftest.mjs | 审计 sequence/window 判据 | selftests | 纯函数 |
| load-test.selftest.mjs | SSE 解析/参数边界 | selftests | 纯函数+stub |
| micro-benchmark.selftest.mjs | 基准脚本逻辑门 | benchmark | 纯函数 |
| registry-npm-config.selftest.mjs | registry 配置漂移 | selftests（test:registry-npm） | 文本断言 |
| demo-seed / demo-failure-seed / demo.selftest.sh / chaos-drill / deploy / pg-restore / install-artifact-sha256 | 各工具链 | selftests（deploy/chaos/pg-restore）；**demo 三件未接任何 CI** | stub/桩 PATH |

### 1.4 更大的真库链（非 scripts/selftest 命名，对照参考）

- **admin-api-e2e job**（ci.yml:230）：真 PG/Redis + `migration:run` 全链 + 三个 jest e2e
  suite（auth/executors/tasks）——**不覆盖**部署域/产物索引/事件表/设备事实。
- **e2e-full job**（ci.yml:1519）：48 例 Playwright 全链（PG+Redis+admin-api+executor-node+
  admin-web）。legacy spec 关键词扫描确认：**无** artifact/deployedApps/installedPackages/
  releases/deployment/netrc 断言。
- **admin-api-migrations job**（ci.yml:291）：空库全链 + 二次幂等 + （月度）entity 漂移
  `migration:generate --check` + revert 单步。**只验迁移链自身可达，不验迁移产物被业务
  读写路径真实消费**——迁移 63 缺列正是从这里漏过的（建表成功、链幂等全绿）。

## 2. 近 10 轮改动风险面 × 覆盖现状

| 风险面 | 改动 | 现有覆盖 | 缺口判定 |
|---|---|---|---|
| 迁移 62（app_deployment_events） | R4 事件表 | 迁移结构 spec（**SQL 文本断言**）+ app-deployment-events.spec（**全 mock repo**：makeDeploymentRepo jest.fn 全家桶 + axios/dns mock） | **只有单测（mock 风险·高）**：九个写点、deployCount GROUP BY 聚合、/events 读面分页从未在真库跑过 |
| 迁移 63/66（executor_app_versions + executors.installedPackages） | R3-A 协议 v7 设备事实落库 | executor.app-version-report.spec（mock repo + 内存表替身）；迁移 spec 同为 SQL 文本断言；**5c 已由 arch31-rollout 真库暴露过一次缺列**（迁移 66 收口） | **部分钉住但无直接断言**：arch31-rollout 20 条断言里没有一条直接 SELECT executor_app_versions / executors.installedPackages——当时是靠 admin 日志 warn「顺带」暴露，修复后**该暴露通道没有固化为断言**（若再出同型缺口，需再次依赖日志肉眼） |
| 迁移 64（事件回填） | 存量部署行回填事件 | backfill-app-deployment-events.migration.spec（SQL 文本断言） | 只有单测 |
| 迁移 65（execution_artifacts 索引表） | ARTIFACTS-INDEX-46 产物索引 | execution-artifacts-index.spec（迁移源码 DDL 断言 + **@Optional repo mock**）；executor 侧 artifacts.spec（单测） | **只有单测（mock 风险·高）**：索引表读面（GET /artifacts 三场景）与回调双轨写在真库的端到端从未跑过；@Optional 装配使 repo 缺失静默降级——正是 DDL 缺口零感知的同款形态 |
| 协议 v7 两键（deployedApps/installedPackages 上报） | executor-node scheduler 心跳注入 | deployed-apps.spec / installed-packages.spec（**真临时目录 fs**，形态好）+ protocol-version-consistency.spec；admin 侧采纳为 mock | executor 侧扫描逻辑单测形态健康；**断链点在 admin 落库与读面聚合**（见上） |
| 5c 布局（releases/<version>/<deploymentId>/ 两段） | ec2184ec + 56aa2697 修 3 处 | **arch31-rollout 真库链已钉住**（部署 RUNNING 即隐式验证两段落盘）；desktop 侧 release-retention 真 fs E2E（457d854f） | 已钉住（本轮 top1 实施后断言更显式） |
| P1 netrc（私有 PyPI 凭据通道） | 4624e4e0 | python: test_pypi_netrc.py（真文件 0600 断言，但 401 服务端为 stub 描述）；node: python-venv.spec；E2E 实证在提交时一次性真机（真 uv+401 服务），**未固化** | 中：netrc 注入单测形态尚可；真 401→200 通道未进 CI（bug18-dispatch 覆盖 npmrc 不覆盖 netrc/uv） |

## 3. 缺口 Top3 排序

排序依据 =「上次出真缺陷的面的相似面」（权重最高：同型 mock 盲区 = 已证明会漏）+
「数据完整性风险」（落库静默失败 = 事实面永久失真）。

### Top1：协议 v7 设备事实链的**真库落库断言缺失**（迁移 63/66 同型面）

- **相似面（已证明）**：5c 最重缺陷就是 executor_app_versions 缺列——mock 替身零感知。
  修复后 arch31-rollout 虽然会经过该路径（心跳每 30s 落库），但**没有任何一条断言
  SELECT 这两张表**；暴露依赖 admin 日志 warn（人工看日志才发现 15/5）。同型缺口再现
  （如下一个 jsonb 列漂移、采纳三态写错、整替 delete 漏 where）时，selftest 仍可能
  20/20 绿（fail-open 落库失败只 warn 不炸心跳）。
- **数据完整性风险**：deployedApps 是 releases devices 读面与「派发版本跟随设备事实」
  的事实源——静默不落库 = 前端恒空 + 版本跟随退化到部署行推断，无任何报错。
- **修复成本极低**：arch31-rollout 已有真库 + 双执行器 + 真实部署 + queryDb 助手，
  追加断言约 +40 行、0 新依赖、运行时长约 +2s（等 1-2 拍心跳）。

### Top2：app_deployment_events 事件表写路径（迁移 62/64 同型面）

- 九个写点（deploy/redeploy/approval×3/upgrade/stop/remove/stuck）+ deployCount 的
  DB GROUP BY 聚合 + /events 读面分页，全部只有 mock repo 单测；fail-open 语义
  （事件写失败不阻断主动作）意味着真库 DDL/约束缺口同样只会 warn。
- 数据完整性：事件表是部署域唯一持久化追溯面（append-only），静默失写 = 历史永久缺失。
- 补测形态：复用 arch31 harness，部署→升级→停止各动作后断言事件行数与 eventType。

### Top3：execution_artifacts 产物索引双轨写与读面（迁移 65 同型面）

- 索引表 repo 是 **@Optional 注入**——装配缺失静默降级，DDL 缺口零感知（与迁移 63
  缺列完全同款的「碰巧绿」形态）；GET /artifacts 三场景 + 回调双轨写 + TTL 双轨删
  均未在真库端到端跑过。
- 数据完整性：jsonb 清单列与索引表是双轨，单轨静默失败 = 两轨漂移（读面丢条目）。
- 补测形态：真库跑一次带产物的任务回调 → 断言 execution_artifacts 行 + GET /artifacts。

（P1 netrc 真 401 通道列为 top4 备选：单测形态尚可、E2E 一次性真机未固化，但凭据
通道出错是显式 401 而非静默失真，风险低于前三。）

## 4. Top1 补测方案（已实施）

**方案**：在 arch31-rollout-cross-instance-selftest.mjs 的终态断言段追加「协议 v7 设备
事实」断言组，把 5c 那次靠日志暴露的路径固化为直接断言：

1. `executor_app_versions` 行存在且 currentVersion='1.0.0'（canary 重部署同 packageUrl，版本不变）——
   钉住「deployedApps 持久化真的发生」（5c 缺列缺陷的直接回归闸：缺列时该 SELECT
   报错/0 行，断言红）；
2. 心跳落库无 warn：admin-B 日志不包含 `executor_app_versions` 失败关键字——
   钉住 fail-open 路径的静默失败面（applyReportedAppVersions catch → warn）；
3. `executors.installedPackages` 三态采纳：列被采纳为 JSON 数组（本链执行器不自装包，[] 即正确事实；NULL = 键被静默丢弃）——钉住
   协议 v7 第二键（当前 CI 无任何真库断言）；
4. `app_deployment_events` 事件流：deploy_created ≥2 且含 upgrade——钉住 top2 的
   最小核心写点（同链顺带，零额外成本）。

**门禁**：`npm run test:arch31-rollout` 全绿——**24 通过 / 0 失败 / 0 跳过**
（原 20 + 新 4；实测：executor_app_versions total=2 且 currentVersion='1.0.0' 匹配=2、
事件流 total=4 deploy_created=2 upgrade=2、installedPackages 两行均为 JSON 数组）。
CI 形态零改动（npm script 名与 ci.yml selftests job 引用原样，容器/进程清理无残留）。

**实施文件**：仅 scripts/arch31-rollout-cross-instance-selftest.mjs（1 文件，远小于 ≤4 上限）。

### 后续（未实施，按价值排序）

- top2 完整版：事件表九写点 + /events 读面 + deployCount 聚合真库断言（可继续挂在
  arch31-rollout 或另起 app-deployment-events selftest）；
- top3：带产物任务回调 → execution_artifacts 行 + GET /artifacts 真库断言（需要
  zip 内产物上报链，成本中等）；
- P1 netrc 真 401→200 通道 CI 化（复用 bug18-dispatch 的 Verdaccio 形态换 pypi+uv）。

## 5. 结论

「真库 E2E 是唯一防线」的防线本身目前只有一条部署链（arch31-rollout），且对 5c 暴露过的
设备事实落库面**没有直接断言**——本轮已补。top2/top3 与 5c 三缺陷同型（mock 掩盖 DDL/
写路径缺口），建议按序补齐；admin-api-e2e 与 e2e-full 两大真库链对近 10 轮的新表
（62-66）全部零覆盖，是结构性盲区。
