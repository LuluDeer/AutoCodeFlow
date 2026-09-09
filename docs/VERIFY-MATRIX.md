# 真机验证矩阵 Checklist（QA-04）

> 目的：把十五轮真机验证（V 系列）沉淀的「单测全绿 ≠ 能跑」教训固化为**按改动类型必跑**的清单。
> 用法：每轮开发按「变更类型」勾选对应行；验证结论写进 `docs/VERIFY-roundN-<date>.md`。
> 纪律来源：N2（PG enum 单测全 mock 未暴露）、N1（迁移链空库断裂）、第八轮 P0（分步表单）、W-20（win32 大小写）——全部是真机/跨平台才暴露的缺陷。

## 一、平台矩阵

| 平台 | 拓扑 | 覆盖状态 | 必跑场景 |
|---|---|---|---|
| Linux x86_64 (Docker Compose: PG16+Redis7+nginx) | 基线 | ✅ 每轮（第五轮起 V 系列全量） | 全部 |
| Windows 11 全栈（Node 24 + uv + WSL2 PG/Redis） | 基线 | ✅ 2026-09-05 R14 起入 CI（PR/dispatch e2e） | node 执行器全链 + python venv 链 + taskkill 树杀 + 中文/空格路径 |
| macOS（Intel / Apple Silicon） | 扩展 | ⬜ 待 DSK-01 | desktop 打包 + 注册/任务/回调 + 自启动 |
| Linux ARM64 | 扩展 | ⬜ 待 DSK-05/BUG-20 | multi-arch 镜像冒烟 |
| 裸机部署（非容器） | 扩展 | ⬜ 从未测 | 路径分隔符/信号语义/服务化（systemd） |

## 二、拓扑矩阵

| 拓扑 | 覆盖状态 | 关注点 |
|---|---|---|
| 单 admin + 单执行器 | ✅ 基线 | 功能冒烟 |
| 双 admin 实例（Leader Election） | ✅ 第五轮 V（80 execution 无重复，kill 后 35s 接管） | 触发不重复、Leader 迁移、claim 双保险 |
| 双执行器混布 | ✅ 第五轮 V（精确 2+2 无超卖） | loadScore、槽位释放、pinned/broadcast |
| admin 滚动重启 | ⚠️ 部分（N51 已知一次 401，自愈） | 心跳对齐、回调连续性、BullMQ 恢复 |
| Redis 宕机 / PG 重启 | ⬜ 待 QA-06 混沌 | fail-open 降级、PENDING 兜底 FAILED |
| 执行器断网 30s 恢复 | ✅ 部分（stale 扫描+活性探测） | 误判率、429 重试链不双跑 |

## 三、变更类型 → 必跑清单（核心表）

| 变更类型 | 必跑项（缺一不验收） |
|---|---|
| **调度器 / BullMQ / 队列** | ① compose 真机冒烟（15s fixed_rate 任务 gap 均值 ±20ms）② 空库迁移链双轮 ③ 双实例无重复触发 ④ 队列深度/指标端点可见 |
| **数据库实体 / 迁移** | ① 空库纯迁移链（禁 DB_SYNCHRONIZE）② 存量库续跑无损 ③ 迁移幂等 up/down 双跑 ④ 实体↔迁移漂移守卫（第十五轮 e2e-full 教训） |
| **executor-node src** | ① 全量 jest ② **ncc bundle 同 commit 重打**（W-18 守卫）③ Windows CI job ④ 真机注册/四类任务/回调/kill 全链 |
| **executor-python** | ① pytest 全量 ② Windows venv/P-3 直连链 ③ 回调三方 HMAC 测试向量一致（admin/node/py 同向量）④ uv/uvicorn 真链路 |
| **RBAC / 权限收紧** | ① 前后端同批发布（N11/W2 教训）② 三角色 × 端点矩阵 spec ③ Playwright 角色门控例 ④ api-reference 同步 |
| **token / 认证链** | ① register/token/心跳三点采纳 ② 401 自愈（forceTokenRefresh）③ 回调 HMAC 三方同测试向量 ④ 旋转后 30min→一次往返收敛 |
| **通知 / 外发** | ① 五渠道真发（wecom/dingtalk/slack/webhook/SMTP）② config-first 语义 ③ SSRF deny 段回归（198.18/100.64/::ffff:）④ 密码脱敏回显 |
| **SSE / 日志流** | ① nginx 60s 读超时下 15s ping 保活长流 ② 并发上限 503 ③ 断流轮询兜底 ④ 多实例容量口径（线性叠加） |
| **上传 / 部署链** | ① 500MB 包流式上传不驻留内存 ② nginx client_max_body_size 510m 对齐 ③ 版本隔离+回滚 ④ 部署指令鉴权头 |
| **admin-web 表单/页面** | ① lint+vitest+build ② Playwright 全量 29 ③ 分步表单跨步提交（getFieldsValue(true) 守卫）④ 非 admin 视角走查（403 面隐藏） |
| **桌面端 / IPC** | ① npm run test:main（路径域 selftest）② bundle drift 守卫 ③ 托盘/自启动/停机信号链（Win SIGBREAK） |
| **回调链路改动** | ① 批量回调 ≤100 分片 ② 死信落盘+重试预算+deadLetterCount 心跳 ③ KILLED 终态不被覆盖 ④ 槽位释放（含秒级完成 RETURNING 窗口） |

## 四、验证记录模板（VERIFY-roundN）

```markdown
# VERIFY-roundN（日期）
## 环境
- 拓扑 / 镜像 / commit / 平台
## 场景与断言
| # | 场景 | 断言 | 结果 |
|---|---|---|---|
## 新发现（真机才暴露的缺陷）
- N编号 P级 描述 → 修复 commit
## 临时放行回看（安全缺口候选）
- 本轮为通过验证做的任何临时放行 → 收紧措施
```

## 五、CI 与本清单的关系

- `ci.yml` 24 job 覆盖单测/构建/迁移链/e2e（Linux push + Windows PR）与 desktop-bundle-drift、npm-audit 守卫。
- 本清单覆盖 CI **不能**覆盖的面：真机拓扑（Leader 迁移、负载均衡）、渠道真发、长时稳定性、平台信号语义、性能水位。
- 每轮 PR 描述需附「本轮触达的变更类型 + 对应必跑项执行证据」。
