# i18n 硬编码中文守卫

## 这是什么

`apps/admin-web/scripts/i18n-scan.mjs` 用 TypeScript 官方 parser 扫 `src/` 下的 `JsxText` 与
字符串字面量，找出**会渲染到界面上的硬编码中文**。这类串在英文界面下不会随
语言切换，造成中英混排。

```bash
node scripts/i18n-scan.mjs            # 盘点：列出所有疑似硬编码中文串
node scripts/i18n-scan.mjs --check    # 守卫：只报「不在基线里」的新增项（CI 用）
node scripts/i18n-scan.mjs --selftest # 自检：夹具树 + 真子进程，断言判据面本身（9 条用例）
```

退出码：`0` 通过 / 盘点完成；`1` 守卫失败（新增硬编码、基线陈旧）或自检失败；`2` 用法错误。
`--selftest` 与 `--check` / `--json` / `--file` **互斥**（同时给 ⇒ exit 2）——自检内部要拉子进程
跑 `--check`，混用时"这次到底跑了哪个"无法从命令行判定，CI 里极易退化成"以为跑了自检"。

## 为什么要用 AST 而不是 grep

本仓库中文注释占比极高。以 `pages/TaskFormPage.tsx` 为例：

| 口径 | 行数 |
|---|---|
| 含中文的行（grep） | 350 |
| 其中带引号、看起来像串的行 | 72 |
| **真实的硬编码界面串** | **0**（72 行全是 `//` 注释里的中文引号，如 `"执行器去哪拿代码"`） |

grep 口径把注释算进来，会把 0 处说成 350 处，直接误导迁移排期——本项目确实
发生过一次「清单列了 5 个文件 ~950 处，实际这 5 个文件全部已迁移完毕」。
所以守卫走 AST：注释由 parser 天然排除，`{/* */}` JSX 注释也不会被误判。

（另：本脚本曾有一版手写字符串状态机，被文件里一个反引号带偏状态后**整个文件
被静默跳过**，得出「共 14 文件、TaskFormPage 无命中」的假绿。改用 AST 后该
类问题不复存在——这也是不自己写 lexer 的原因。）

## 采集面与显式排除

采集面 = `apps/admin-web/src/**` 下所有 `.ts` / `.tsx`。排除项两档，都**显式**写死，不靠命名启发式：

| 排除 | 内容 | 理由 |
|---|---|---|
| 目录级（既有） | `__tests__/`、`locales/`、`node_modules/` | tests 会 stub 词条、`locales` 是键集本体（`t('key')` 的来源），都不是界面代码 |
| 文件级（`SKIP_FILES`） | `src/test-setup.ts`、`src/test-setup-scheduler-guard.ts` | vitest 的 `setupFiles`（见 `vite.config.ts` 的 `test.setupFiles`），**只在测试期运行** |

文件级为什么该排除：这两个文件里的中文是**抛给开发者/CI 日志的诊断信息**（例如浮空 rejection
收割器的「请在该调用点消费 rejection（例：try/catch 或 .catch(() => {})），不要加 retry 或放宽
断言。」），在浏览器里**永不渲染**。本守卫的判据是「**会显示给中文用户以外观感**的硬编码中文
串」——诊断信息不在这个集合里。把它们登记进 `i18n-baseline.json` 的 `accepted` 是「登记代替
修复」的形态：判据面会随每次新增诊断串一起膨胀，「已接受 N 处」最终读不出含义。所以修的是
**采集面**，不是基线。

**边界（别写宽，写宽了守卫就瞎了）**：

- 只排除**确切文件名**，不是 `*test*` / `*.test.ts` / `*.spec.ts` 通配。`src/**` 下若真出现
  界面代码写在 `*.test.ts(x)` 里（本不该有），它**仍会被扫到并报红**（自检用例⑤钉住）。
- 不按命名猜：新增测试基础设施文件必须在该清单里**加一行**，否则会立刻进入采集面（多半马上
  红）——诊断串 vs 界面串由人显式判定，不由文件名推断。
- 目录级排除保持不变；`--file <rel>` 是人手动点名的单文件探针，不受 `SKIP_FILES` 影响。

## 基线怎么用

`i18n-baseline.json` 记录**已接受**的存量串，按 `文件 → 串内容` 比对
（**不按行号**——行号会随无关编辑漂移，用它做基线每次改动都会误报）。

