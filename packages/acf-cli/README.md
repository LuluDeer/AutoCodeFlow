# @autocodeflow/cli

AutoCodeFlow CLI —— 在终端里管理任务、执行、应用、执行器与项目。

```bash
npm i -g @autocodeflow/cli

acf login
acf task list --status active
acf task trigger <taskId> --wait
acf exec tail <execId>
```

> **API 地址口径**（2026-10-07）：admin-api 路由带全局 `/api` 前缀。
> `--api-url`/`ACF_API_URL`/login 的 URL prompt 对**不带** `/api` 尾段的地址
> 会在请求期自动补上（缺补已有留——修复了默认 `http://localhost:3105` 对
> 标准部署恒 404 的开箱缺陷）；已带 `/api` 的地址逐字节原样。唯一不适用：
> 「剥 `/api` 前缀」的反代且喂根地址——请传剥前缀后的源站地址。

每个命令（含每个子命令）都支持 `acf <命令> --help`：一行用途、参数表，以及
至少一个可直接复制的示例。缺参 / 未知命令 / 未知选项时，报错行之后会紧跟该
命令的完整帮助（含示例），不需要去翻文档。

## 退出码

CLI 的非零退出码按失败类别区分，脚本/CI 可以只按码分支处理（所有非零码都
代表失败，`!= 0` 的既有判断不受影响）：

| 退出码 | 含义 | 典型场景 / 下一步动作 |
| --- | --- | --- |
| `0` | 成功 | 含 `--help` / `--version` / 主动放弃确认（`Aborted.`） |
| `1` | 运行失败 | 服务端拒绝（400/403/404/409/5xx，错误行透出后端 message）；`--wait` 等到失败终态；`acf task lint` 检出语法错误 |
| `2` | 用法 / 参数错误 | 缺参、未知命令/选项、非法取值（如 `--wait-timeout abc`）；本地 payload 问题（JSON 解析失败、`--file` 读不了、`task lint` 无法推断语言）；**非交互 stdin 下的破坏性操作缺 `--yes`**（见下） |
| `3` | 认证失败 | 401：凭据缺失/过期且自动刷新失败 → 运行 `acf login` |
| `4` | 网络失败 | 连接不通 / 超时 / DNS → 检查 `--api-url`、`ACF_API_URL`；`acf exec tail` 流中断或空闲超时 |
| `130` | 中断（SIGINT） | Ctrl+C。输出会补一个换行，不留半行 spinner |

### 退出码 1 的两个高频非「失败」通道（CI 必读）

同样是 `1`，但语义**不是**「操作失败」，不要据此触发回滚/告警：

- **`--wait` 轮询超时**：执行**仍在运行**，CLI 只是放弃了等待（默认 600s，
  用 `--wait-timeout <s>` 放宽）。此时输出会明确写「The execution is still
  running」，跟进用 `acf exec tail <execId>`。**结果未知 ≠ 失败**。
- **批量部分失败**：`acf task batch <action>` 与 `acf app upgrade-all` 在
  「部分目标被拒」时返回 1（服务端 HTTP 仍是 2xx）。逐项结果看 stdout 的
  `✗ <id>: <reason>` 行或 `--json` 输出。

### 破坏性操作的 `--yes`（非交互必读）

`app delete` / `task delete` / `deploy remove` 有交互确认。**stdin 非 TTY 时
（CI、agent、`< NUL`、管道）它们不会静默放行也不会静默取消，而是以退出码 2
拒绝**，要求显式传 `-y/--yes`：

```bash
acf task delete <id> -y     # 非交互下唯一被接受的确认方式
```

判据是 `process.stdin.isTTY`。同族纪律：`acf login` 在非交互下同样不会对
地址/用户名/密码发问，缺少 `--user` 或 `ACF_PASSWORD` 时直接以退出码 2 报
可操作错误（不再出现「exit 0 但其实没登录」）。

单一事实源在 `src/ui.ts` 的 `EXIT_CODES`；错误分类（401/网络/服务端）在
`src/client.ts` 的 `classifyApiError` 做一次，命令层统一经 `emitError` 出口
消费。

## 机器可读输出（`--json`）

所有只读命令都支持 `--json`（CI/脚本消费面，错误仍走 stderr + 非零退出码）：

