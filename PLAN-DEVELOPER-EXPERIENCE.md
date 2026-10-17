# 开发者体验优化计划

**优先级**: 中  
**预计工作量**: 4-6 人天  
**目标**: 提升开发效率、降低上手难度、改善本地开发体验

---

## 1. 本地开发环境改进

### 背景
当前本地启动需要手动配置多个服务，容易出错。

### 优化方案

#### 1.1 一键启动脚本
```bash
#!/bin/bash
# scripts/dev-start.sh

echo "🚀 AutoCodeFlow 开发环境启动中..."

# 检查依赖
check_command() {
  if ! command -v $1 &> /dev/null; then
    echo "❌ $1 未安装，请先安装"
    exit 1
  fi
}

check_command docker
check_command node
check_command pnpm

# 启动基础设施
echo "📦 启动 PostgreSQL, Redis, MinIO..."
docker-compose up -d postgres redis minio

# 等待服务就绪
echo "⏳ 等待数据库就绪..."
until docker exec autocodeflow-postgres pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done

# 初始化数据库
echo "🗄️ 运行数据库迁移..."
cd apps/admin-api && npm run migration:run && cd ../..

# 启动后端
echo "🔧 启动 admin-api..."
(cd apps/admin-api && npm run start:dev) &
API_PID=$!

# 等待 API 启动
until curl -s http://localhost:3105/health > /dev/null; do
  sleep 1
done

# 启动前端
echo "🎨 启动 admin-web..."
(cd apps/admin-web && npm run dev) &
WEB_PID=$!

# 启动执行器
echo "⚙️ 启动 executor-node..."
(cd apps/executor-node && npm run start:dev) &
EXEC_PID=$!

echo "✅ 开发环境启动完成！"
echo ""
echo "📊 服务访问地址："
echo "   - 前端: http://localhost:5173"
echo "   - 后端: http://localhost:3105"
echo "   - API 文档: http://localhost:3105/api-docs"
echo ""
echo "按 Ctrl+C 停止所有服务"

trap "kill $API_PID $WEB_PID $EXEC_PID; docker-compose down" EXIT
wait
```

#### 1.2 开发环境健康检查
```bash
# scripts/dev-check.sh
#!/bin/bash

echo "🔍 检查开发环境..."

checks=(
  "docker:Docker 运行中"
  "postgres:PostgreSQL"
  "redis:Redis"
  "http://localhost:3105/health:admin-api"
  "http://localhost:5173:admin-web"
)

for check in "${checks[@]}"; do
  IFS=':' read -r target name <<< "$check"
  
  if [[ $target == http* ]]; then
    if curl -sf $target > /dev/null; then
      echo "✅ $name"
    else
      echo "❌ $name 未运行"
    fi
  else
    if command -v $target &> /dev/null || docker ps | grep -q $target; then
      echo "✅ $name"
    else
      echo "❌ $name 未安装/运行"
    fi
  fi
done
```

#### 1.3 .env 模板生成
```bash
# scripts/setup-env.sh
#!/bin/bash

generate_secret() {
  openssl rand -base64 32
}

cat > apps/admin-api/.env << EOF
# 数据库配置
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=autocodeflow

# Redis 配置
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT 密钥（自动生成）
JWT_SECRET=$(generate_secret)
JWT_REFRESH_SECRET=$(generate_secret)

# 管理员账号
ADMIN_USERNAME=admin
ADMIN_PASSWORD=Admin123!

# 其他配置
NODE_ENV=development
LOG_LEVEL=debug
EOF

echo "✅ .env 文件已生成"
```

---

## 2. 文档改进

### 背景
当前文档分散，新人上手困难。

### 优化方案

#### 2.1 交互式文档网站
```bash
# docs-site/ 使用 VitePress
pnpm add -D vitepress

# docs-site/.vitepress/config.ts
export default {
  title: 'AutoCodeFlow',
  description: '智能任务调度平台',
  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/' },
      { text: 'API', link: '/api/' },
      { text: '架构', link: '/architecture/' },
    ],
    sidebar: {
      '/guide/': [
        { text: '快速开始', link: '/guide/getting-started' },
        { text: '核心概念', link: '/guide/concepts' },
        { text: '任务配置', link: '/guide/tasks' },
        { text: '执行器部署', link: '/guide/executors' },
      ],
      '/api/': [
        { text: 'REST API', link: '/api/rest' },
        { text: 'SDK', link: '/api/sdk' },
        { text: 'CLI', link: '/api/cli' },
      ],
    },
  },
};
```