命中基线 = 放行；不在基线 = 守卫失败。因此这个守卫拦的是**新增**硬编码，不会
一上来就红一片然后被人关掉。

### N-04 完成态：基线从 61 收缩到 1（2026-10-01）

N-04 的验收目标是「**硬编码中文源码守卫零豁免**」。基线的历史峰值是 105 处，
轮 28 清出两处死代码（`executor-mode.ts` 4 条、`api/event-subscriptions.ts`
4 条）后降到 61；本轮把剩余 61 处逐条回读源码重审，**61 → 1**：

- **60 处迁移**：它们全是「可选 t 参数的中文缺省值」惯用法（`describeCron(expr, t?)`
  / `formatRelativeTime(v, t?)` / `priorityTag(v, t?)` / `failureRunbookAction(fr, t?)`
  等）——屏上调用点全部传 `t`，中文只在直调（测试）与「调用方忘传 t」时出现。
  迁移形态统一为**缺省回落 i18n 单例**（`const T = t ?? ((k) => i18n.t(k))`，
  非组件文件直引单例，与 `api/tasks.ts` 的 N-04 先例同模式）：中文从源码消失、
  直调路径跟随当前语言（测试环境默认 zh，旧锚定逐字不变）、忘传 t 的调用点
  从「永远中文」变成「跟随用户语言」。三处连兜底一起清除：
  `priorityTag`/`TIMEOUT_ACTION_OPTIONS` 的中文 `label` 字段删除（展示统一由
  调用方按 value 走 i18n）、`aggregateFailureTop` 的 `unknownError` 改必传、
  `failure-runbook.ts` 的 16 条中文映射表删除（文案唯一来源 = locales 的
  `runbook.*`，键集注册表 `RUNBOOK_ACTION_T_KEY` 导出供测试锚定）。
  顺带修一个真缺陷：`describeCron` 此前即便传 `t` 也用硬编码 `DOW_ZH` 拼星期，
  英文界面会漏出「一、二、三」——现走 locales 既有而未接线的 `cron.desc.dow.*`
  双语键（en 侧为 Sun/Mon/…）。
- **1 处保留（零豁免不可达项）**：`i18n/index.ts` 的语言名 `'中文'`——语言
  切换器里该词以母语自称，**所有语言下都应显示「中文」**（英文界面显示
  "Chinese" 反而是错的）。它不是「待迁移」，是「迁移无意义」；守卫 AST 口径
  无法表达「这串正确」，故留在基线并在此记录理由。这是基线里唯一不可清零项。

zh/en 双侧 key 集合由 `__tests__/i18n-infra.test.tsx` 比对，`t()` 引用的 key
真实性由 `i18n-source-guard.test.ts` 检查，本守卫拦新增硬编码——三者互补。

### 守卫的边界（桌面端不在扫描范围）

本守卫只扫 `apps/admin-web/src`。**executor-desktop 的渲染层是另一张地图**，
守卫对其不可见，不要把「admin-web 守卫绿」误读为「桌面端已双语」：

- 托盘/主进程文案已按 `TRAY_TEXTS` 双语常量表收口
  （`apps/executor-desktop/src/main/tray-texts.ts`，含 agent-status-view）。
- **ConfigPage**（设置页）已收编：文案在
  `apps/executor-desktop/src/renderer/i18n.ts` 的 `CFG_TEXTS`（zh/en 扁平键表，
  与托盘同范式；语言判定 `navigator.language` en* → en），键位对齐由
  `renderer.selftest.mjs` 静态断言。
- 其余 renderer 页面（AppsPage/StatusWindow/HistoryPage/Wizard 及 App.tsx、
  UpdateBanner、ErrorBoundary 等组件）仍是硬编码中文（DESIGN-AUDIT-2026-09-22
  记录约 5600 字），需另立任务逐页迁移（先抽外层 chrome，再逐页，照
  ConfigPage 的 `cfg.*` 键表先例）。

### 新增条目要写理由

往 `accepted` 里加串时，请在该 PR 里说明为什么它不需要 `t()`。默认应该是
**迁移**：`t('key')` + `zh.ts`/`en.ts` 成对补词条（两侧 key 必须齐平，
`__tests__/i18n-infra.test.tsx` 会比对集合，`i18n-source-guard.test.ts` 会
检查 `t()` 引用的 key 真实存在）。

