# 第七轮进度报告（2026-09-03）

> 编排：侦察 → A/B/C/D 四路并行（依赖+lint 清偿 / admin-web 403 门控 / prom-client 落地 / 全新 audit）→ audit triage → E1/E2 修复（N17-N24）→ V 真机验证 5/5 PASS → W 真机新发现修复（V1-V5）→ V2 真机复验 → 收尾。
> 基线：admin-api **774/774（52 suites）** · executor-node **125/125** · executor-python **86/86** · admin-web vitest **33** · acf-cli **48** · mcp-server **52** · registry-pypi **30** · autocodeflow-node-sdk **32** · autocodeflow-notify **7** · 全端 tsc/lint/build ✓（admin-api lint **0 errors/0 warnings**）。

## 1. 交接项消化（第六轮交接 6 项 → 本轮完成 5 项）

| 交接项 | 状态 |
|---|---|
| 通知渠道真机 | ✅ 完成（五渠道外发全通 + W 修复 config 解耦后 V2 复验） |
| CI 首跑 + N16 audit 兜底 | ✅ 完成（npm-audit job + 依赖清偿；push 真跑待远端） |
| admin-web 403 门控跟进 | ✅ 完成（/notifications RequireAdmin + settings AI Tab 降级） |
| lint 存量清偿 | ✅ 完成（163→0 errors/0 warnings + coverage 阈值落地） |
| prom-client 评估 | ✅ 落地（`GET /api/metrics`） |
| 跨平台矩阵 | ⬜ 需 macOS/Windows 真机 |

## 2. 代码流成果

### 2.1 依赖与 lint 清偿（A 流）

- **N16 依赖清偿**：四端 `npm audit fix`（官方源）非破坏执行——admin-api 6 漏洞（含 browserslist HIGH）→ 3 moderate（minio 链上游未修，等 minio 发版）；executor-node/acf-cli/mcp-server **清零**（executor-node 的 qs 经 `overrides` 升 6.16 验证兼容，未 force express@5）。CI 新增 `npm-audit` job（matrix 四端，官方源，--audit-level=high 红灯）。
- **lint 清偿**：163 errors → **0 errors/0 warnings**。根因之一是 tsconfig exclude 与 eslint project 脱节（test/spec 全部解析错误）——新建 tsconfig.eslint.json 纳入；固化 no-unused-vars 下划线约定；删除真实死代码。CI lint step 恢复。
- **coverage**：阈值按实测水位地板化（68/58/56/69）防倒退，CI 恢复 `--coverage`。

### 2.2 admin-web 403 门控（B 流）

- `/notifications` 路由级 RequireAdmin + 菜单/铃铛入口隐藏；settings 页 AI Tab 非 admin 降级（不发 403 请求 + 只读提示，对齐 round5 TokenSection 先例）。
- 盘点确认 TaskDetailPage/ApplicationDetailPage 调用的 suggest-schedule/analyze 端点未收紧，无 403 风险。
- 建立 admin-web 组件测试先例（jsdom + @testing-library/react，2 个 spec 5 例）。

### 2.3 prom-client /metrics（C 流）

- prom-client 15.1.3（独立 Registry 注入）：8 条 `autoflow_scheduler_*` series（tick/triggers/skipped×reason/dependency/queue depth）+ collectDefaultMetrics（可关）。抓取时读快照 reset+inc，对调度热路径零侵入。
- `GET /api/metrics`：继承 MetricsController 类级 JwtAuthGuard（与 /metrics/scheduler 姿态一致）、@Res() 直写 text/plain（install.sh 先例）；`METRICS_PROMETHEUS_ENABLED=false` → 404。`/metrics/scheduler` JSON 端点向后兼容不动。
- install-cmd 对未配置 ADMIN_API_URL 抛 503（round6 遗留观察①）。

### 2.4 audit N17-N24（D 流 → E1/E2 修复）

