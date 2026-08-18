# AutoCodeFlow Agent Handoff

> 本文件是跨会话交接文档：每个会话结束前更新「状态快照」，新会话从这里恢复。
> 上一个版本曾被误删（3c272c9），本版为重建精简版，状态以代码与 docs/optimization-notes.md 为准。

更新时间：2026-08-18
当前分支：`develop`

## 状态快照

- 最新提交：见 `git log -1`
- 测试基线（全绿）：admin-api 403/403 (jest)、executor-node 76/76 (jest)、executor-python 44/44 (pytest)、admin-api tsc --noEmit 通过
- 工作区：干净（除本文件）
- 近期完成：LOG-01 回调日志截断治理——handleCallback 检测两种截断标记（node `[logs truncated, ...]` / python `[truncated, total ...]`）时自动分页拉取 executor `/api/logs` 全量日志入库（兼容 node 端点无 limit 与 python 端点 limit≤2000），回填失败降级存截断版不阻断回调；同时清理 task.processor 中无调用点的死代码 fetchAndStoreLogLines

## 会话恢复速查

```bash
# 各子项目独立运行命令，根目录无统一 workspace 入口
cd apps/admin-api && npx jest && npx tsc --noEmit -p tsconfig.json
cd apps/executor-node && npx jest
cd apps/executor-python && python3 -m pytest -q
cd apps/admin-web && npm run build && npx vitest run   # E2E 需先起环境
```

注意：
- `apps/executor-desktop/resources/executor-node/index.js` 是生成物，源码改 `apps/executor-node/src` 后走打包流程更新。
- 文档可能比代码旧，以代码+测试交叉校验。

## 开发准则

1. 小步提交：一个方向一批改动，先补测试再改实现，提交前跑该子项目验证命令。
2. 每次提交信息用中文 conventional commits（feat/fix/docs/chore/refactor/test）。
3. 功能落地后同步更新 `docs/api-reference.md` 与 `docs/optimization-notes.md` 的状态标记。
4. 会话结束前更新本文件「状态快照」并提交。

## 长期路线图状态

原始 12 方向（d770032）进展：

| # | 方向 | 状态 |
|---|------|------|
| 1 | 版本历史与发布快照 | ✅ 已完成（含回滚） |
| 2 | 执行失败原因分类 | ✅ 已完成（executor 侧可再细化） |
| 3 | Webhook / API 认证模型 | ✅ 已完成（rawBody+时间戳 HMAC，Public 路由强制 secret） |
| 4 | 任务超时 / 时区 / 重试 | ✅ 已完成（2026-08-18 验证：trigger/rollback/scheduled 三入队路径均带 attempts+指数退避，processor 失败 rethrow 使 BullMQ 重试生效，均有单测） |
| 5 | 执行器重启恢复 + 负载感知 | ✅ 已完成（心跳携带 runningTaskCount，dispatch 按 loadScore=runningTaskCount/max 选最低负载 + 乐观锁防超发，广播模式不占计数，callback 释放槽位，均有单测） |
| 6 | 应用包版本隔离 | ✅ 已完成（不可变 release 目录 + current 软链 + 回退） |
| 7 | 心跳 / 注册稳定化 | ✅ 已完成（连通性自检、退避重试） |
| 8 | Admin Web 与 E2E | ✅ E2E 35/35（Linux x86_64）；平台矩阵未覆盖 |
| 9 | CLI 与 MCP 能力对齐 | ⬜ 未验证对齐度 |
| 10 | SDK 统一与示例 | ⬜ 未系统梳理 |
| 11 | 日志外置存储（MinIO） | ⬜ 未做（当前写主库 execution_log_lines） |
| 12 | 桌面执行器跨平台 | ⬜ 未验证 |

## 下一步建议（按优先级）

1. **日志外置存储**：日志写 MinIO，主库只存引用（见 optimization-notes 2.6）。
2. **CLI/MCP 能力对齐梳理**：对照 api-reference 列缺口清单。
3. **多执行器负载均衡实测**：单测已覆盖 loadScore 选择与乐观锁，但缺多实例真机验证（心跳节奏、计数漂移恢复）。

## 未覆盖验证项

- macOS / Windows / ARM64 部署
- 通知渠道（企业微信/钉钉/邮件）实测
- 私有 npm/PyPI 仓库集成
- 多执行器负载均衡行为（选择逻辑已有单测，缺多实例实测）
- 大规模并发压测
