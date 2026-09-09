# AutoCodeFlow · 发版 Checklist

> 每次发版前，按顺序过一遍。AI agent 可直接执行各步骤命令。

---

## Phase 1 · 发版前准备

### 1.1 确认代码状态

```bash
# 确认在 main 分支且代码干净
git checkout main
git status            # 应显示 nothing to commit
git log --oneline -5  # 确认最新 commit 符合预期
```

### 1.2 跑全量检查

```bash
# 后端
cd apps/admin-api
npm run typecheck
npm run lint
npm test
cd ../..

# 前端
cd apps/admin-web
npx tsc --noEmit
pnpm lint
cd ../..
```

所有命令 **0 error** 才继续。

### 1.3 对比环境变量

```bash
# 检查 .env.example 是否有新增变量，同步到生产 .env
diff .env .env.example
```

有新增变量时，先在服务器上更新 `.env`，再部署。

### 1.4 备份数据库（生产环境必须）

```bash
docker compose exec postgres pg_dump -U autoflow autoflow > backup_$(date +%Y%m%d_%H%M).sql
# 确认备份文件大小合理（不为 0）
ls -lh backup_*.sql
```

---

## Phase 2 · 部署

### 2.1 拉取最新代码

```bash
git pull origin main
```

### 2.2 构建并重启服务

```bash
# 方式 A：用部署脚本（推荐）
./deploy.sh -e production -b

# 方式 B：手动
docker compose build --no-cache
docker compose up -d
```

ARM64 / Apple Silicon 部署前，确认 CI 的 `docker-multiarch-build` job 已对
`admin-api`、`executor-node`、`executor-python` 完成 `linux/amd64,linux/arm64`
构建校验。若使用发布镜像而非本地 build，先用
`docker buildx imagetools inspect <image>:<tag>` 确认 manifest 同时包含 amd64/arm64，
再在 ARM64 机器执行 `docker compose pull && docker compose up -d`。

### 2.3 执行数据库迁移

```bash
docker compose exec admin-api npm run migration:run
```

> 如果迁移失败，立刻回滚：
> ```bash
> docker compose exec admin-api npm run migration:revert
> # 还原代码
> git checkout HEAD~1
> docker compose up -d
> ```

---

## Phase 3 · 验证

### 3.1 检查容器状态

```bash
docker compose ps
# 所有服务应为 healthy
```

### 3.2 检查 API 健康

```bash
curl http://localhost:3105/health
# 期望响应：{"status":"healthy"} 或类似
```

### 3.3 检查服务日志（最近 50 行）

```bash
docker compose logs admin-api --tail=50
docker compose logs admin-web --tail=20
```

无 ERROR 级别日志才算通过。

### 3.4 冒烟测试

- 访问 http://localhost 确认前端正常加载
- 登录管理后台，确认核心页面（任务列表、执行器列表）可访问
- 手动触发一个测试任务，确认执行记录产生

---

## Phase 4 · 发版后

### 4.1 打 Git Tag

```bash
git tag -a v1.x.x -m "release: v1.x.x"
git push origin v1.x.x
```

当前 tag 发布链路发布 npm/PyPI 包；Docker 镜像发布启用前，multi-arch 验收以 CI buildx
构建通过和部署机本地/私有仓库镜像冒烟为准。若后续接入 GHCR/DockerHub，发布前必须保留
`docker buildx imagetools inspect` manifest 核对步骤。

### 4.2 更新 CHANGELOG（可选）

在 `CHANGELOG.md`（如有）记录本次变更，格式：

```markdown
## v1.x.x (YYYY-MM-DD)

### 新增
- feat(task): 触发弹窗支持运行时参数覆盖

### 修复
- fix(executor): 心跳超时误下线
```

---

## 回滚方案

### 快速回滚（代码）

```bash
# 切回上一个 tag
git checkout v1.x.x-1
docker compose build
docker compose up -d
```

### 数据库回滚

```bash
# 回滚最后一次迁移
docker compose exec admin-api npm run migration:revert

# 从备份恢复（极端情况）
docker compose exec -T postgres psql -U autoflow autoflow < backup_20240101_1200.sql
```

---

## 常见部署问题速查

| 症状 | 排查命令 |
|------|----------|
| 前端白屏 | `docker compose logs admin-web --tail=30` |
| API 502/503 | `docker compose logs admin-api --tail=50` |
| 迁移报错 | `docker compose exec admin-api npm run migration:run 2>&1` |
| 执行器断线 | `docker compose logs executor-node --tail=30` |
| 端口被占 | `ss -tlnp \| grep -E '80\|3105\|8001\|8002'` |
| 内存不足 | `docker stats --no-stream` |
