# 桌面数据填报示例（桌面执行器 / node）

> **受众**：要在桌面执行器上做本地数据填报的开发者 · **状态**：稳定 · **最后核对**：2026-11-21

演示「桌面执行器形态 + 数据填报」类任务：手动触发 → 在桌面执行器上读取本地
填报数据文件（CSV）→ 逐行校验 → 汇总结果写回 JSON 产物。任务配置用
`executorTags:["desktop"]` 表达桌面执行器形态，任务代码用 `node` 编写，
零第三方依赖，复制即得首次成功。

- 任务配置样例：[task.example.json](task.example.json)
- 任务代码：[desktop_data_entry.js](desktop_data_entry.js)
- runtime：`node`；触发方式：`manual`（手动/按钮触发，桌面执行器在线即可跑）

## 场景说明

1. 触发：任务 `triggerType=manual`，在控制台点「执行」或用 CLI `acf task trigger`。
2. 派发：`executorTags:["desktop"]` 让调度优先命中带 `desktop` 标签的桌面执行器
   （也可在创建时用 `--executor <id>` 钉定某台设备）。
3. 执行：读取本地 CSV（`inputFile`）→ 校验 `name`/`amount` 字段 → 统计有效/无效行。
4. 产物：汇总结果写到 `outputFile`（JSON），日志记录 `RESULT` 行与产物路径。
5. 首次成功友好：输入文件缺失时自动写一份样例 CSV（`createSampleIfMissing=true`），
   无需准备数据即可跑通。

## 前置条件

- 已部署 AutoCodeFlow admin-api，且至少有一台**在线的桌面执行器**带有 `desktop`
  标签（在控制台「执行器管理」确认；没有标签时用 `--executor <id>` 钉定）。
- 桌面执行器支持 node runtime（平台自带 executor-desktop 即可），且 runner 对
  `/tmp/acf-desktop-data-entry/` 有读写权限。
- 已配置 `acf` CLI 指向 admin-api（见下方环境变量），并有创建/触发任务的账号。
- 任务名全局唯一：`task.example.json` 的 `name` 若重名，改一个即可。

## 凭据占位

本示例**不需要任何外部凭据**（纯本地文件读写），因此 `task.example.json`
不含 `secrets`。真实场景若需回填业务系统，按同样方式注入：

```bash
acf task update <taskId> --body '{"secrets":{"FORM_SYSTEM_TOKEN":"真实令牌"}}'
```

脚本里用 `process.env.FORM_SYSTEM_TOKEN` 读取（secrets 按原名注入），不要写进
`params` 或源码。

## 如何创建任务

### 方式一：acf CLI（推荐）

```bash
export ACF_API_URL=http://localhost:3105
export ACF_TOKEN=acf_你的密钥

# 若桌面执行器没有 desktop 标签，用 --executor <桌面执行器 UUID> 钉定：
acf task create --file examples/desktop-data-entry/task.example.json --executor <桌面执行器 UUID>
# 输出：Task created: <taskId>
```

### 方式二：curl（不带 --executor 时按标签命中）

```bash
curl -X POST "$ACF_API_URL/api/tasks" \
  -H "Authorization: Bearer $ACF_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @examples/desktop-data-entry/task.example.json
```

## 如何看结果

```bash
# manual 任务：创建后手动触发一次并等待终态
acf task trigger <taskId> --wait

# 看执行日志，RESULT 行含 validCount / invalidCount 与产物路径
acf task logs <execId> --tail 200
```

日志里出现 `[desktop-data-entry] result written to /tmp/acf-desktop-data-entry/result.json`
与一行 `RESULT {..."validCount":2,"invalidCount":1...}` 即首次成功（样例数据里
故意有一行缺 amount，验证校验分支）。产物文件内容：

```bash
cat /tmp/acf-desktop-data-entry/result.json
```

> 本地直接跑（不经平台）：
> `node examples/desktop-data-entry/desktop_data_entry.js`，同样生成样例输入与结果产物。
