# 模板 / Skill 的分发契约（manifest + 生成式 registry）

> 对应建议：`docs/skills/registry.json` · 守卫 `scripts/check-template-manifest.mjs` · 生成物由 `--write` 维护。
> 相关既有纪律：[SOP front-matter](../../apps/admin-api/src/modules/sop/sop-frontmatter.ts)（未知键即失败 + 内容哈希）。

## 这份契约解决什么问题

在此之前，模板与技能侧**完全没有清单层**：没有版本、没有能力声明、没有登记表。
第三方想复用一份技能或任务模板，只能**手抄 DB**——抄什么、抄到哪一版、缺了什么，全靠人眼。

本契约把这件事变成三件可机械验证的事：

1. **每个单元带一份声明式 `manifest.json`**（技能目录 / 任务模板目录各一份）；
2. **`registry.json` 由清单派生**（生成物，不是手写清单）；
3. **双向比对**：清单 ↔ 生成物两边都不许漂移（缺登记 / 幽灵条目 / 内容不一致）。

它**不是**插件系统。清单是**声明式产物**，中台校验、导入、落库、审计——没有第四步。

## 目录形状

```
docs/skills/
├── <skillDir>/manifest.json            技能清单（name == <skillDir>）
├── templates/<key>/manifest.json       任务模板清单（name == <key>，key 即 DB 的唯一 key）
└── registry.json                       **生成物**（不要手改）
```

`templates/` 是**容器**，不是技能目录；除此之外 `docs/skills/` 下的每个子目录一律
按技能目录对待，必须带 `manifest.json`。

## 清单字段（封闭集合：多一个键就红）

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | **必须逐字等于所在目录名**；形状 `[a-z0-9][a-z0-9._-]{0,63}`（与任务模板 DB `key` 的约束对齐） |
| `version` | 是 | 语义化版本 `x.y.z` |
| `description` | 是 | 非空，≤500 字符 |
| `capabilities` | 是 | 能力域数组；**复用 SOP 的四值域** `browser \| gui \| filesystem \| http` |
| `params` | 是 | 用户可配参数声明（对象，可为空） |
| `entrypoints` | 是 | 相对本目录的入口文件路径数组；技能至少一个，任务模板允许为空 |

`params` 的每一项照 `plugin.json` 的 `userConfig` 形状：

| 键 | 说明 |
|---|---|
| `type` | `string` / `number` / `boolean`（必填） |
| `title` | 展示名（可选） |
| `description` | 说明（可选） |
| `required` | 是否必填（可选，布尔） |
| `default` | 缺省值；类型必须与 `type` 一致；给了 `options` 就必须在其中 |
| `options` | 允许值枚举（可选，非空数组；成员只能 string/number/boolean） |

### `entrypoints` 的安全判据

路径先 `path.resolve` canonicalize，再要求**位于本目录之内**。于是：

- `../../evil.py` ⇒ **拒绝**（canonicalize 后落在目录外）；
- `/etc/passwd`（绝对路径）⇒ **拒绝**；
- 指向不存在的东西 ⇒ **拒绝**。

为什么必须这么严：清单是**分发物**，导入方会按它去读文件。允许"指向目录外"就等于
把「该读哪儿」的决定权推给了不可控的一侧（claw-code 的 `validate_command_path` 对
裸命令直接放行，正是这条教训的来源）。

## 为什么清单里**不放**可执行 hook

这是**纪律**，不是功能缺失。三个理由：

1. **放了它，清单就变成执行通道。** 一份被导入即执行的清单，等于把「分发契约」升级成
   「远程代码执行面」——而第三方扩展在本仓的定位明确是「只能提交**声明式产物**」。
2. **放不进去，才是可审计的。** 清单的键是**封闭集合**，`hook` / `command` / `script`
   都不是白名单键 ⇒ 写进去就是「未知键 ⇒ 红」。这条判据是**结构性**的，不依赖人记住规则。
3. **可执行部分本来就有归宿。** 技能的可执行文件是**独立文件**（`entrypoints` 指向它），
   由执行器按自己的沙箱纪律去跑；任务模板的可执行内容在 DB 的 `config` 里。
   清单只声明「有哪些入口、参数是什么」，不承载代码。

同一纪律的另外两条推论：**不做目录自动遍历装载**（多一个目录 ≠ 多一条运行期能力）、
**不做热插拔**（变更走 review + 守卫 + 生成物）。