- **N17(P1)** pinning/broadcast 互斥只查请求 DTO，PATCH 合并态可产生"broadcast+已 pin"非法状态（pinning 静默丢弃）→ update() 在 Object.assign 后对合并实体兜底校验（assertPinBroadcastExclusive），真机复验两条绕过路径均 400。
- **N18(P1)** registry-pypi 索引页每次请求全量读盘算哈希 → 上传时流式分块（1MiB）算 sha256 写 sidecar，索引页读 sidecar；上传走临时文件+原子 rename，峰值内存 O(1MiB)。
- **N19(P2)** admin-web TaskFormPage 消费 executorId（方案 a：pinned 选择器绑 id、提交按模式显式 set/clear、pinned 清 legacy appName；纯函数抽到 executor-mode.ts 保证 react-refresh 与可测性）。
- **N20(P2)** MCP 过时注释修正 + 新增 update_task 工具（executorId 支持 null 清除）；CLI create/update 补 `--executor <id>`。
- **N21(P2)** registry-pypi 同名上传静默覆盖 → 同哈希幂等 200/异哈希 409。
- **N22(P3)** autocodeflow-notify SDK 打不存在端点必 404 → admin-api 新增 `POST /api/notification/send`（登录态，复用 payload/脱敏，支持 channels 子集与 webhookUrl 追加）。
- **N23(P3)** autocodeflow-node-sdk required 含执行器不注入的凭证（SEC-01 有意剥离）→ fromEnv 收敛三变量必填、回调凭证可选，缺失时 disabled client 明确报错而非构造即崩。
- **N24(P3)** install.sh 指向不存在的 /static tar.gz（假承诺）→ 删除远程分支，明确错误语义（"via executor-packages API or project checkout"）。

## 3. 真机验证（V → W → V2 闭环）

- **V 一轮 5/5 PASS**（docs/VERIFY-round7-e2e.md）：五渠道外发到达 mock（email 完整 SMTP 会话）、prom 端点 counters 单调增长 + 开关 404、N17 互斥 400、send 端点全语义、/metrics/scheduler 回归。
- **V 抓到 5 个真机缺陷 → W 修复 → V2 复验**（docs/VERIFY-round7v2-fixes.md）：
  - V1(P1) PATCH 保存的渠道 config 不影响外发（外发读 env）→ ChannelConfigStore config-first，发送路径拿未脱敏原值；
  - V2(P2) SSRF 拦截 fail-open 且 API 恒 success → 响应体 per-channel results（sent/blocked/failed/skipped），sendWebhook 直调 blocked → 400；
  - V3(P3) deny 列表缺 198.18.0.0/15、100.64.0.0/10（V 曾借 TUN 接口绕过）→ isBlockedAddress/classifyAddressRisk 双处补齐；
  - V4(P2) PATCH 未知渠道 key 500 → 400；
  - V5(P3) webhook 渠道引用从未定义的 env 键 → 死引用删除。

## 4. 基线

admin-api **774/774（52 suites）**（+44）· executor-node **125** · executor-python **86** · admin-web **33**（+14）· acf-cli **48**（+3）· mcp-server **52**（+4）· registry-pypi **30**（+9）· node-sdk **32** · notify **7** · admin-api eslint **0/0** · 全端 tsc/build ✓。

## 5. 第八轮建议

1. **CI push 真跑**：本机 12+2 jobs 全部等价验证过，push develop 后观察首次 Actions 运行修环境差异。
2. **SDK 通道统一**（N23 根因）：执行器一次性 per-execution 回调 token 机制设计（executor→任务子进程注入、SDK 回调、admin-api 验证三端契约）——是任务内 SDK 回调能力的正道。
3. **executor-packages artifact 通道**：install.sh 当前"明确失败"语义应升级为真 artifact 下发（复用 executor-packages 上传通道）。
4. **通知渠道 config 热更新一致性**：V1 落地 config-first，但 sendTest 与定时任务外发的 URL 缓存/刷新语义建议再审一轮。
5. **admin-web 页面级 E2E**（组件测试先例已建立，可铺 Playwright）；桌面跨平台矩阵（需真机）。
6. **registry-npm 落地**：目前仅 verdaccio config.yaml，与 registry-pypi 的自研实现不对称，评估是否自研或文档化 verdaccio 部署。
