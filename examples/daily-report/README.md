# 每日报表导出示例（cron + 文件产物）

> **受众**：要接「定时跑批 + 产出文件」的开发者 · **状态**：稳定 · **最后核对**：2026-11-21

演示最典型的 TTFV 首次成功路径：cron 每天定时触发 → 脚本生成 CSV 报表文件产物 →
落盘并把产物路径写进执行日志；失败分支打 error 日志作为告警占位，配合任务级
`alarmEmail` 形成告警闭环。

- 任务配置样例：[task.example.json](task.example.json)
- 任务代码：[daily_report.js](daily_report.js)
- runtime：`node`（无第三方依赖，零安装即可跑）

## 场景说明

1. 触发：cron `0 3 * * *`（每天北京时间 03:00），5 段 cron，时区 `Asia/Shanghai`。
2. 执行：`daily_report.js` 读取运行参数，生成模拟报表数据并导出 CSV。
3. 产物：文件写到 `outputDir`（默认 `/tmp/acf-daily-report`），文件名含报表日期。
4. 告警占位：成功路径只打 info 日志；失败分支 `console.error` + 任务级
   `alarmEmail`，可在真实场景替换为钉钉/邮件/webhook 告警通道。

## 前置条件

- 已部署 AutoCodeFlow admin-api 与至少一个 node runtime 执行器（平台自带
  executor-node 即可），且 runner 能访问 `outputDir` 所指路径。
- 已配置 `acf` CLI 指向 admin-api（见下方环境变量），并有创建/触发任务的账号。
- 任务名全局唯一：`task.example.json` 里的 `name` 若与已有任务重名，改一个即可。

## 凭据占位

`task.example.json` 的 `secrets.REPORT_EXPORT_TOKEN` 是**占位符**，示例脚本
不会真的调用外部报表 API，所以留占位也能跑通首次成功。接真实数据源时：

- 用 `acf task update <taskId> --body '{"secrets":{"REPORT_EXPORT_TOKEN":"真实令牌"}}'`
  注入真实令牌（写入后 API 读回恒为 `******`，派发时按原名注入子进程 env）；
- 脚本里通过 `process.env.REPORT_EXPORT_TOKEN` 读取（secrets 按原名注入），
  不要把令牌写进 `params` 或源码。

## 如何创建任务

### 方式一：acf CLI（推荐，复制即得）

```bash
# 指向你的 admin-api 与 API key
export ACF_API_URL=http://localhost:3105
export ACF_TOKEN=acf_你的密钥

# 用示例配置创建任务（id 省略，由后端生成 UUID）
acf task create --file examples/daily-report/task.example.json
# 输出：Task created: <taskId>
```

### 方式二：curl

```bash
curl -X POST "$ACF_API_URL/api/tasks" \
  -H "Authorization: Bearer $ACF_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @examples/daily-report/task.example.json
```

## 如何看结果

```bash
# 手动触发一次并等待终态（不必等 cron 到点）
acf task trigger <taskId> --wait

# 看执行日志，RESULT 行里带产物绝对路径
acf task logs <execId> --tail 200
```

日志里会出现 `[daily-report] artifact=/tmp/acf-daily-report/daily-report-YYYY-MM-DD.csv`
与一行 `RESULT {...}`，即首次成功。控制台「任务详情 → 执行记录」也能看到同一执行。

> 想本地直接跑脚本（不经平台、无注入参数）：
> `node examples/daily-report/daily_report.js`，产物落在 `/tmp/acf-daily-report/`。
