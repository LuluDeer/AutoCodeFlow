# AutoCodeFlow 自动化应用开发 Skill

> 给 AI agent 的平台侧原始规范。完整流程：写代码 → 打包 zip → 上传应用 → 建任务 → 迭代 → 验证。
>
> **本文档与 `.qoder/skills/acf-python-task-package/SKILL.md` 同源同口径**，字段名以 `apps/admin-api/src/modules/task/dto/create-task.dto.ts`
> 与 `apps/executor-python/manifest.py` 为唯一事实来源。**不要凭记忆或旧文档编造字段名**——见「[常见错误字段名对照](#常见错误字段名对照必读)」。

---

## ⚠️ 铁律：这不是一个 pip 包

- **禁止** `pyproject.toml` / `setup.py` / `pip build` / `.whl` / `.tar.gz` 作为业务任务包载体。
- 业务任务包 = **一个 zip**，平台解压后**直接执行脚本**。
- 平台靠 zip **根目录**的 `manifest.yaml` 识别入口，靠 `requirements.txt` 装依赖。
- 打 `.whl` / `.tar.gz` 只用于「执行器本体」发布（`/api/executor-packages`），**不是**业务任务包。

---

## 平台地址与鉴权

- 管理后台：`http://<YOUR_HOST>`
- API 基础路径：`http://<HOST>:3105/api`
- Swagger：`http://<HOST>:3105/api/docs`
- 登录：`POST /api/auth/login`，响应字段是 **`accessToken`**（驼峰）——**不是** `access_token`。

```bash
TOKEN=$(curl -s -X POST http://<HOST>:3105/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<PASSWORD>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
```

> **全局 ValidationPipe 开了 `whitelist: true` + `forbidNonWhitelisted: true`**：
> 请求体里出现**任何 DTO 未声明的字段**都会直接 **400**。这就是「发明字段名 = 致命错误」的根因——
> 多写一个 `scheduleType` 或 `taskEntry`，整个建任务请求被拒。

---

## Step 1 · 项目结构（固定，不要改）

```
my-app/
├── manifest.yaml        # 必须，在 zip 根目录（不要多套一层目录）
├── main.py              # 任务入口脚本（entrypoint 指向它；也可放 tasks/main.py）
└── requirements.txt     # 仅当有第三方依赖时需要
```

- **不要** `__init__.py` / `pyproject.toml` / `setup.py` / `Dockerfile` / `src/`。
- 业务代码可按需拆子目录（如 `tasks/`、`lib/`），但 `manifest.yaml` 与 `requirements.txt` **必须在根**。

---

## Step 2 · manifest.yaml（执行器实际只读 4 个字段）

执行器读 zip 根目录的 `manifest.yaml`（或 `manifest.yml`），**只消费以下四个字段**，
且**任务级字段覆盖 manifest 字段**（`apps/executor-python/manifest.py`）：

| 字段 | 含义 | 默认 | 备注 |
|------|------|------|------|
| `runtime` | `python` 或 `node` | `python` | zip 应用渠道须与任务 `runtime` 一致 |
| `entrypoint` | **相对 zip 根**的入口脚本路径 | `main.py` | 例：`tasks/main.py` |
| `timeout` | 执行超时秒数 | 平台默认 | `0` = 不限时，上限 86400 |
| `requirements` | 依赖列表（list） | 无 | 与包内 `requirements.txt` **合并** |

```yaml
runtime: python           # python | node
entrypoint: main.py       # 相对 zip 根的入口脚本；缺省 main.py
timeout: 300              # 秒；0=不限时

# 可选：把依赖写进 manifest（会与包内 requirements.txt 合并，任务级同名覆盖）
# requirements:
#   - requests>=2.31
```

### ❌ 不要写进 manifest.yaml 的东西

| 别写 | 为什么 |
|------|--------|
| `name` | 应用名由上传时的 `name` 表单字段承载 |
| `version` | 版本挂在**应用(application)记录**上，上传时**自动递增** |
| `description` | 同上，属于应用记录 |
| `tasks[]` | 执行器在 zip 渠道**完全不读**；多任务自动注册只在 **git 仓库部署**时读根目录的 **`manifest.json`**（JSON，**不是** YAML），任务项字段是 `entrypoint`。**zip 单入口任务不涉及，别混用两套。** |

> **Python 解释器版本也不在 manifest 里声明**——它是**任务**上的 `runtimeVersion`（见 Step 6）。

---

## Step 3 · 任务脚本（main.py）

脚本只需要一个 `main()`。执行结果回调由执行器统一处理，**任务脚本不需要持有平台 token**。

### ⚠️ 成败由「进程退出码」决定，不是返回值

- **返回 dict ≠ 成功信号**。执行器只看**进程退出码**：`0` = SUCCESS，非 `0` = FAILED。
- **`return {"success": False}` 不会让任务失败**——它显示为 **SUCCESS**（这是最常见的误判）。
- **要失败必须抛异常**（让进程以非零码退出）。

```python
import os
import json


def main() -> dict:
    # 运行时参数以 AUTOFLOW_ 前缀注入（键名会被大写化，见下方「参数键名陷阱」）
    target = os.environ.get("AUTOFLOW_TARGET", "prod")

    print(f"running: target={target}")

    # === 你的业务逻辑写在这里 ===
    result = do_something(target)
    # ===========================

    # 成功：正常返回即可（进程退出码 0）
    return {"success": True, "result": result}


def do_something(target: str) -> dict:
    # 失败：必须抛异常，而不是 return {"success": False}
    # if bad_condition:
    #     raise RuntimeError("缺少必要输入")
    return {"target": target, "processed": 0}


if __name__ == "__main__":
    # 本地调试用
    print(json.dumps(main(), ensure_ascii=False, default=str))
```

### ⚠️ 参数键名陷阱（camelCase 参数读不到）

- 执行器注入时把键名**大写化**：`env[f'AUTOFLOW_{k.upper()}']`。
- Python SDK 读回时又把它**小写化**：`params[k[len("AUTOFLOW_"):].lower()] = v`。

于是任务参数若配成 camelCase（如 `sourceDir`），SDK 里只能以全小写键 `sourcedir` 取到：

```python
ctx.get_param("sourceDir")    # ❌ 返回 None（静默落回默认值，最难排查）
ctx.get_param("sourcedir")    # ✅
```

**建议**：任务参数名**一律用全小写**（如 `source_dir`、`target`）；若必须兼容 camelCase，
做一次小写回退查找：

```python
value = ctx.get_param("sourceDir") or ctx.get_param("sourcedir") or "默认值"
```

### 平台注入的环境变量

| 变量 | 说明 |
|------|------|
| `TASK_ID` / `TASK_NAME` / `EXECUTION_ID` | 任务与本次执行标识 |
| `AUTOFLOW_<KEY>` | 触发时传入的运行时参数（KEY 大写）；读参优先级 `AUTOFLOW_*` > 代码默认值 |
| `AUTOFLOW_ADMIN_API_URL` | Admin API 基址（回调可用时注入） |
| `AUTOFLOW_CALLBACK_TOKEN` | 一次性 `v1.` HMAC token，**绑定本次 executionId** |
| `AUTOFLOW_EXECUTOR_ADDRESS` | 执行器注册地址（SDK 自动补进回调项） |
| `AUTOFLOW_ARTIFACTS_DIR` | **预创建**的 `<work_dir>/artifacts/` 目录，用于交付产物（FEAT-05，见下节） |
| `AUTOFLOW_TRACE_ID` | 仅在启用链路追踪时注入（W3C traceparent，做下游关联） |

旧版自建执行器不注入回调凭证 → `ctx.callback.enabled == False`，任何上报抛 `CallbackDisabledError`（fail-closed）。
**必须先能力探测再回调**，不可用时降级为「只打日志、继续执行」。

### 依赖（requirements.txt）红线

- **只能写包规格**：`requests>=2.31`、`autoflow-sdk` 等。
- **禁止以 `-` 开头的 option 行**（如 `--index-url`）——执行器直接拒绝，防索引劫持；DTO 层也会 400。
- 私服源由**执行器侧** `PYPI_REGISTRY_URL` 配置，**永远不写进** requirements.txt。
- 包内 `requirements.txt` 与任务级 `requirements` **合并**：任务级同名覆盖、其余并集、顺序稳定。
- 无第三方依赖时**可不建** `requirements.txt`。

---

## Step 4 · 产物 artifacts（FEAT-05）——任务文件到达 UI 的唯一途径

把要交付的文件（截图 / 报表 / CSV / 日志）写进 **`AUTOFLOW_ARTIFACTS_DIR`**：

```python
import os
from pathlib import Path

art_dir = Path(os.environ["AUTOFLOW_ARTIFACTS_DIR"])   # 已预创建
(art_dir / "report.csv").write_text("a,b\n1,2\n", encoding="utf-8")
```

- 任务结束时执行器**扫描该目录**（**仅顶层，不递归**），上传文件，并随终态回调上报清单
  `[{name, size, sha256}]`。用户在**执行详情页**查看 / 下载。
- 限制：**最多 20 个文件**；**单文件最大 100 MB**；文件名必须匹配
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`（**必须以字母或数字开头**；**不能有空格、`#`、开头点或下划线**）。
  不满足者被静默跳过。
- 收集是 **best-effort**：任何异常只记日志，**绝不阻塞任务终态回调**。
- **写 `/tmp` 或在返回 dict 里塞路径都不会出现在 UI 上**——artifacts 目录是唯一通道。

---

## Step 5 · 打包成 zip（关键：manifest 必须在根）

```bash
cd my-app/

# manifest.yaml 必须在 zip 根目录（不要套一层目录）
zip -r ../my-app.zip manifest.yaml main.py requirements.txt

# 验证结构
unzip -l ../my-app.zip
# 应该看到：
#   manifest.yaml
#   main.py
#   requirements.txt
```

❌ 错误打包方式（会多套一层目录，平台找不到 manifest）：

```bash
# 不要这样
zip -r my-app.zip my-app/
```

zip 安全红线（执行器 vet + safe_extract 强制）：不得含 `..` 逃逸、绝对路径、盘符路径、符号链接条目；
压缩方法仅 stored/deflate；有条数 / 单文件 / 总解压量 / 压缩比上限。

---

## Step 6 · 上传（业务包 = 应用 zip）

**业务 Python 任务包 = 一个「应用(application) zip」**，执行器通过任务上的 `packageUrl`
（由 admin 从 `applications` 表解析）下载并运行。

- 管理后台：**应用管理 → 上传**（填 name、runtime=python，选 zip）。
- API：`POST /api/applications/upload`，**multipart 字段：`file` / `name` / `runtime`**，**最大 200 MB**
  （另有 zip 魔数校验 + zip-bomb 结构审查 + 可选 ClamAV 扫描）。

```bash
# 上传应用 zip
curl -X POST http://<HOST>:3105/api/applications/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=my-app" -F "runtime=python" \
  -F "file=@my-app.zip"
# -> 返回 Application 记录，含 id（记下来，建任务用）
```

> **`POST /api/executor-packages`（字段 `name`/`version`/`type`，另有 `PATCH :id/deprecate`、
> `:id/activate`、`:id/push`）不是业务任务包的部署路径**——它用于把**执行器本体运行环境**
> 分发到各执行器节点。业务任务包请走上面的 `applications/upload`。
> 旧文档把业务包传到这个端点、再用 `executorPackageName` 建任务，是**错误路径**。

---

## Step 7 · 创建任务

### 方式 A：管理后台手动建

**任务 → 新建任务** → 选择应用、填名称、配置调度与入口。

### 方式 B：API 建任务（AI agent 用这个）

```bash
curl -X POST http://<HOST>:3105/api/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "每日跑批",
    "triggerType": "cron",
    "cronExpression": "0 9 * * *",
    "timezone": "Asia/Shanghai",
    "runtime": "python",
    "runtimeVersion": "3.12",
    "codeSource": "application_zip",
    "applicationId": "<APP_UUID>",
    "entrypoint": "main.py",
    "timeoutSeconds": 600,
    "maxRetry": 2,
    "requirements": ["requests>=2.31"],
    "params": {"target": "prod"},
    "alarmEmail": "ops@example.com",
    "alarmChannels": ["email"]
  }'
```

### 真实 DTO 字段（`apps/admin-api/src/modules/task/dto/create-task.dto.ts`）

**代码来源三选一互斥**：`gitRepo` / `glueSource` / `codeSource='application_zip'` + `applicationId`。

| 字段 | 类型 / 约束 | 说明 |
|------|-------------|------|
| `name` | string，必填 | 任务名 |
| `triggerType` | enum，**必填** | `manual \| cron \| fixed_rate \| api`（**没有** `scheduleType`） |
| `cronExpression` | string | `triggerType=cron` 时使用；**严格 5 段**，见下节 |
| `timezone` | string | IANA 时区，如 `Asia/Shanghai` |
| `runtime` | enum | `python \| node` |
| `runtimeVersion` | string，可选 | `主.次`（`^\d+\.\d+$`），如 `3.12` |
| `codeSource` | enum，可选 | `application_zip` 等；与 `applicationId` 搭配 |
| `applicationId` | string | 引用上传的应用包 |
| `entrypoint` | string | **入口脚本路径**（没有 `taskEntry`）；缺省读包内 manifest 的 `entrypoint` |
| `requirements` | string[]，≤50 | 依赖规格；**禁止** `-` 开头的 option 行 |
| `params` | object | 默认参数；**序列化后 ≤ 65536 字节** |
| `secrets` | object | 凭据键值对，落库加密、读取脱敏（`******`），执行时按**原名**注入 |
| `timeout` / `timeoutSeconds` | int | 秒，`0` = 不限时，**最大 86400** |
| `maxRetry` | int | `0..10` |
| `id` | string，可选 | 若提供**必须是 UUID v4** |
| `alarmEmail` | string（email） | 告警邮箱（**没有** `notificationConfig`） |
| `alarmChannels` | string[] | 告警渠道（**没有** `notificationConfig`） |
| `dependencies` | object | `{displayName: upstreamTaskId}`——**value 才是上游任务 id** |
| `runbook` | string | markdown 排障手册，展示在任务详情页 |
| `priority` | enum | 任务优先级 |
| `projectId` | string，可选 | 所属项目 |
| `executeMode` | enum | `single`（默认）/ `broadcast` |
| `executorId` | UUID，可选 | 钉到指定执行器（与 `broadcast` 互斥） |

### Python 版本声明（`runtimeVersion`）

- 声明区间 **3.7 ~ 3.14**，格式必须是 `主.次`（`^\d+\.\d+$`，如 `3.12`），否则 400。
- **在线可下载 = 3.8 ~ 3.14**（主路径）；**`3.7` 仅「离线预填解释器缓存卷」**，
  声明 3.7 但池中无 3.7 → 失败分因 `interpreter_unavailable`。
- 无特殊需求**优先选 `3.12`**。
- **版本声明在任务上**，**不写进 manifest.yaml**；不声明 = 走宿主默认解释器。

---

## Cron 规则：严格 5 段、纯数字

`cronExpression` 必须是**恰好 5 个字段**：`min hour day month weekday`。

- **6 段（带秒）一律 400 拒绝**。
- **只接受数字**：`sun` / `jan` 这类名字被拒绝。

✅ **可用示例**

| 表达式 | 含义 |
|--------|------|
| `0 9 * * *` | 每天 09:00 |
| `0 9 * * 1-5` | 工作日 09:00 |
| `*/30 * * * *` | 每 30 分钟 |
| `0 12,18 * * *` | 每天 12:00 与 18:00 |
| `0 9-17 * * *` | 每天 09:00–17:00 每小时整点 |

❌ **失败示例**

| 表达式 | 失败原因 |
|--------|----------|
| `0 0 9 * * *` | **6 段**（带秒）→ 400 |
| `0 */30 * * * *` | **6 段**（带秒）→ 400 |
| `0 9 * * sun` | 星期名 → 400（只认数字） |
| `0 9 * jan *` | 月份名 → 400（只认数字） |

---

## 常见错误字段名对照（必读）

旧文档最致命的失败就是**发明字段名**。全局 `forbidNonWhitelisted` 会让这些请求**直接 400**：

| ❌ 错误（会 400） | ✅ 正确 | 说明 |
|------------------|---------|------|
| `scheduleType` | **`triggerType`** | 枚举 `manual \| cron \| fixed_rate \| api` |
| `taskEntry` | **`entrypoint`** | 入口脚本路径 |
| `executorPackageName` | **`applicationId` + `codeSource: "application_zip"`** | 业务包是应用 zip |
| `notificationConfig` | **`alarmEmail` / `alarmChannels`** | 告警字段是这两个 |
| `access_token`（登录响应） | **`accessToken`** | 驼峰 |
| manifest 里的 `name` / `version` / `description` | 上传表单的 `name` / 应用记录自动递增的版本 | manifest 只读 4 个字段 |
| manifest 里的 `tasks[]` | 单入口用 `entrypoint` | `tasks[]` 只在 **git 仓库部署**读根目录 `manifest.json` |
| manifest 里声明 Python 版本 | 任务上的 **`runtimeVersion`** | 版本声明在任务侧 |
| requirements.txt 里的 `--index-url` | 执行器侧 `PYPI_REGISTRY_URL` | option 行被拒 |

> **记忆法**：请求体里**只允许出现**上表「真实 DTO 字段」一节的字段名。拿不准就去看 DTO 文件。

---

## Step 8 · 版本迭代（发新版）

`Application` 带 `version` 列，平台按应用维度保留版本历史/快照（`ApplicationVersion`）。
**版本号由上传自动递增，不写在 manifest.yaml 里。**

1. 改代码 / 依赖。
2. 重新打包：`zip -r ../my-app.zip manifest.yaml main.py requirements.txt`。
3. 以**同一 `name`** 重新上传（`POST /api/applications/upload`）→ 平台按 name upsert、**版本递增**。
4. 让任务指向新版本：更新任务的 `applicationId` 指向新记录。

```bash
# 旧执行器包如需废弃（仅 executor-packages 渠道有此端点；applications 渠道以版本历史管理）
curl -X PATCH http://<HOST>:3105/api/executor-packages/<OLD_PKG_ID>/deprecate \
  -H "Authorization: Bearer $TOKEN"
```

**迭代纪律**：`entrypoint` 尽量向后兼容，改了要同步任务配置；`secrets` / 接口如有 schema 变更，
优先「新增可缺省字段」而非破坏性改动，并在 CHANGELOG 记录。

---

## Step 9 · 验证

```bash
# 手动触发任务
curl -X POST http://<HOST>:3105/api/tasks/<TASK_ID>/trigger \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"params":{"target":"test"}}'

# 查执行结果
curl "http://<HOST>:3105/api/executions?taskId=<TASK_ID>" \
  -H "Authorization: Bearer $TOKEN"
```

### 排查清单

| 现象 | 原因 |
|------|------|
| 建任务 400，文案提到 `property X should not exist` | 请求体里有**未声明的字段名** → 查「常见错误字段名对照」 |
| 建任务 400，文案提到 cron | 用了 **6 段**或**字母名** → 改严格 5 段纯数字 |
| 任务显示 **SUCCESS** 但业务其实失败了 | 脚本用 `return {"success": False}` → **必须抛异常** |
| 参数读到 `None`，静默用了默认值 | **参数键名陷阱**：camelCase 参数只能按小写键取 |
| 执行详情页看不到产出的文件 | 文件没写进 **`AUTOFLOW_ARTIFACTS_DIR`** |
| 失败分因 `interpreter_unavailable` | 声明的 `runtimeVersion` 在池中不可得（如 3.7 未离线预填） |
| 失败分因 `dependency_install_failed` | 依赖规格问题（option 行 / 不可解析 / 私服不可达） |
| 失败分因 `script_error` | 脚本自身报错 |
