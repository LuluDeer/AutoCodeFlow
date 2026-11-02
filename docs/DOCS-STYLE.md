# 文档写作与维护规范

> **受众**：所有改仓库文档的人（含 AI agent）。
> **状态**：生效中 · **最后核对**：2026-11-02
> 适用范围：根 `README.md`、`docs/**/*.md`、`packages/*/README.md`、`examples/**/README.md`。
> 内部流程文档（`PLAN-CLAIMS.md`、`AGENT_HANDOFF.md`、`docs/archive/**`）只要求文首标注
> 「内部」或「归档」，其余规范按需遵守。

---

## 1. 分层：每一层只回答一类问题

| 层 | 回答什么 | 位置 |
|---|---|---|
| 入口 | 我该从哪篇开始 | 根 `README.md`、`docs/README.md` |
| 教程 | 按顺序做一遍能跑通吗 | `docs/tutorials/` |
| 指南 | 某个场景怎么配置 / 怎么运维 | `docs/quickstart.md`、`deployment.md`、`operations.md` |
| 参考 | 字段、端点、错误码、命令是什么 | `docs/api-reference.md`、`docs/atlas/05-interfaces/` |
| 架构 | 为什么这样设计、边界在哪 | `docs/atlas/`、`docs/adr/` |
| 内部 | 本轮谁在做什么、审计证据 | `PLAN-CLAIMS.md`、`AGENT_HANDOFF.md` |
| 归档 | 一次性的报告 / 复盘 / 验证 | `docs/archive/` |

**新文档必须能从 `docs/README.md` 链到**，否则 `check-docs` 会判孤儿。一次性报告不要放仓库根目录。

## 2. 文首三行

每篇面向使用者的文档，标题下先给三行，再进正文：

```markdown
# 标题

> **受众**：第一次部署的运维 / 要接 SDK 的开发者。
> **状态**：稳定 · **最后核对**：2026-11-02
> 一句话说明这篇解决什么问题、不覆盖什么。
```

- **状态**只用这四个词：`稳定` / `草稿` / `内部` / `已归档`。
- **最后核对**只在你**逐段重读过并确认仍成立**时写；只改错别字写「最后更新」。
- 没核对过的旧文不要伪造新日期；宁可保留旧日期并挂 `> ⚠️ 待核实`。
- 日期必须**到日**：`2026-11-02` 合格，`2026-09`（月粒度）、`2026` 不合格——
  `check-doc-style` 的新鲜度判据会判红，且不接受「文件里别处有日期」蒙混。
- `docs/atlas/**` 允许**行内**写法，不必三行：
  `> 所属: docs/atlas/01-apps · 最后核对: 2026-11-02 · 对应代码: apps/admin-api/src/modules/x`。
  该目录按**目录级**纳入判据（131 篇，新增页面不用回来改守卫），所以每篇都必须带这行。

## 3. 标题与结构

- 一篇文档**只有一个 H1**（代码块里的 `# 注释` 不算）。
- H2 用于大章节，H3 用于步骤；不要跳级。
- 超过 **500 行**考虑拆子文档；超过 **1200 行**必须在文首给目录。
- 同一篇里不要重复讲同一件事；需要重复时链接到单一事实源。

## 4. 版本与日期

- **不要**在普通文档里硬编码“当前版本是 vX.Y.Z”。版本事实源是 `version.txt` 与 GitHub Releases。
- 只有这三类文档可以钉版本号：升级指南、发布检查清单、兼容性矩阵。钉版本时必须写**核对日期**。
- 命令里的版本号、迁移数、env 键数必须能从仓库命令复算；不能复算的写成“约”或删掉。
- 相对时间（“上个月”“最近”）一律换成绝对日期。

## 5. 链接与路径

- 仓库内链接用**相对路径**：`[部署指南](deployment.md)`、`[SDK](../packages/autoflow-sdk/README.md)`。
- 同一仓库不要写 `https://github.com/<owner>/<repo>/blob/main/...` 的绝对链接（换分支就失效）。
- 代码路径、env 键、命令用反引号：`` `apps/admin-api/src/main.ts` ``、`` `JWT_SECRET` ``。
- 行号锚点（`file.ts:42`）只用于“当前基线”的取证；合并后允许漂移，必须同时给符号名。
- 外部链接给可读标题，不要裸贴 URL。

## 6. 图片与截图

### 6.1 目录与命名

```text
docs/assets/
├── banner-{zh,en}.png                 # 首屏横幅
├── architecture-{zh,en}.png           # 架构图
└── screenshots/
    ├── zh/<page>.png                  # 中台中文界面
    ├── en/<page>.png                  # 中台英文界面
    └── {zh,en}/executor-desktop/<page>.png
```

- 文件名用**页面语义**（`dashboard.png`、`execution-detail.png`），不要用日期或 `截图1.png`。
- 中英文必须成对；英文目录里的界面文字必须是英文，不能拿中文截图充数。