#### 2.2 代码示例库
```typescript
// docs/examples/basic-task.ts
import { AutoFlowClient } from 'autoflow-sdk';

const client = new AutoFlowClient({
  apiUrl: 'http://localhost:3105',
  apiKey: 'your-api-key',
});

// 创建任务
const task = await client.tasks.create({
  name: 'daily-report',
  runtime: 'python',
  triggerType: 'cron',
  schedule: '0 9 * * *', // 每天 9 点
  glueSource: `
import autoflow

def handler(ctx):
    ctx.log("生成日报...")
    # 你的业务逻辑
    return {"status": "success"}
`,
});

// 手动触发
await client.tasks.trigger(task.id);

// 查询执行结果
const executions = await client.executions.list({ taskId: task.id });
console.log(executions);
```

#### 2.3 ADR（架构决策记录）模板
```markdown
<!-- docs/adrs/ADR-001-example.md -->
# ADR-001: 使用 TypeORM 作为 ORM

## 状态
已接受

## 背景
需要选择一个 Node.js ORM 框架。

## 决策
选择 TypeORM，原因：
1. TypeScript 原生支持
2. 装饰器语法简洁
3. 迁移工具完善
4. 社区活跃

## 后果
### 优点
- 类型安全
- 自动生成迁移文件

### 缺点
- 学习曲线较陡
- 复杂查询需要 QueryBuilder

## 替代方案
- Prisma: 类型安全更好，但生态较新
- Sequelize: 成熟但缺少 TS 支持
```

---

## 3. 代码质量工具链

### 背景
缺少统一的代码规范和自动检查。

### 优化方案

#### 3.1 Husky + lint-staged
```json
// package.json
{
  "scripts": {
    "prepare": "husky install"
  },
  "lint-staged": {
    "*.ts": [
      "eslint --fix",
      "prettier --write"
    ],
    "*.{json,md,yml}": [
      "prettier --write"
    ]
  }
}
```

```bash
# .husky/pre-commit
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

npx lint-staged
npm run typecheck
```

#### 3.2 Commitlint（提交消息规范）
```bash
# .husky/commit-msg
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

npx --no-install commitlint --edit "$1"
```

```js
// commitlint.config.js
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',     // 新功能
        'fix',      // 修复
        'docs',     // 文档
        'style',    // 格式
        'refactor', // 重构
        'perf',     // 性能优化
        'test',     // 测试
        'chore',    // 构建/工具
      ],
    ],
    'scope-enum': [
      2,
      'always',
      [
        'admin-api',
        'admin-web',
        'executor-node',
        'executor-python',
        'cli',
        'sdk',
      ],
    ],
  },
};
```

#### 3.3 自动生成 CHANGELOG
```bash
# package.json
{
  "scripts": {
    "release": "standard-version"
  }
}

# 使用
npm run release -- --release-as minor
# 自动生成 CHANGELOG.md，打 tag
```

---

## 4. 测试体验改进

### 背景
测试运行慢、调试困难。

### 优化方案

#### 4.1 测试分组（快速 vs 完整）
```json
// package.json
{
  "scripts": {
    "test": "jest",
    "test:unit": "jest --testPathPattern='\.spec\.ts$'",
    "test:integration": "jest --testPathPattern='\.integration\.spec\.ts$'",
    "test:e2e": "jest --config=test/jest-e2e.json",
    "test:quick": "jest --onlyChanged --bail",
    "test:watch": "jest --watch",
    "test:debug": "node --inspect-brk node_modules/.bin/jest --runInBand"
  }
}
```

#### 4.2 测试数据工厂
```typescript
// test/factories/task.factory.ts
import { faker } from '@faker-js/faker';

export const TaskFactory = {
  build: (overrides?: Partial<Task>): Task => ({
    id: faker.number.int(),
    name: faker.lorem.words(3),
    runtime: 'python',
    triggerType: 'cron',
    schedule: '0 * * * *',
    status: TaskStatus.ACTIVE,
    glueSource: 'def handler(ctx): pass',
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  }),
  
  buildMany: (count: number, overrides?: Partial<Task>): Task[] => {
    return Array.from({ length: count }, () => TaskFactory.build(overrides));
  },
};

// 使用
const task = TaskFactory.build({ name: 'test-task' });
const tasks = TaskFactory.buildMany(10);
```

#### 4.3 快照测试（UI 组件）
```typescript
// TaskCard.test.tsx
import { render } from '@testing-library/react';
import { TaskCard } from './TaskCard';

test('renders correctly', () => {
  const task = TaskFactory.build();
  const { container } = render(<TaskCard task={task} />);
  expect(container).toMatchSnapshot();
});
```

---

