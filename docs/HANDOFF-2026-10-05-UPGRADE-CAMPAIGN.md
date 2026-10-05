# AutoCodeFlow 交接简报（Windows 侧 → Linux 侧，2026-10-05 晚）

> 来源：Windows 侧编排 agent（项目总监多轮战役，13 轮 / 22 提交，见
> [PROGRESS-2026-10-05-upgrade-campaign.md](./PROGRESS-2026-10-05-upgrade-campaign.md)）。
> 性质：**交接**——接手前需要知道的事实、平台相关注意项与验证清单。
> 全部在 develop 推进（c46d88c6..a54369e1），未动 main；工作区干净。

## 一、本日落地面速览（细节以 PROGRESS 台账为准）

- **admin-api**：F-1 HA 触发配置漂移对账（`SCHEDULER_RECONCILE_EVERY`，默认 5，指纹重排）、
  stale 扫描 keyset、补偿 NEVER_DISPATCHED、日志行 512KB 上限、env 14 键补声明、
  AGENT_MEDIA_RETENTION_DAYS 收口、openaiMaxTokens 可配、**任务导入/导出 API（E-1）**
  （secrets 三层红线）。测试 4567，覆盖率 78.72/82.86/90.2 全超线。
- **admin-web**：monaco 懒加载独立 chunk、PageHeader/骨架统一、CSV 导出、a11y 包
  （useDrawerA11y×4 页/status-color 收敛）、快捷键（`?`+`g d/t/e/x/a`）、TaskList 列设置、
  **TaskFormPage 2170→889 行拆分**、语言切换冲掉未保存修改的 P1 修复。测试 1561。
- **desktop**：更新即通知、托盘检查更新/日志夹、隐藏页轮询门控、heartbeat 停止竞态、
  托盘启停互斥、配置导入/导出（掩码双层防线）、日志导出、i18n 二期收尾（27 处）、
  死样式清扫。test:main/test:renderer 全绿。
- **执行器双端**：py 超长行收尸（limit=1MB）/停机排水 503/uv 树杀/背压 warn；
  node timeoutSeconds 三键别名/sandbox_unavailable 归因+spawn 期分类/截断 marker
  对齐 admin 正则。
- **协议 SSOT**：ExecutionCallback/CallbackArtifact 收编 protocol.json，双生成器
  唯一入队口 warn-only 对账闸；secrets 16 条运行时语义向量等；PROTOCOL_VERSION 未 bump
  （纯增量登记，字段面零变化——evolutionRules 只对线缆字段增删要求 bump）。
- **CLI/MCP**：TOTP 登录（P1，此前 TOTP 用户无法用 CLI）/task export|import/batch/
  apikey/webhook/glue/approval/app upload/upgrade-all 灰度；MCP 49→52 工具、模板改走
  CORE-03。
- **deploy/观测/CI**：health 设退出码+补 python 探测（verify_phase /health/live→/health，
  旧值恒 45s 白等）/logs 白名单；告警守卫三面化（alerts+dashboard PromQL+阅读版同一
  指标清单）；grafana 看板自动 provisioning；ci.yml 补 compose-sandbox+install-sha256
  （gates）与 control-plane-pull（selftests）；docs-site 1.5.3→1.8.0+sync-check 纳入
  acf-cli；删 2 死脚本。

## 二、平台相关注意项（Linux 侧必读）

1. **desktop-bundle-drift 的字节闸②**：本轮三次重打（eebd854f/01137b88 等）的
   ② 均由 **Windows 本机 ncc 0.45** 回填。按 2026-09-26 注记（ncc 0.45 产物与 map
   均无绝对路径）跨平台应逐字节一致，CI 是权威复验——**若 CI 的
   desktop-bundle-drift 红**，从该 job 日志取 actual 回填
   `apps/executor-desktop/executor-node-bundle.sha256` 末行（语义闸①不依赖平台，
   不应红）。
2. **openapi.json 重导出（建议 Linux 侧第一件事）**：任务 export/import 两端点的
   注解已齐，但 `swagger:export` 需要 DB+Redis 在跑（Windows 本机 Redis 关闭未能
   导出）。导出后**必须** `node scripts/check-openapi-response-schema.mjs --update`
   刷基线（覆盖 70→72），否则该 CI job 会因新端点缺基线报红。
3. **ci.yml 新增内容**：gates job 加 2 个零依赖守卫 step；selftests 串跑加
   `test:control-plane-pull`（自建两端+自拉 PG16/Redis7，预估 +3-5min，job 超时
   45min 余量充足；若 runner 上 flaky，先降级回包内 `--dry-run` 形态并在台账记录）。
4. **deploy.sh health 语义变化**：现在有失败会 **exit 1**（此前恒 0）——任何把
   `deploy.sh health` 当「恒成功」消费的自动化（cron/Agent）需要知晓。
5. **check-alerts-rules 扩面**：现在 dashboard JSON 的 PromQL 也进守卫（同 42 指标
   清单）；改 metrics 名时 alerts 与 dashboard 会一起红，这是有意行为。
6. **grafana provisioning 已启用**（allowUiUpdates:false）：dashboard 以仓库 JSON
   为准，UI 手改会被接管；compose 单文件 bind mount 在 git pull 换 inode 后需容器
   重建（README 已注明）。
7. **新 env 键**：`.env.example` 补了 14 键（含 SCHEDULER_RECONCILE_EVERY、
   OPENAI_MAX_TOKENS、REDIS_HOST/PORT 等），`check-env-drift` 绿；部署侧无需动作，
   但 doctor/compose 模板若有自己的键清单可对一下。
8. **执行器 node 失败分类新增来源**：runTaskInner catch 现在会给 spawn 期失败
   （ENOENT→runtime_missing、bwrap→sandbox_unavailable）带 failureReason——admin
   侧若有按该字段聚合的告警，计数口径会多出这两类（BUG-10 对齐的正向副作用）。

## 三、Linux 侧验证清单（接手时按序跑）

```bash
git pull origin develop
npm run test:api && npm run test:node && npm run test:python && npm run test:web
npm run test:cli && npm run test:mcp && npm run test:desktop
npm run typecheck:all
npm run check:desktop-bundle-drift && npm run check:env-drift
npm run test:alerts && npm run test:deploy-script
cd packages/docs-site && node scripts/sync-check.mjs
# 然后做 §二.2 的 openapi 重导出 + --update
# 有真机时：CLI login TOTP 交互路径手工 smoke 一轮（vitest 驱动不了 TTY）
```

## 四、已知遗留（优先级序，详见 PROGRESS 台账「遗留」节）

1. openapi.json 重导出+基线刷新（见上，唯一需要环境条件的事）。
2. 升级灰度的「指定版本」语义：UpgradeAllDto 不收 version（CLI help 已注明取舍）；
   要做需服务端先立 DTO 任务。
3. python win32 内存上限（Job Object，L）或文档化登记。
4. desktop getHistory 推送化（M，收益中低）；`--json` 语义冲突的 deprecation 周期。
5. CLI TOTP 交互路径真机 smoke。
