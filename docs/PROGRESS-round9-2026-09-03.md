# 第九轮进度报告（2026-09-03）

> 编排：侦察 → A/B/C/D 四路并行（python token 链+SDK 回调 / 401 指标+webhook 配置面 / Playwright 深化 / 只读 audit）→ V 真机 5/5 + audit N33-N36 → W 收尾修复（P1 register + N33-N36）→ 收尾。
> 基线：admin-api **861/861（53 suites）+ eslint 0/0** · executor-node **150/150** · executor-python **115/115** · autoflow-sdk **90/90** · admin-web vitest **35** · Playwright E2E **29/29** · acf-cli **48** · mcp-server **52** · registry-pypi **33** · node-sdk **43** · notify **7** · 全端 tsc/lint/build ✓。

## 1. 核心交付

### 1.1 python 侧 token 链修复 + 回调能力对齐（A 流，SDK 统一方向落地）

- **executor-python 三缺口修复**：`_fetch_token` 201 误判 + 未拆信封（动态 token 永远失败，恒回退静态）+ 缺 startupId——信封 util（对齐 executor-node/acf-cli 模式）+ 2xx 区间 + startupId 发送；register/heartbeat 采纳 tokenHash（三点不变量补齐 python 侧）。
- **autoflow-sdk 回调能力**（node-sdk 第七/八轮形态的 python 对等）：from_env 读 AUTOFLOW_CALLBACK_TOKEN/ADMIN_API_URL/EXECUTOR_ADDRESS（排除出 params 防污染）、CallbackClient（enabled/disabled_reason 语义对齐）、`ctx.report_success/report_failure` 便捷方法（CallbackItemDto 字段映射 + failureReason 客户端枚举校验）。python 任务首次具备与 node 任务对等的任务内回调能力。
- **N33 修复（W）**：executor-python 执行路径注入回调三变量——HMAC 算法移植（execution_callback_token.py），与 admin-api/executor-node **三方同一测试向量逐字节一致**；secret 解析优先级（EXECUTION_CALLBACK_SECRET → tokenHash → 共享 token）与 node 对齐。

### 1.2 回调 401 分类观测（B 流，交接 #3）

`autoflow_execution_callback_auth_total{result}` 七分类（ok / v1_expired / v1_binding_mismatch / v1_bad_signature / legacy_shared_invalid / missing_token / bad_address）——controller 层埋点（token util 保持纯函数供双端共享）、快照模式并入 prometheus render（N31 串行化天然覆盖）、七 series 恒在保 rate() 开箱可用。

### 1.3 webhook 配置面补全（B 流，V2 遗留观察闭环）

PATCH /notification/channels/webhook 合法（config 形状 `{url}`），config-first 语义与 V1 全渠道一致（保存 url 优先于逐请求参数）；URL query 参数名级脱敏自然覆盖（access_token=***）；掩码回显守卫防覆盖真值。

### 1.4 Playwright 29/29（C 流，交接 #5）

新增 4 例 pinned 部署全链：在线 happy path（绑定展示→UI 触发→executorAddress 无漂移）、离线语义（failureReason=executor_offline + UI 失败分类可读）、目标不存在（无 fleet 回落）、全 UI 闭环（创建→触发→执行→历史）。

### 1.5 audit N33-N36 + V 真机 P1（D/V → W 修复）

- **P1（V 真机抓到）**：R9 修好 fetch 后，python register 用动态 token 打只认共享 bootstrap token 的端点 → 401，富元数据未落库（此前被"fetch 恒失败"掩盖）→ register 改静态 token + 状态码检查 + 401 告警路径。
- **N34(P3)** issuedTokenCache 有界化（MAX=1000 + 24h TTL——刻意不用 60s 以保真机验证的 25.5min 幂等复用）。
- **N35/N36(P3)** artifact query token 风险标注、ci-local 头部差异声明补三处。

## 2. 真机验证（V，docs/VERIFY-round9-e2e.md）

5/5 PASS：①python token 链（在线稳定 + /token 非风暴："Idempotent token reuse (same startupId); no rotation" + pinned python glue 任务全链 dispatch success）；②401 七分类指标全中；③Playwright 29/29；④webhook 配置面 config-first 兑现（含脱敏与掩码回显守卫）；⑤ci-local 11 job 全绿（已覆盖 python/SDK 面）。

## 3. 基线

admin-api **861/861（53 suites）**（+22）· executor-node **150** · executor-python **115**（+29）· autoflow-sdk **90**（+27）· admin-web **35** · Playwright **29**（+4）· acf-cli **48** · mcp-server **52** · registry-pypi **33** · node-sdk **43** · notify **7** · 全端 tsc/lint/build ✓。

## 4. 第十轮建议

1. **CI push 真跑**（仍阻塞于 GitHub 凭证；ci-local 十端等价全绿持续兜底）。
2. **回调 token 生产观测**：V 已验证七分类，可再补 Grafana 面板 JSON 或告警规则示例进 docs。
3. **admin 手动旋转 token 后的执行器密钥对齐广播**（round9 已三点采纳+幂等签发，剩余是 UI 旋转时的即时通知/失效语义评估）。
4. **SDK 统一与示例**（路线图 #10）：node/python 双 SDK 回调已对齐，可梳理统一 README/示例矩阵与版本发布流程（npm/PyPI publish 管道）。
5. 跨平台矩阵（需真机）；minio 链 3 moderate 等上游。
