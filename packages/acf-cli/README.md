# @autocodeflow/cli

AutoCodeFlow CLI —— 在终端里管理任务、执行、应用、执行器与项目。

```bash
npm i -g @autocodeflow/cli

acf login
acf task list --status active
acf task trigger <taskId> --wait
acf exec tail <execId>
```

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
| `2` | 用法 / 参数错误 | 缺参、未知命令/选项、非法取值（如 `--wait-timeout abc`）；本地 payload 问题（JSON 解析失败、`--file` 读不了、`task lint` 无法推断语言） |
| `3` | 认证失败 | 401：凭据缺失/过期且自动刷新失败 → 运行 `acf login` |
| `4` | 网络失败 | 连接不通 / 超时 / DNS → 检查 `--api-url`、`ACF_API_URL`；`acf exec tail` 流中断或空闲超时 |
| `130` | 中断（SIGINT） | Ctrl+C。输出会补一个换行，不留半行 spinner |

单一事实源在 `src/ui.ts` 的 `EXIT_CODES`；错误分类（401/网络/服务端）在
`src/client.ts` 的 `classifyApiError` 做一次，命令层统一经 `emitError` 出口
消费。

## 机器可读输出（`--json`）

所有只读命令都支持 `--json`（CI/脚本消费面，错误仍走 stderr + 非零退出码）：

- 列表 / 信封形态（`task list`、`task executions`、`app list`、
  `app deployments`、`executor list`、`sop list`、`agent sessions`、
  `audit list`）→ 单行紧凑 JSON，信封（`{list|data|items, total}`）原样直出；
- 单对象 / 详情形态（`task get`、`task stats`、`task versions`、
  `task compare`、`task logs`、`task trigger`、`app get`、`app versions`、
  `executor get`、`sop show`、`project list`、`project members`）→
  pretty(2) JSON。

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

## 开发

```bash
npm run test        # vitest run
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
```
