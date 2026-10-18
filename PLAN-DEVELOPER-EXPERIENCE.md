# 开发者体验优化计划

**优先级**: 中  
**预计工作量**: 4-6 人天  
**目标**: 提升开发效率、降低上手难度、改善本地开发体验

> ## ⚠️ 实施前必读（2026-10-17 核验结论）
>
> **18 个条目里 11 项早已实现**，另有 4 项按计划实施会与既有机制冲突。
>
> | 条目 | 真实状态 | 说明 |
> |---|---|---|
> | 1.1 一键启动 | ✅ **已实现** | `Makefile:20-58`（dev / infra-up）+ `dev.sh` + `scripts/start-isolated.sh` |
> | 1.2 环境健康检查 | ✅ **已实现** | `Makefile doctor` → `deploy.sh doctor --json` + `scripts/verify-config.cjs` |
> | 1.3 .env 模板生成 | ✅ **已实现** | `deploy.sh:421`（openssl rand）、`:457-462`（从 `.env.example` 生成） |
> | 2.1 文档网站 | ✅ **已实现** | `packages/docs-site`（VitePress 1.6.4）+ `docs-site-deploy.yml` |
> | 2.2 示例库 | ✅ **已实现** | `examples/` 5 个目录 + `docs-site/examples.md` |
> | 2.3 ADR 模板 | ✅ **已实现** | `docs/adr/adr-template.md` + `adr-001..023` |
> | 3.1 Husky + lint-staged | ⛔ **勿实施** | 已有 `.pre-commit-config.yaml` + gitleaks 两套钩子；且本仓**没有根级 workspace 安装**，`prepare: husky install` 会破坏按 app 独立安装的模型（ARCH-20） |
> | 3.2 Commitlint | ⚠️ 部分 | 无 commitlint 配置，但 `release-please` 已按 conventional 解析。**不要加 `scope-enum`**——会拒绝合法 scope |
> | 3.3 CHANGELOG | ✅ **已实现** | `CHANGELOG.md` + `release-please-config.json` |
> | 4.1 测试分组 | ⚠️ 部分 | `test:unit` 聚合 14 套件 + CI `--shard 1/4`；无 `test:quick` / `--onlyChanged` |
> | 4.2 测试数据工厂 | ⬜ 缺失 | 无 faker / factories |
> | 4.3 快照测试 | ⛔ 勿实施 | 600+ 行为断言 + design-audit 分片已覆盖；快照只会带来 churn |
> | 5.1 Redux DevTools | — **不适用** | 本仓用 zustand，没有 Redux |
> | 5.2 React Query DevTools | ⬜ 缺失 | devDep，可用 |
> | 5.3 VSCode 调试 | ⬜ 缺失 | 无 `.vscode/` |
> | 6.1 PR 模板 | ✅ **已实现** | `.github/PULL_REQUEST_TEMPLATE.md`（含 API 变更清单） |
> | 6.2 Dependabot 自动合并 | ⚠️ 部分 | `dependabot.yml` 只覆盖 actions（分组），无 auto-merge 工作流 |
> | 6.3 CODEOWNERS | ⬜ 缺失 | 零依赖、零风险 |
> | 7.1 Bundle 分析 | ⬜ 缺失 | 只有 `manualChunks`，无可视化 |
> | 7.2 Lighthouse CI | ⬜ 缺失 | 无 `@lhci/cli` |
>
> ### ⛔ 不要实施
> - **3.1 Husky**——双钩子系统 + 破坏按 app 独立安装模型
> - **3.2 commitlint `scope-enum`**——会拒绝合法 scope；release-please 已守门
> - **4.3 快照测试**——只带来 churn
> - **5.1 Redux DevTools**——仓库用 zustand
> - **1.1-1.3 的脚本重写**——`Makefile doctor` / `deploy.sh doctor --json` /
>   `verify-config.cjs` / `check-env-drift.mjs` 已覆盖；且计划里的
>   `docker-compose`（v1 语法）调用会**回退** `dev.sh:15-21` 已有的 v2 探测
>
> ### ✅ 真正值得做的三项
> 1. **6.3 CODEOWNERS**——零依赖、零风险
> 2. **5.2 React Query DevTools**——devDep，注意必须加进
>    `apps/admin-web/package-lock.json`（**不是根**，`check-no-hoisting.mjs` 禁止提升）
> 3. **7.1 Bundle 分析**——`rollup-plugin-visualizer` + `analyze` 脚本，同上注意 lockfile
>
> ### ⚠️ 新依赖的硬约束
> 任何新 npm 依赖必须落到**使用它的那个 app 自己的 `package-lock.json`**，
> 绝不能加到根——`check-no-hoisting.mjs`（ARCH-20）会直接判红。

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

## 实施路线图（2026-10-17 核验后重排）

### ✅ 已完成（无需动工）
- [x] **1.1-1.3 本地开发环境**——`Makefile dev/infra-up/doctor` + `dev.sh` +
      `deploy.sh doctor --json` + `verify-config.cjs` + `.env` 生成
- [x] **2.1 交互式文档网站**——VitePress + `docs-site-deploy.yml`
- [x] **2.2 代码示例库**——`examples/` + docs-site 页面
- [x] **2.3 ADR 模板**——`docs/adr/`（模板 + 23 篇）
- [x] **3.3 自动 CHANGELOG**——`release-please`
- [x] **6.1 PR 模板**——含 API 变更清单