## registry.json：生成物，不是清单

`docs/skills/registry.json` 由 `scripts/check-template-manifest.mjs` 从清单**派生**，
每条带 `contentHash`（清单稳定序列化后的 sha256）。它存在的意义是让"漂移"变成红灯：

| 现象 | 守卫输出 |
|---|---|
| 清单有、registry 没有 | `缺登记` |
| registry 有、清单没有 | `幽灵条目` |
| 两边都有但内容不同（含 hash 失配） | `内容不一致` |

**改清单之后**：跑 `node scripts/check-template-manifest.mjs --write` 重新生成。

`--write` 的边界是**只写 `registry.json`**：

- **绝不改任何 `manifest.json`**（修复路径是「改清单」，不是「改生成物」）；
- **清单本身有错时拒绝落盘**——否则就是把一份坏清单固化成"一致"的生成物。

## 任务模板清单 ↔ 官方模板常量的双向比对

`templates/<key>/manifest.json` 不是自由文档：`<key>` 必须是官方模板
（`apps/admin-api/src/modules/task-template/task-template.constants.ts` 的
`OFFICIAL_TASK_TEMPLATES`）的 key，且：

- 官方每个 key 都必须有清单目录（否则 `缺登记`）；
- 清单目录的 key 必须存在于官方模板（否则 `幽灵条目`）；
- `description` **逐字等于**官方模板描述（否则红）；
- `params` 的键集合必须**等于胶水脚本实际读取的参数名**（`paramValue('x')` /
  `param_value(params, "x")` / `params.x`），改了脚本没改清单（或反之）⇒ 红。

## 事实源（都只有一个）

| 事实 | 来源 | 读不到时 |
|---|---|---|
| 能力域四值 | `apps/admin-api/src/modules/sop/sop-frontmatter.ts` 的 `SOP_CAPABILITIES` | **结构红**（不抄副本） |
| 官方模板 key/描述/config | `task-template.constants.ts` 的 `OFFICIAL_TASK_TEMPLATES` | **结构红** |
| 清单内容 | `docs/skills/**/manifest.json`（人工维护） | **结构红** |

能力域为什么用文本抽取而不是 `import`：`sop-frontmatter.ts` 依赖 `js-yaml`，而本守卫
必须**零依赖、CI 无需 `npm ci`**。抄一份四值到脚本里则是"抄本与本体各自演化"——
SOP 加第五个能力域时守卫不会知道。抽取失败一律**红**，绝不"空集 ⇒ 没问题"。

## 用法

```bash
node scripts/check-template-manifest.mjs            # 校验 + 双向比对（CI 判据）
node scripts/check-template-manifest.mjs --write    # 重新生成 registry.json（只写它）
node scripts/check-template-manifest.mjs --selftest # 自检（22 例，真子进程 + fixture）
```

退出码：`0` 全绿 / `1` 有红（契约违反或结构红）/ `2` 用法错误。

## 未做（本轮明确不做）

- **`POST /task-templates/import` 导入端点**：本轮未做，只做了「清单 + 守卫 + 导出」。
  原因是它越出本轮足迹——
  ① 新增路由必须重跑 `npm run swagger:export` 重生成 `apps/admin-api/openapi.json`，
     而该文件的生成链要走完整 `AppModule` bootstrap（依赖 DB + Redis，本轮环境不可用）；
  ② 生成物 `apps/admin-web/src/types/generated/api-types.ts` 与审计动作标签
     （`apps/admin-web/src/pages/audit/index.tsx` + `locales/{zh,en}.ts`）都在
     `apps/admin-web/**`，**本轮明令禁止改动**；实测新增一个审计动作
     `task_template.import` 就会让 `check:interface-maps` 报「1 个审计动作没有标签映射」；
  ③ `docs/api-reference.md` 的端点表也需同步重生成（`check:api-reference`）。
- 因此「导入 + key 冲突即拒」的**判据侧**已经落在守卫里（`缺登记` / `幽灵条目` /
  「清单目录的 key 必须存在于官方模板」），但**落库路径**留给下一轮：届时按
  `TASK_TEMPLATE_KEY_EXISTS`（已存在的 409）拒绝冲突即可，无需新错误码。

## 回退

删掉 `manifest.json` 与 `registry.json`、退掉本守卫即可，DB 面零改动。