- 列表 / 信封形态（`task list`、`task executions`、`app list`、
  `app deployments`、`app releases`、`deploy list`、`executor list`、`sop list`、
  `agent sessions`、`audit list`）→ 单行紧凑 JSON，信封（`{list|data|items, total}`）原样直出；
- 单对象 / 详情形态（`task get`、`task stats`、`task versions`、
  `task compare`、`task logs`、`task trigger`、`app get`、`app versions`、
  `executor get`、`sop show`、`project list`、`project members`）→
  pretty(2) JSON。
- 部分写面命令同样支持 `--json`（响应对象直出）：`app upload`、
  `app upgrade-all`、`task webhook`、`task export`、`task batch`、
  `apikey create`。

`--json` 不裁剪字段：后端返回什么就输出什么，消费方按 `--help` 示例里的
形状断言即可。

## 认证与配置

凭据保存在用户配置目录（`acf config show` 查看实际路径），文件权限 0600；
文件损坏时 CLI 会把坏内容备份到 `<config>.corrupt`、给出 `acf login` 指引，
并用默认配置继续运行。

- `ACF_TOKEN` / `ACF_REFRESH_TOKEN` / `ACF_API_URL`：环境变量注入（CI/cron
  推荐，不落盘）；`--api-url` / `--token` 可单次覆盖。
- `acf login` 的密码输入不回显；`--password` 参数已标记 deprecated（会进
  shell history），CI 请用 `ACF_PASSWORD`。
- 已启用 TOTP（两步验证）的账号：`acf login` 会在密码后提示输入 6 位动态码；
  CI/非交互场景用 `acf login --user <name> --code <6位码>` 提供（stdin 非交互
  且缺 `--code` 时会报可操作的用法错误，退出码 2）。
- `acf apikey`（AUTH-03）：为 CI/CD 创建限权 API Key（`readonly` / `trigger` /
  `manage`）。明文（`acf_<64 hex>`）仅在 `acf apikey create` 时回显**一次**，
  此后只能 `acf apikey list`（脱敏）/ `acf apikey revoke <id>`。
- Access token 过期时自动用 refresh token 换发并重放一次；刷新失败才要求
  重新登录（此时退出码为 3）。

## 应用部署（run-mode 语义，2026-10 实测修复）

- `acf app deploy <appId>`：缺省 `-m scheduled` —— **仅部署、由中台/任务调度触发，部署后不自跑**（批处理/中台定时触发场景的正确模式，存量部署 11/12 用它）。三档语义：
  - `once`：启动入口脚本一次，退出不重启；
  - `daemon`：常驻进程——**部署时立刻启动入口脚本**，异常退出自动重启（退出码 0 不重启）；
  - `scheduled`（别名 `deploy-only`）：只下发代码、**不启动进程**，由任务调度触发。
- 显式传 `once`/`daemon` 时，CLI 会在发请求前打黄色预警「将立刻启动入口脚本」——避免"部署即跑"与后续 `task trigger` 双跑、并发写同一产物目录。
- 部署列表：`acf app deployments [appId]`，或 `acf deploy list [appId]`（同源同契约，deploy 组下的可发现入口）。
- 版本发布追溯：`acf app releases <appId>`（DEP-01 统一视图：版本 × 最近部署——状态/次数/执行器/runMode/触发方式；`app versions` 是过渡期 legacy alias）。
- 清理遗留记录：`acf deploy remove <deploymentId> -y` —— 删除**已终结**的部署记录（failed/stopped）；在途/运行/待审批行服务端 409（先 `stop`，或走审批 `reject`/`cancel`）。

## 任务参数注入（params → AUTOFLOW_\*）

`task create`/`update` 的 `body.params` 在每次执行时注入为 `AUTOFLOW_<KEY>` 环境变量（键名转大写），值 JSON 序列化：布尔/数字是裸值（`true`/`3`），**字符串带双引号**（`"yes"`），对象/数组为 JSON —— 脚本侧请按 JSON 解析，不要当普通字符串（两执行器契约向量见 contract-fixtures 的 `executorEnvSerialization`）。