## 自检（`--selftest`）

判据面本身也有人守：`--selftest` 在 `mkdtemp` 临时夹具树里跑**本脚本的真子进程**（不读真实
`src/`），逐条断言真实 exit code 与关键输出——只断言「函数返回几条」测不到 CLI 入口、
`process.exit()`、基线比对与采集面这些真正会坏的地方；夹具不隔离则「扫的是真实仓库」，删掉
源码时用例还会碰巧变绿。

| # | 用例 | 期望 |
|---|---|---|
| ① | 被扫文件里的 CJK `StringLiteral` | exit 1，点名 `文件:行` + `[string]` |
| ② | CJK `JsxText` | exit 1，`[jsx-text]` |
| ③ | 仅注释里有中文 | exit 0（AST 排除注释；退回 grep 口径会红） |
| ④ | `SKIP_FILES` 里的中文（`test-setup*.ts`） | exit 0（不进采集面）——删掉清单条目即转红 |
| ⑤ | `src/*.test.ts` 里的中文 | exit 1（排除不是「所有 test 文件」） |
| ⑥ | 夹具基线 `accepted` 命中 | exit 0，`基线内 1 处已接受` |
| ⑦ | 夹具基线陈旧项 | exit 1，`基线陈旧`（N-04 反向检查未退化） |
| ⑧ | `--selftest --check` 混用 | exit 2（互斥） |
| ⑨ | 盘点模式（无开关） | exit 0，列出「文件数、命中数」 |

### 自检已接进门禁（R145）

`apps/admin-web/package.json` 的 `lint:i18n` 现在是**三条命令**，顺序固定为
「**先自检、再主判据**」：

```bash
node scripts/i18n-scan.mjs --selftest && node scripts/i18n-scan.mjs --check && node scripts/i18n-key-check.mjs
```

- **为什么先自检**：自检是主判据的**前置体检**——一旦采集面/排除清单/基线比对被人改坏，
  先把「判据本身坏了」报出来，而不是让主判据给出一句好听的绿（`--check` 在采集面塌成 0
  个文件时同样是绿的）。自检红了就不必再跑主判据。
- **为什么是两次调用**：`--selftest` 与 `--check` **互斥**（同给 ⇒ exit 2，见用例⑧），
  绝不能写成 `--selftest --check`。
- **为什么挂在 `lint:i18n` 而不是另加 CI step**：`lint:i18n` 是本地与 CI（`ci.yml` 的
  admin-web job）**共用**的唯一入口——本地手跑与 CI 跑的是同一条链，不会出现「CI 跑了、
  本地漏跑」的分叉（仓库对自检接线的既定纪律见根 `package.json` 的 `//selftest-wiring`）。
  在 CI step 里再单独加一行 `node scripts/i18n-scan.mjs --selftest` 只会**重复跑**。
- **成本**：9 条用例各拉一个真子进程，实测约 **2 秒**、峰值内存 ~120 MB；夹具全部建在
  `os.tmpdir()` 的 `mkdtemp` 目录里，**不写仓库内文件**、**不访问网络**，退出码只有
  `0`（9/9 通过）/ `1`（有用例失败）。

## 与既有三条 i18n 守卫的分工

| 守卫 | 拦什么 |
|---|---|
| `i18n-infra.test.tsx` | zh/en **key 集合不一致**（漏翻） |
| `i18n-source-guard.test.ts` | `t()` 引用了**字典里不存在的 key**（界面渲染裸 key，vitest 侧） |
| 本守卫（`i18n-scan.mjs --check`） | **新写的硬编码中文界面串**（漏迁移） |
| `i18n-key-check.mjs`（B-5，挂 `lint:i18n` 链） | 缺键的**脚本级**守卫：区分 zh/en 单侧缺失与双侧缺失（双侧缺 = 渲染裸 key），动态键（`t(变量/模板串)`）按文件登记进 `i18n-key-baseline.json` 显式审计，基线陈旧条目（词条已补）点名要求删除 |

四者互补，缺一不可：漏定义会让用户读到 `secretsEditor.alertTitle` 这种标识符
（看起来像功能坏了），漏迁移则表现为中英混排。
