# AutoCodeFlow · 功能开发标准流程

> 给 AI agent 用的 step-by-step checklist。开发任何新功能前，按顺序执行。

---

## Step 1 · 理解需求

- 明确功能涉及哪个层：后端（admin-api）/ 前端（admin-web）/ 执行器 / 多层
- 确认影响的核心实体（Task / Execution / Executor / Application）
- 如果涉及数据库字段变更，记下来，Step 4 处理

---

## Step 2 · 读相关代码

按影响范围，读以下文件（不要跳过）：

**后端变更时读：**
- `apps/admin-api/src/modules/<相关模块>/` 下的 entity、service、controller、dto
- 如果涉及跨模块调用，读被调用模块的 service

**前端变更时读：**
- `apps/admin-web/src/api/<相关资源>.ts`（接口定义）
- `apps/admin-web/src/pages/<相关页面>.tsx`（现有页面逻辑）
- 如果有复用组件需求，读 `src/components/` 下已有组件

---

## Step 3 · 后端实现（如需）

### 3a. 新增/修改 DTO
```bash
# 位置：apps/admin-api/src/modules/<feature>/dto/
# 用 class-validator 装饰器做入参校验
# 示例参考：apps/admin-api/src/modules/task/dto/create-task.dto.ts
```

### 3b. 修改 Entity（如需加字段）
```bash
# 修改 entity 文件后，立刻生成迁移
cd apps/admin-api
npm run migration:generate -- src/migrations/AddXxxToYyy
npm run migration:run
```

### 3c. 实现 Service 逻辑
- 业务逻辑全部在 service 层，controller 只做参数解包和调 service
- 数据库操作用 TypeORM repository，不写裸 SQL（复杂查询用 QueryBuilder）

### 3d. 修改 Controller
- 加 `@ApiOperation({ summary: '...' })` 注解
- 参数用 `@Body()` / `@Param()` / `@Query()` 装饰器
- 返回统一结构，错误抛 `BadRequestException` / `NotFoundException` 等

### 3e. 注册模块（新模块才需要）
```bash
# 在 apps/admin-api/src/app.module.ts 的 imports 数组加入新 Module
```

### 3f. 验证后端
```bash
cd apps/admin-api
npm run typecheck       # 0 error
npm run lint            # 0 error
npm test                # 已有测试全部通过
# 启动服务手动测一下接口
npm run start:dev
# 访问 http://localhost:3105/api/docs 确认新接口已出现
```

---

## Step 4 · 前端实现（如需）

### 4a. 更新 API 层
```bash
# 位置：apps/admin-web/src/api/<resource>.ts
# 新增接口函数，复用同文件已有的 client 实例
# 如需新的类型定义，在同文件 export interface
```

### 4b. 实现页面/组件
- 新页面放 `src/pages/XxxPage.tsx`
- 复用组件放 `src/components/XxxComponent.tsx`
- 数据请求用 `useRequest`，加载态用 `loading` prop 传给按钮/表格
- 错误统一 `message.error(getErrMsg(err, '默认描述'))`

### 4c. 注册路由（新页面才需要）
```bash
# 在 apps/admin-web/src/router.tsx 加 <Route> 配置
# 如果需要菜单入口，在 apps/admin-web/src/layouts/MainLayout.tsx 加菜单项
```

### 4d. 验证前端
```bash
cd apps/admin-web
npx tsc --noEmit   # 0 error
pnpm lint          # 0 error
# 启动开发服务器手动验证功能
pnpm dev
```

---

## Step 5 · 自测 checklist

- [ ] 正常路径：功能按预期工作
- [ ] 边界情况：空数据、空列表、0值
- [ ] 错误路径：接口报错时前端有友好提示
- [ ] 类型检查：后端 `typecheck`、前端 `tsc --noEmit` 均 0 error
- [ ] Lint：`npm run lint` / `pnpm lint` 无报错
- [ ] 有无影响已有功能（回归）

---

## Step 6 · 提交

```bash
# 在功能分支上提交
git checkout -b feat/your-feature-name
git add <具体文件，不要 git add .>
git commit -m "feat(<scope>): 一句话描述做了什么"
```

**commit message 格式**：`feat(task): 触发弹窗支持运行时参数覆盖`

---

## 快速参考：各层对应文件

| 需求 | 找哪里 |
|------|--------|
| 新增后端接口 | `apps/admin-api/src/modules/<feature>/` |
| 新增前端页面 | `apps/admin-web/src/pages/` + `router.tsx` |
| 新增前端 API 调用 | `apps/admin-web/src/api/<resource>.ts` |
| 新增复用组件 | `apps/admin-web/src/components/` |
| 数据库字段变更 | Entity 文件 → `migration:generate` → `migration:run` |
| 执行器相关 | `apps/executor-node/` 或 `apps/executor-python/` |
| 跨服务通信 | 执行器用 `ADMIN_API_URL` 环境变量访问 admin-api |