- **按 run 覆盖参数**：`acf task trigger <id> --params '{"KEY":"value"}'` 覆盖任务默认 params（TriggerTaskDto 同 webhook 面；缺省不发 body，用任务默认值）。block-strategy 闸（N-14）按生效参数判重。
- **按名/描述搜任务**：`acf task list --search <kw>` 走 `q` 参数（name OR description，控制台搜索框同款）；`-k/--keyword` 仍只搜 name（向后兼容通道）。

## 应用包上传 / 灰度升级 / 审批 / webhook / glue

- `acf app upload <pkg.zip> --name <name>`：multipart 上传应用包（按名称
  upsert；`.zip` 扩展名/魔数/zip-bomb 校验在服务端）。`--runtime` / `--version`
  可选；大包上传走独立 300s 超时预算。
- `acf app upgrade-all <appId>`：对全部 RUNNING 部署触发滚动升级（缺省 = 全量，
  既有语义）。`--strategy canary --percentage N`（int 1-100，缺省 50）走灰度：
  首批心跳确认 → 健康探测 → 自动提升其余台。**批次由服务端异步推进，受理 ≠
  完成**——进度看 admin 中台（部署行 `rolloutState`）或 `acf app deployments`。
- `acf approval list | approve <id> --note … | reject <id> | cancel <id>`：
  DEP-04 审批流。第二人规则在服务端强制（审批者 ≠ 提交者，否则 403）；
  撤回自己的请求用 `cancel`；`--note`（≤200 字符）映射契约字段 `reason`。
- `acf task webhook enable|rotate|disable|status <taskId>`：任务级入站 webhook
  （HMAC）。secret 仅在 enable/rotate 响应中回显**一次**；`status` 查看 URL
  不动密钥；`disable` 后签名请求即刻 401。
- `acf task glue <taskId> -f glue.js`（或 `--stdin`）：在线更新 GLUE 脚本。
  语言按扩展名推断（`.js/.mjs/.cjs` → `javascript`），或 `--language
  python|javascript|shell` 显式指定（执行器运行时白名单）；空脚本本地即拒。

## 应用互斥组（MUTEX-01，2026-10 补齐 CLI 面）

同一组内的应用在**同一台设备上永不并发**（组内并发数默认 1 = 串行）——典型场景
是独占型资源：浏览器实例、单点登录账号（顶号）、GPU 槽位。后端 `mutex-groups`
四端点自 MUTEX-01 起就存在且中台在用，此前 CLI 零接入。

- `acf mutex list`：拉取可选组（**与中台应用表单下拉同源**），列出 `id` / 名称 /
  每设备并发 / 作用域 / 已挂应用数。挂应用时用这里的 `id`。
- `acf mutex create --name <name> [--max-concurrent N] [--scope device|global] [--description <text>]`
  ：建组。`--max-concurrent` 取值 1-100（与后端 `@Min/@Max` 同界）；
  `--scope` 两档语义差别很大：
  - `device`（默认）：**单机串行、跨设备并发**——每台设备上同时最多 N 条；
  - `global`：**全平台串行**——整平台同时最多 N 条（单点登录顶号类场景）。
- `acf mutex update <groupId> [--name] [--max-concurrent] [--scope] [--description]`：
  改组。至少给一个字段（空 patch 本地即拒，退出码 2——服务端会「成功但什么都没改」，
  容易被误读为已生效）。`--scope` 可即时收紧，在途 WAITING 执行由 sweep 重派自愈。
- `acf mutex delete <groupId> [-f|--force] [-y|--yes]`：删组。组上仍挂应用时服务端
  返回 409 并告知挂载数量；确认后用 `--force` 放行（挂载应用经 FK `SET NULL`
  自动回到「不参与互斥」）。属破坏性操作，非交互场景必须显式 `-y`。
- **把应用挂进组**（沿用既有 `app update`，字段此前未在帮助里列出）：
  `acf app update <appId> --body '{"mutexGroupId":"<acf mutex list 的 id>"}'`；
  传 `null` 摘组。`acf app get <appId> --json` 可读出当前挂的组（表格视图不显示）。
  组不存在时服务端 404（`assertMutexGroupExists` 前置校验）。
- 写面（create/update/delete）要求 **ADMIN** 角色；`list` 任意登录用户可读。

## 开发

```bash
npm run test        # vitest run
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
```
