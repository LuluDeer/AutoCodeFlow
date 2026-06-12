# Agent 工作笔记

> 这是我自己的运维/调试记录，不是给其他人看的文档。记录踩过的坑、环境实际状态、待修复问题，每次工作完更新。

---

## 环境实际状态（2026-06-11）

### 基础设施
- **PostgreSQL**：localhost:5432，DB=autocodeflow，用户=autocodeflow，密码见 .env ✅
- **Redis**：localhost:6379，有密码（见 .env），直接 `redis-cli -a <密码> ping` 返回 PONG ✅
- **代理**：机器上有 socks5://127.0.0.1:7897，会影响 executor-python 启动时的注册请求，但不阻断核心功能

### 各服务启动方式

| 服务 | 启动命令 | 端口 | 状态 |
|------|---------|------|------|
| admin-api | `cd apps/admin-api && npm run start:dev` | 3002 | ✅ 已验证 |
| admin-web | `cd apps/admin-web && npm run dev` | 5173 | 未测试 |
| executor-python | `cd apps/executor-python && .venv/bin/python main.py` | 8001 | ✅ 已验证 |
| executor-node | `cd apps/executor-node && npm run dev` | 未确认 | 未测试 |

**注意**：executor-python 必须用 `.venv/bin/python`，不能用系统 `python3` 直接装包（PEP 668 保护）

### 健康检查端点
```
GET http://localhost:3002/health   # admin-api，返回 JSON
GET http://localhost:8001/health   # executor-python，返回 JSON
```

---

## 已知 Bug / 待修复

### 🔴 高优先级（阻塞上线）

1. ~~**BullModule 未配置 Redis 密码**~~ ✅ 已修复（`password: cfg.get('redis.password')` 已在代码中）

2. ~~**executor-python 启动脚本缺失**~~ ✅ 已修复（Makefile 已改用 `.venv/bin/pip` 和 `.venv/bin/uvicorn`）

3. **proxy 环境下 executor 注册失败无重试上限**
   - 问题：启动日志显示 `Register failed (will retry via heartbeat)`，代理环境会让首次注册失败，依赖心跳补救
   - 修复：注册逻辑加超时控制，启动时明确打印当前网络配置

### 🟡 中优先级（影响体验）

4. **admin-api 端口是 3002 不是 3000**
   - 很多人会假设是 3000，没有任何地方显式说明
   - 修复：在启动日志里打印完整地址，前端 vite proxy 配置也要核对

5. **健康检查 unhealthy 但服务能用**
   - /health 返回 unhealthy 但 API 正常响应，这会让监控误报
   - 根因是 Redis 密码问题（见 Bug #1），修了 #1 就解决

6. **没有统一启动脚本**
   - 依赖顺序：PostgreSQL + Redis → admin-api → executor-*
   - 目前需要手动分别启动，没有 Makefile 或 docker-compose 本地开发配置

### 🟢 低优先级（上线前打磨）

7. **executor-python 注册时端口硬编码**
   - 需要确认 config.py 里的端口配置是否从 .env 正确读取

8. **e2e 测试依赖真实服务**
   - `apps/admin-web/e2e/functional.spec.ts` 跑起来需要所有服务都在线
   - CI 里还没有这个保障

---

## 踩过的坑（避免重复踩）

- `python` 命令不存在，要用 `python3` 或 `.venv/bin/python`
- 系统级 pip install 被 PEP 668 阻止，必须用 venv
- executor-python 的 venv 在 `.venv/`，已经存在，不用重建
- Redis 认证：`redis-cli -a <password> ping`，不要忘记 `-a` 参数
- admin-api 的 npm run start:dev 需要先确认 dist 或 ts-node 配置

---

## 下一步工作计划

- [ ] 修复 BullModule Redis 密码配置（Bug #1）
- [ ] 验证任务队列实际能投递和消费
- [ ] 跑一次完整的任务执行流程（创建任务 → 触发 → executor 执行 → 结果回写）
- [ ] 修复健康检查，确认 /health 返回 healthy
- [ ] 写 Makefile 统一启动命令
- [ ] 跑 e2e 测试，记录通过情况
- [ ] 确认 executor-node 能正常启动和注册
