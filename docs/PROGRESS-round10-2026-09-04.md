# 第十轮进度报告（2026-09-04）

> 编排：A/B/C/D 四路并行（Grafana+告警 / SDK 发布管道 / 旋转 token 即时对齐 / 只读 audit）→ W 收尾修复（N37-N42）→ 收尾。CI push 仍阻塞于 GitHub 凭证（用户侧获取中）。
> 基线：admin-api **870/870（53 suites）+ eslint 0/0** · executor-node **158/158** · executor-python **115/115** · autoflow-sdk **91/91** · admin-web vitest **35** · Playwright **29/29** · acf-cli **48** · mcp-server **52** · registry-pypi **33** · node-sdk **43** · notify **7** · 全端 tsc/lint/build ✓。

## 1. 核心交付

### 1.1 可观测性深化（A 流，交接 #2）

`docs/observability/`：可导入 Grafana dashboard（11 panels：调度健康 5 / 回调认证 3 / 进程资源 3，`$datasource`+`$instance` 变量）+ 6 条告警规则（SchedulerDown/QueueBacklog/CallbackAuth 三级）+ README（抓取配置含 /api/metrics JWT 的两种解法、指标字典、series 核对清单）。全部 series 与源码逐字核对零偏差；tick 无 histogram 的 p95 不可推导等两处如实标注。

### 1.2 SDK 发布管道（B 流，路线图 #10 收尾）

`.github/workflows/release.yml`（tag v* 触发）：version-guard（tag 与四处版本一致性，本机三态实测）→ publish-npm（@autoflow/sdk + autocodeflow-mcp-server，`files:["dist"]` 修复空包隐患）→ publish-pypi（build + gh-action-pypi-publish）。双 SDK README（安装/Quickstart/env 表与 sdk-guide 七行逐字一致/发布流程）+ sdk-guide SDK 矩阵。**顺带修掉发布级 bug**：autoflow-sdk 未声明 pydantic 运行时依赖（发布包 import 即崩）。npm/PyPI 占用已核实（@autoflow/sdk、autocodeflow-mcp-server 空闲可用）。

### 1.3 旋转 token 即时对齐（C 流，交接 #3）

评估发现窗口远比交接假设严重：手动旋转后执行器心跳 401 靠 60s 正向缓存侥幸通过，错过即持续 401 直到 30 分钟定时刷新，期间 90s 判离线级联。实现双修：
- **executor-node 401 自愈**：dynamic-token 请求 401 → forceTokenRefresh（立即重取+采纳 tokenHash）→ token 变化仅重试一次（static/register 模式不触发；防风暴由 admin issueToken 幂等收敛）——窗口收敛到一次请求往返。
- **admin rotateToken 播种缓存**：UI 轮换的新 token 直接写入 issuedTokenCache——执行器自愈复取时拿到的就是 UI 展示的那个 token，零二次轮换。
executor-node 158（+8）、admin-api 864（+3 at C 时点）。

### 1.4 audit N37-N42 全消（D → W，全部 P3）

- **N37** webhook 优先级链修正：**显式请求参数 > 已保存且启用的渠道 config > env**（原 config-first 会把显式 webhookUrl 静默改道、disabled 渠道 url 也生效）——ChannelConfigStore 增 enabled 并行跟踪，testChannel pin/restore，与第九轮冲突用例按新语义改写。
- **N38/N41** api-reference 补 `/notification/send` 行；rotate-token 行双端区分（node ≤30s 自愈 / python 30min 窗口+共享兜底）；"will retry via heartbeat" 幽灵注释三处改真实机制（register-on-token 瘦行副作用写明）。
- **N39/N40** sdk-guide python 判据 `ctx.http` → `ctx.callback.enabled`（原措辞照写即 AttributeError）；TaskContext 三敏感字段 `repr=False`（print 不再泄漏 one-shot token，补防泄漏测试）。
- **N42** release.yml 两 publish job 加 `environment: release` 审批门（注释含配置路径与 Trusted Publishing 迁移说明）。

## 2. 基线

admin-api **870/870（53 suites）**（+9）· executor-node **158**（+8）· executor-python **115** · autoflow-sdk **91**（+1）· admin-web **35** · Playwright **29** · acf-cli **48** · mcp-server **52** · registry-pypi **33** · node-sdk **43** · notify **7** · 全端 tsc/lint/build ✓。

## 3. 阻塞与第十一轮建议

**阻塞（唯一）**：GitHub push 凭证——本地 develop 领先 origin 95+ commits，release.yml/ci.yml 等 10 轮成果均待推送验证。等用户提供 PAT（repo 权限）或自推。

1. **CI push 真跑 + release 首发演练**（凭证到位后）：push develop 盯 Actions 首跑修环境差异 → 打 v1.0.0 tag 演练 release.yml dry-run 链路。
2. **`packages/autoflow-sdk-node` 旧重复包清理**（B 流盘点发现：@autocodeflow/sdk 0.1.0 与 autoflow-sdk 1.0.0 重复，无消费方——评估删除或归档）。
3. **executor-python 401 自愈对齐**（C 流遗留：python 侧仍 30min 窗口，可移植 forceTokenRefresh 语义）。
4. `reload-config` 既有缺陷（C 流发现：controller 用新 token 推配置而执行器只认旧 token → 必然 401）。
5. 跨平台矩阵（需真机）；minio 链 3 moderate 等上游。