### ⛔ 不要实施
- **3.1 Husky + lint-staged**——已有 `.pre-commit-config.yaml` + gitleaks；
  且无根级 workspace 安装，`prepare: husky install` 会破坏按 app 独立安装（ARCH-20）
- **3.2 commitlint `scope-enum`**——会拒绝合法 scope；release-please 已守门
- **4.3 快照测试**——600+ 行为断言已覆盖，快照只带来 churn
- **5.1 Redux DevTools**——本仓用 zustand
- **1.1-1.3 脚本重写**——计划里的 `docker-compose`（v1 语法）会回退
  `dev.sh:15-21` 已有的 v2 探测

### ✅ 已实施（2026-10-17 第二轮）
1. ~~6.3 CODEOWNERS~~ ✅ **已实施**——`.github/CODEOWNERS`，按域分组（控制面 /
   执行器 / SDK / registry / CI 门禁 / 基础设施 / 迁移 / 文档）。
   ⚠️ owner 必须写**真实存在**的账号——写错 GitHub **静默失效**、不报错，
   故没有留空而是显式写 `@LuluDeer`（并在文件头注明团队扩张后应按域拆分）。
2. ~~5.3 VSCode 调试配置~~ ✅ **已实施**——但**不是**直接入库 `.vscode/launch.json`：
   `.gitignore:31` 刻意忽略 `.vscode/`（与 `.idea/` 并列，属「编辑器个人配置不入库」
   的既有策略）。故入库 `docs/vscode-launch.template.json` +
   `scripts/gen-vscode-launch.mjs`（生成到本地）。生成器带**漂移校验**：
   模板里每个 `npm run <script>` 必须在对应 app 的 package.json 里真实存在、
   `program` 必须与 package.json `main` 一致——脚本改名而模板没改时调试会
   **静默失效**（启动即退出 / 断点不停），比直接报错难查。已接 CI
   （`npm run check:vscode-launch`）。实测反证：把 `dev` 改成不存在的 script，
   校验器立即报错并列出真实可用脚本。

### ⬜ 仍然待办（按价值排序）
1. **5.2 React Query DevTools**——devDep；**必须加进 `apps/admin-web/package-lock.json`**
2. **7.1 Bundle 分析**——`rollup-plugin-visualizer` + `analyze` 脚本，同上
3. ~~**4.1 `test:quick`**（`--onlyChanged`）~~ ✅ **已完成（2026-10-17 第三轮）**：
   根 `package.json` 新增 `test:quick` + 6 个分片（admin-api / executor-node /
   admin-web / acf-cli / mcp-server / autocodeflow-node-sdk）。两个**踩过的坑**已内建：
   ① jest `--onlyChanged` 与 vitest `--changed` 在"没有受影响的测试"时**默认 exit 1**
   → 必须带 `--passWithNoTests`（否则"本次改动确实没碰到测试"会被误报成红，
   实测 executor-node 与 node-sdk 正是这个分支）；② Python 侧（pytest 无等价 changed
   模式）与 desktop（其 test 脚本串 40+ 个本就秒级的 selftest）**刻意不纳入**，已在
   脚本注释里写明口径。已端到端跑通（exit 0）。
4. ~~**6.2 Dependabot auto-merge**~~ ⚠️ **部分完成（2026-10-17 第三轮）**：
   `dependabot.yml` 从"只有 github-actions"扩展到 **8 个 npm 安装单元**（逐目录，
   因为本仓刻意不做 workspace 提升；weekly + minor/patch 归组 + 单目录上限 3）。
   **auto-merge 刻意没配**：`gh pr merge --auto` 在**分支保护未要求任何 status check**
   时会立即合并，而本仓正确性几乎全压在 CI 上——把"是否已过 CI"的判定权交给仓库设置
   （而非工作流自己读 CI 结论）是不可接受的隐式依赖。日后若要开，正确形态是
   `workflow_run`（CI completed + conclusion == success + head 前缀 `dependabot/`）
   再 `--squash`，理由与配方写在 `dependabot.yml` 内注释里。
5. **4.2 测试数据工厂**——需 `@faker-js/faker`，注意落进各 app 自己的 lockfile
6. **7.2 Lighthouse CI**——需 `@lhci/cli` + 新 CI job

## 依赖项（核验后）

- VitePress: **已引入**
- Husky + lint-staged: **不要引入**（双钩子系统 + 破坏独立安装模型）
- `@faker-js/faker`: 待引入（测试工厂）
- `@redux-devtools/extension`: **不需要**（本仓用 zustand）
- `@lhci/cli`: 待引入（Lighthouse CI）
- `@tanstack/react-query-devtools`: 待引入（devDep）
- `rollup-plugin-visualizer`: 待引入（bundle 分析）

> **新依赖硬约束**：必须落到使用它的 app 自己的 `package-lock.json`，
> 绝不能加到根——`check-no-hoisting.mjs` 会判红。

## 验收标准

- [ ] 新人可在 30 分钟内启动本地环境
- [ ] 文档覆盖所有核心功能
- [ ] 所有 PR 通过自动检查
- [ ] 测试覆盖率 > 80%
- [ ] Lighthouse 性能分数 > 90