### 6.2 尺寸与体积

| 类型 | 建议尺寸 | 体积上限 |
|---|---|---|
| 中台页面 | 1760×1100（视口 1760×1100） | 350 KB |
| 桌面执行器主窗 | 1440×900 | 250 KB |
| 桌面执行器向导 | 660×780 | 120 KB |
| 架构图 / 横幅 | 1760 宽 | 500 KB |

- 优先 PNG；照片类可 WebP。超过上限先压缩，不要靠缩小显示宽度掩盖。
- 同一张图不要在多个目录放多份；用相对路径引用同一文件。

### 6.3 内容红线

- **不出现**真实令牌、Cookie、密码、内网 IP、客户名、工单号、真实业务数据。
- 截图前切到 demo 栈或测试数据；必须用真实环境时先脱敏。
- alt 文本写“这张图说明什么”，不要写“截图”。例：
  `![执行详情：日志、时间线与重试链](assets/screenshots/zh/execution-detail.png)`

### 6.4 什么时候必须重拍

- 页面布局改版（如桌面 V5 三页改版）→ 对应截图全部重拍。
- 顶部日期、版本号、菜单项变化 → 至少重拍首屏和涉及页面。
- 新增关键页面（任务模板、SOP、视频转 SOP、Agent 会话）→ 补图并在 README 挂链。
- 重拍后同步更新文首“最后核对”日期。

### 6.5 现有采集入口

```bash
# 中台：先起隔离 demo 栈（不要用生产栈截图）
./scripts/demo.sh --port 8090 --api-port 3115 --executor-port 8012 --python-executor-port 8011

# 桌面：仓库自带视觉审计脚本，使用假数据，不需要登录
cd apps/executor-desktop
node e2e/visual-audit.cjs --sizes=1440x900 --lang=zh --tag=docs-zh
node e2e/visual-audit.cjs --sizes=1440x900 --lang=en --tag=docs-en
# 产物在 apps/executor-desktop/e2e/.visual/，按 6.1 命名后拷入 docs/assets/screenshots/
```

## 7. 代码块与命令

- 代码围栏必须带语言：`bash` / `ts` / `js` / `json` / `yaml` / `text`。
  ASCII 架构图用 ```text，不要留空围栏。
- 命令要能直接复制执行；需要占位符时用 `<UPPER_SNAKE>` 并解释。
- 不要在命令里写真实域名 / 真实令牌；用 `$EXECUTOR_SECRET`、`<your-domain>`。
- 多步操作给“判据”：期望输出、退出码、健康检查结果。

## 8. 表格、列表与术语

- 表格必须有表头与分隔行；不要留空 `|` 行。
- 术语统一：

| 中文 | 英文 | 不要写成 |
|---|---|---|
| 任务 | task | job（除 MCP/队列语境） |
| 执行 / 执行记录 | execution | run（除 UI 文案） |
| 执行器 | executor | agent（Agent 是另一层） |
| 应用 | application | app（除路径/字段名） |
| 产物 | artifact | output |
| 试跑 | trial run | dry run（dry-run 是部署参数） |

- 首次出现的缩写给全称：`SOP（标准作业程序）`、`RBAC（基于角色的访问控制）`。

## 9. 长文、归档与拆分

- 一次性报告、事故复盘、审计记录 → `docs/archive/<audits|reports|reviews|incidents|plans|verifies>/YYYY-MM-DD-*.md`。
- 已完成的计划不要留在 `docs/` 根目录；移入 archive 并在原文首行标“已归档”。
- 拆分时保留原文件作为索引页，子文档用 `01-`、`02-` 前缀，并在索引页列出。

## 10. 提交前检查

```bash
npm run test:docs                 # 链接面 5 条 + 结构/新鲜度/围栏语言 3 条
node scripts/check-atlas-counts.mjs
node scripts/check-interface-maps.mjs
node scripts/check-infra-doc-counts.mjs
```

新增/修改图片时额外自查：

- [ ] 中英文成对，英文图里没有中文
- [ ] 没有令牌、密码、真实 IP、客户数据
- [ ] 体积在 6.2 的上限内
- [ ] alt 文本描述的是内容，不是“截图”
- [ ] README / docs hub 里的引用路径可解析

## 11. 一页纸清单（新建文档时照抄）

1. 这篇属于哪一层？入口 / 教程 / 指南 / 参考 / 架构 / 内部 / 归档。
2. 文首三行写了吗（受众 / 状态 / 最后核对 + 一句话）？日期到日了吗（`2026-11-02`，不是 `2026-09`）？
3. 只有一个 H1 吗？超过 500 行要不要拆？
4. 版本号是钉死的还是引用事实源？日期是绝对日期吗？
5. 链接是相对路径吗？代码路径有反引号吗？
6. 图片符合 6.1–6.4 吗？
7. 能从 `docs/README.md` 链到吗？
8. `npm run test:docs` 绿了吗？