## 5. 调试工具

### 背景
生产问题难以在本地复现。

### 优化方案

#### 5.1 时间旅行调试（Redux DevTools）
```typescript
// admin-web/src/store/index.ts
import { configureStore } from '@reduxjs/toolkit';
import { devToolsEnhancer } from '@redux-devtools/extension';

export const store = configureStore({
  reducer: rootReducer,
  devTools: process.env.NODE_ENV !== 'production',
});

// 使用 Redux DevTools 查看所有状态变化
```

#### 5.2 React Query DevTools
```typescript
// App.tsx
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

<QueryClientProvider client={queryClient}>
  <App />
  <ReactQueryDevtools initialIsOpen={false} />
</QueryClientProvider>
```

#### 5.3 VSCode 调试配置
```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug admin-api",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "start:debug"],
      "cwd": "${workspaceFolder}/apps/admin-api",
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"],
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/apps/admin-api/dist/**/*.js"]
    },
    {
      "name": "Debug Jest Tests",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/node_modules/.bin/jest",
      "args": ["--runInBand", "--no-cache", "${file}"],
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen"
    }
  ]
}
```

---

## 6. 开发工作流优化

### 背景
PR 审查耗时长，合并冲突频繁。

### 优化方案

#### 6.1 PR 模板
```markdown
<!-- .github/pull_request_template.md -->
## 变更类型
- [ ] 新功能
- [ ] Bug 修复
- [ ] 重构
- [ ] 文档更新
- [ ] 性能优化

## 变更描述


## 测试
- [ ] 单元测试已更新
- [ ] 集成测试已通过
- [ ] 手动测试已完成

## 截图（如适用）


## 检查清单
- [ ] 代码符合项目规范
- [ ] 已更新相关文档
- [ ] CHANGELOG 已更新
- [ ] 无编译警告
- [ ] 无 lint 错误

## 关联 Issue
Closes #
```

#### 6.2 自动合并 Dependabot PR
```yaml
# .github/workflows/auto-merge-dependabot.yml
name: Auto merge Dependabot PRs

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  auto-merge:
    runs-on: ubuntu-latest
    if: github.actor == 'dependabot[bot]'
    steps:
      - name: Auto merge
        uses: ahmadnassri/action-dependabot-auto-merge@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          target: minor
```

#### 6.3 代码所有者文件
```
# .github/CODEOWNERS
# 全局
*       @maintainers

# 前端
/apps/admin-web/           @frontend-team
/apps/executor-desktop/    @frontend-team

# 后端
/apps/admin-api/           @backend-team
/apps/executor-node/       @backend-team
/apps/executor-python/     @backend-team

# 文档
/docs/                     @tech-writers
*.md                       @tech-writers

# CI/CD
/.github/                  @devops-team
/scripts/deploy.sh         @devops-team
```

---

## 7. 性能分析工具

### 背景
前端性能问题难以定位。

### 优化方案

#### 7.1 Bundle 分析
```json
// admin-web/package.json
{
  "scripts": {
    "analyze": "vite-bundle-visualizer"
  }
}
```

```bash
npm run analyze
# 生成 stats.html，可视化查看哪些依赖占用体积大
```

#### 7.2 Lighthouse CI
```yaml
# .github/workflows/lighthouse.yml
name: Lighthouse CI

on: [push]

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run build
      - run: npm install -g @lhci/cli
      - run: lhci autorun --upload.target=temporary-public-storage
```

---

## 实施路线图

### 阶段 1（本月）
- [ ] 1.1-1.3 本地开发环境改进
- [ ] 3.1-3.2 代码质量工具链
- [ ] 4.1 测试分组

### 阶段 2（下月）
- [ ] 2.1 交互式文档网站
- [ ] 2.2 代码示例库
- [ ] 5.1-5.3 调试工具

### 阶段 3（下季度）
- [ ] 2.3 ADR 模板
- [ ] 3.3 自动 CHANGELOG
- [ ] 4.2-4.3 测试工厂和快照
- [ ] 6.1-6.3 开发工作流优化
- [ ] 7.1-7.2 性能分析工具

## 依赖项

- VitePress: 文档网站
- Husky + lint-staged: Git hooks
- @faker-js/faker: 测试数据生成
- @redux-devtools/extension: Redux 调试
- @lhci/cli: Lighthouse CI

## 验收标准

- [ ] 新人可在 30 分钟内启动本地环境
- [ ] 文档覆盖所有核心功能
- [ ] 所有 PR 通过自动检查
- [ ] 测试覆盖率 > 80%
- [ ] Lighthouse 性能分数 > 90
