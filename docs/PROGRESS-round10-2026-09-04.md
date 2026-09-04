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

## 3. CI 首跑修复闭环（2026-09-04，gh 凭证到位后）

用户配置 gh 凭证并同步 GitHub 后首轮 CI 6 个 job 失败，全部为环境差异（本机 npmmirror 源/node 24 与 CI node 20/干净环境的差异）。三轮修复全绿：

1. **node 20→24**（npm 10 对 npm 11 生成 lock 的解析差异 → 3 个 npm ci 失败）
2. **autoflow-sdk-node lock 官方源重新生成**（npmmirror 混合源 lock 与 npmjs 依赖树不一致：@emnapi/core@1.11.3 missing；官方源 npm ci 干净 venv 验证 + 43/43 测试回归）
3. **python jobs**：python-packages 补 respx、`pytest` → `python -m pytest`（cwd 进 sys.path，修 registry-pypi "No module named main"）——干净 venv 逐一模拟验证
4. **npm-audit job 退避重试**（registry audit endpoint 偶发 503 非真实漏洞，三次退避后真实 HIGH+ 仍红灯）

最终：**CI 13 jobs / 19 实例全绿**（run 33834427947），develop 与 origin 同步，路线图"CI push 真跑"正式闭环。

## 4. 阻塞与第十一轮建议

1. **release 首发演练**：打 v1.0.0 tag 走 release.yml（需先配置 NPM_TOKEN/PYPI_API_TOKEN secrets 与 Environments(release) 审批人）。
2. **`packages/autoflow-sdk-node` 旧重复包清理**（B 流盘点发现：@autocodeflow/sdk 0.1.0 与 autoflow-sdk 1.0.0 重复，无消费方——评估删除或归档）。
3. **executor-python 401 自愈对齐**（C 流遗留：python 侧仍 30min 窗口，可移植 forceTokenRefresh 语义）。
4. `reload-config` 既有缺陷（C 流发现：controller 用新 token 推配置而执行器只认旧 token → 必然 401）。
5. 跨平台矩阵（需真机）；minio 链 3 moderate 等上游。

---

## 补记：v1.0.0 首发闭环（2026-09-04）

release.yml 全链演练成功，三包正式上线（run 33851030463，含一次审批门 waiting + 一次 token 更换后 re-run --failed）：

- **npm**：[`@autocodeflow/sdk@1.0.0`](https://www.npmjs.com/package/@autocodeflow/sdk)、[`autocodeflow-mcp-server@1.0.0`](https://www.npmjs.com/package/autocodeflow-mcp-server)
- **PyPI**：[`autoflow-sdk@1.0.0`](https://pypi.org/project/autoflow-sdk/)（wheel + sdist）

过程决策与踩坑：①`@autoflow` org 名被第三方抢注 → 包名定稿 `@autocodeflow/sdk`（org 与仓库同名，commit `f0f8b96`，删旧 tag 重打）；②npm 2FA 403 → 换 Classic Automation token 后 `gh run rerun --failed` 成功；③environment 审批门两次实测生效。下次发布：改四处版本 → 打 tag → Approve → 全绿即发布。
