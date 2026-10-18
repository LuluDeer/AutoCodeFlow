# 参与贡献

感谢你愿意为 AutoCodeFlow 出一份力。本文说明**怎么提、怎么写、怎么过门禁**。

> 第一次参与？先读 [文档中心](docs/README.md) 的「按角色选路线」，
> 再按本文的流程走一遍。

---

## 一、开始之前

### 1. 先确认要不要开 Issue

| 情况 | 做法 |
|---|---|
| 明确的 Bug / 功能需求 | 先开 Issue（用模板），避免做完才发现方向不对 |
| 小修小补（错别字、注释、文档） | 可以直接提 PR |
| 安全漏洞 | **不要开 Issue**，见 [SECURITY.md](SECURITY.md) |
| 不确定 | 开 [Discussion](https://github.com/LuluDeer/AutoCodeFlow/discussions) 问 |

### 2. 环境准备

```bash
git clone https://github.com/LuluDeer/AutoCodeFlow.git
cd AutoCodeFlow
cp .env.example .env          # 按注释填必填项
./dev.sh                      # 起本地全栈
```

本地开发的完整说明（依赖版本、各服务启动方式、常见报错）见
[开发指南](docs/development.md)。

---

## 二、分支与提交

### 分支命名

从 `develop` 切出，前缀表达意图：

```
feat/<简短描述>       新功能
fix/<简短描述>        缺陷修复
chore/<简短描述>      构建 / 依赖 / 工具链
docs/<简短描述>       纯文档
refactor/<简短描述>   重构（无行为变化）
```

### 提交信息：中文 conventional commits

格式 `<type>(<scope>): <中文摘要>`，正文写**为什么**而不是**做了什么**
（做了什么看 diff 就知道）。

```
fix(executor): 回调令牌过期后不再整批丢弃日志

原来令牌过期会让 30 分钟内的日志全部丢失，因为...
```

- `type`：`feat` / `fix` / `chore` / `docs` / `refactor` / `test` / `perf` / `ci`
- `scope`：受影响的包或模块（`admin-api` / `executor-node` / `web` / `docs` …）
- **一个提交只做一件事**，方便 revert 与 `git log --follow`

---

## 三、许可证结构（分域）

AutoCodeFlow 采用**分组件许可**，完整说明见根 README「开源协议」一节：

| 许可域 | 覆盖范围 |
|---|---|
| **AGPL-3.0-only**（根 [`LICENSE`](LICENSE)） | `apps/` 平台核心全部组件、`packages/docs-site` |
| **MIT**（各包目录内 `LICENSE`） | `acf-cli`、`autocodeflow-node-sdk`、`autoflow-sdk`、`mcp-server`、`autocodeflow-http/-ai/-notify/-db`、协议契约 `executor-protocol` 与 `contract-fixtures` |

向某目录提交改动，即表示你同意将该改动按其所属许可域授权发布。

⚠️ **请勿跨许可域拷贝代码**：确需复用时，抽到对应许可域的公共包，
或先开 Issue 与维护者讨论归属。

---

## 四、DCO（Developer Certificate of Origin）

所有提交必须携带签署声明（`Signed-off-by`），表明你本人有权按上述许可证提交这些代码：

```bash
git commit -s            # 单提交签署
git rebase --exec 'git commit --amend --no-edit -s' <base>   # 历史补签
```

缺少签署的提交会在 PR 审核中被要求修正后才能合入。

---

## 五、代码约定

| 领域 | 约定 | 详见 |
|---|---|---|
| 后端（admin-api） | NestJS 模块化，DTO 走 class-validator，错误用 `AppError` + 错误码 | [开发指南](docs/development.md) |
| 前端（admin-web） | React 函数组件 + hooks，样式用 Ant Design token，i18n 走 `locales/` | [admin-web 拆解](docs/atlas/01-apps/admin-web/README.md) |
| 执行器 | 改 `executor-node/src` 必须**同 commit 重打 bundle**（ADR-005） | [执行器协议](docs/atlas/01-apps/executor-contract.md) |
| 数据库 | 新表/新列必须走迁移，**先登记时间戳**再建文件 | [迁移机制](docs/atlas/03-data/migrations.md) |
| 接口 | 改端点必须同步 `docs/api-reference.md` 与 OpenAPI 生成物 | [API 参考](docs/api-reference.md) |
| 环境变量 | 三处同批登记：`configuration.ts` + `.env.example` + 文档 | [env 变量表](docs/atlas/06-infra/env-vars.md) |

### 架构决策

改动涉及**认证、调度、数据模型、执行器协议、发布流程**时，先看
[ADR 目录](docs/adr/README.md)——那里记录了已拍板的取舍与理由。
若你的方案与既有 ADR 冲突，需要在 PR 里说明为什么，或先提新的 ADR。

---

## 六、测试与门禁

### 本地跑什么

```bash
npm run test:unit        # 全量单元测试（较慢）
npm run test:api         # 只跑后端
npm run test:web         # 只跑前端
npm run test:docs        # 文档守卫（死链 / 孤儿 / 根目录洁癖）
npm run typecheck        # 类型检查
```

**测试只增不减**——修 Bug 要补回归用例，加功能要补覆盖。基线数字见
[AGENT_HANDOFF.md](docs/AGENT_HANDOFF.md) 的状态快照。

### CI 会检查什么

PR 会触发 60+ 个 job，常见失败原因：

| 门禁 | 什么时候会红 |
|---|---|
| `admin-api-test` / `admin-web-build` | 单测失败或构建失败 |
| `api-types-drift` | 改了 DTO 但没重导出 OpenAPI / api-types |
| `check-migrations` | 迁移时间戳没登记或撞号；**DOC-GOV 文档守卫** |
| `desktop-bundle-drift` | 改了 `executor-node/src` 但没重打 bundle |
| `secret-scan` | 提交里含凭据 |
| `npm-audit` / `pip-audit` | 新增依赖漏洞，且未登记豁免 |

---

## 七、文档约定

文档不是可选项——**改代码时同步改文档**，否则下一个人会踩同一个坑。

| 规则 | 说明 |
|---|---|
| 入口唯一 | 新文档必须在 [`docs/README.md`](docs/README.md) 挂链 |
| 不放根目录 | 一次性报告 / 审计结论一律进 `docs/archive/` |
| 标注快照 | 引用归档文档时写明「历史快照」与日期 |
| 链接可解析 | 相对链接、无扩展名、目录 → README 三种形态都支持 |
| 自动检查 | `npm run test:docs`，CI 同样跑（`DOC-GOV`） |

---

## 八、PR 流程

1. **推分支**，向 `develop` 开 PR（不是 `main`）。
2. **填模板**——自测证据要给数字，不要写「已测试」。
3. **等 CI 绿**。红了先看是哪个 job，对照上表定位。
4. **响应评审**。有异议直接讨论，不要默默改。
5. **合入后**删掉远程分支。

`main` 分支受保护：只接受来自 `develop` 的 PR，要求评审通过、CI 绿、线性历史。
发版由维护者按 [发布流程](docs/atlas/08-workflows/release-process.md) 执行。

---

## 九、行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
遇到骚扰或不当行为，按该文档的举报渠道联系维护者。
