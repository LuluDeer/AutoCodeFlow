# 已知缺口登记（2026-11-16）

本文件登记**明确识别但不在本批处理**的缺口，避免下次评审重新发现、或误当成新缺陷。
每条写清：现象、为什么不在本批做、后续入口在哪。

## 1. 产物库 `/artifacts`（P1-3 已交付筛选 / 仍缺三样）

| 缺口 | 现状 | 不在本批做的原因 | 后续入口 |
|---|---|---|---|
| 无 `content-type` 列 | 类型只能从文件名扩展名派生（15 项白名单）；无法区分同名不同 MIME、也无服务端可信类型 | 需要在 `execution_artifacts` 表加列 + 回调写入侧（执行器上报）同步，属契约扩张，非前端可控 | 后端迁移 + `execution-callback.collaborator` 写入点 |
| 无保留期字段 | 索引行只有 `createdAt`（写入时间），没有 `expiresAt`/保留策略；评审建议的「保留期」列无法如实展示 | 保留策略归 `artifacts-retention.service` 的清理任务，前端展示前需先有单一事实源 | 保留期服务暴露读接口后加列 |
| 不支持按 `executionId` 过滤 | 索引端点只支持 `applicationId` / `taskId` / `q` / `from` / `to` / `ext` / 分页 | 单次执行的产物已由 `GET /tasks/executions/{execId}/artifacts` 覆盖（读 jsonb 清单），索引面再加一条近似过滤价值低、且需改契约 | 若确有「从执行直达索引行」需求再评估 |
| 产物 blob 单端点未端到端验证 | 走查夹具里 `GET /tasks/executions/{execId}/artifacts/{name}` 是 404，图片/文本内联预览在浏览器端只走到 `loadFailed` 分支 | 属夹具缺口（后端存在该端点），真实字节流需要在有后端 + 有产物的环境跑 | 真实栈验收时补夹具或直连后端 |

## 2. 测试与夹具

| 缺口 | 说明 |
|---|---|
| 夹具 404 端点（`/ai/providers`、`/app-deployments/stats`、`/audit/actions`、`/agent/sessions/ag-6001/approvals`） | 走查脚本未镜像这些端点；后端均存在，**不视为产品缺陷**。`/app-deployments/stats` 的 404 恰好是 P1-8 降级路径的演示场景 |
| antd v6 弃用告警 | `Alert message`、`Modal destroyOnClose`、`Drawer width`、`Descriptions span`、`rc-collapse children` 等；属存量迁移噪声，未在本轮静默或改造 |
| 375 右下角浮动助手球 SVG | 探针记录其 rect 越界，但 `documentElement.scrollWidth == clientWidth`，不产生应用层横滚；非应用缺陷 |

## 3. 已在本批顺手修掉的存量问题

- `log-json.test.ts` 1500 层嵌套栈溢出（`safeStringify` 的 replacer 把 `JSON.stringify` 逼进递归路径）：改为**迭代判环 + 无环走原生快速路径**，循环引用仍回落 `"[Circular]"`、BigInt 仍返回 null，**未改断言**。见提交 `7ce9ef2a`。

## 4. 环境约束（影响复现方式，不是产品缺陷）

- 宿主曾出现 MCE 硬件级错误（CPU machine check）：**WSL 内跑 jest 会崩核**；多个重进程并发（如全量 vitest 多 fork、4 个 e2e spec 同进程）也会把宿主打死。
- 现行可用路径：**Windows + `E:\software\codingSoft\nodejs\node.exe`（v24.21.0）** 跑后端 jest / e2e；WSL 仅作 PG16 + Redis 数据服务，且需前台进程保活，否则空闲回收会带走服务。
- canonical `swagger:export` 已可在该路径下跑通（`ACF_OPENAPI_EXPORT=1` + `openapi-export.e2e-spec.ts` + `inject-openapi-en` + `gen:api-types`），**不要再手工编辑 `openapi.json`**。
- 复现命令详见 `next-batch-p2-plan.md` 的「环境备注」。
