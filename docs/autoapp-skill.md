# AutoCodeFlow 自动化应用开发 Skill

> 给 AI agent 的极简规范。完整流程：写代码 → 打包 zip → 上传 → 建任务。

---

## ⚠️ 重要：这不是一个 pip 包

**不要用 `pyproject.toml` / `setup.py` / `pip build`。**
不要打 `.whl` 或 `.tar.gz`。

这是一个「任务脚本包」——一个 zip 文件，里面是平台直接执行的脚本。
平台靠根目录的 `manifest.yaml` 识别任务入口，靠 `requirements.txt` 安装依赖。

---

## 平台地址

- 管理后台：`http://<YOUR_HOST>`
- API 基础路径：`http://<YOUR_HOST>:3105/api`
- Swagger 文档：`http://<YOUR_HOST>:3105/api/docs`

---

## Step 1 · 项目结构（固定，不要改）

```
my-app/
├── manifest.yaml        ← 必须，放根目录
├── tasks/
│   └── main.py          ← 任务脚本（或 main.js）
└── requirements.txt     ← pip 依赖（Node.js 用 package.json）
```

不需要 `__init__.py`、`pyproject.toml`、`setup.py`、`Dockerfile`、`src/` 目录。

### manifest.yaml

```yaml
name: my-app          # 全局唯一，字母数字和连字符
version: "1.0.0"
runtime: python       # python 或 node
description: "应用描述"

tasks:
  - name: run                  # 任务名，后面建任务时用
    entry: tasks/main.py       # 相对路径，指向脚本文件
    timeout: 300               # 超时秒数
    params:
      - name: target
        type: string
        required: false
        default: "prod"
```

---

## Step 2 · 任务脚本

脚本只需要一个 `main()` 函数，平台调用它，返回 dict 表示成功，抛异常表示失败。

### Python（tasks/main.py）

```python
import os
import json

def main() -> dict:
    # 读取参数
    params = json.loads(os.environ.get("TASK_PARAMS", "{}"))
    target = os.environ.get("AUTOFLOW_TARGET") or params.get("target", "prod")

    print(f"running: target={target}")

    # === 你的业务逻辑写在这里 ===
    result = do_something(target)
    # ===========================

    return {"success": True, "result": result}


def do_something(target: str) -> dict:
    # 业务逻辑
    return {"target": target}


if __name__ == "__main__":
    # 本地调试用
    print(json.dumps(main()))
```

### Node.js（tasks/main.js）

```javascript
async function main() {
  const params = JSON.parse(process.env.TASK_PARAMS || '{}');
  const target = process.env.AUTOFLOW_TARGET || params.target || 'prod';

  console.log(`running: target=${target}`);

  // === 你的业务逻辑写在这里 ===
  const result = await doSomething(target);
  // ===========================

  return { success: true, result };
}

async function doSomething(target) {
  return { target };
}

module.exports = main;
```

### 平台注入的环境变量

| 变量 | 说明 |
|------|------|
| `TASK_PARAMS` | 任务配置的默认参数（JSON 字符串） |
| `AUTOFLOW_<KEY>` | 触发时传入的运行时参数，覆盖同名默认值 |
| `TASK_ID` | 任务 ID |
| `EXECUTION_ID` | 本次执行 ID |
| `TASK_TOKEN` | 回调用临时 token |
| `ADMIN_API_URL` | 平台 API 地址（容器内用） |

参数读取优先级：`AUTOFLOW_*` > `TASK_PARAMS` > 代码里的默认值

---

## Step 3 · 打包成 zip

```bash
cd my-app/

# manifest.yaml 必须在 zip 根目录（不要套一层目录）
zip -r ../my-app-1.0.0.zip manifest.yaml tasks/ requirements.txt

# 验证结构
unzip -l ../my-app-1.0.0.zip
# 应该看到：
#   manifest.yaml
#   tasks/main.py
#   requirements.txt
```

❌ 错误打包方式（会导致平台找不到 manifest）：
```bash
# 不要这样，会多一层目录
zip -r my-app-1.0.0.zip my-app/
```

---

## Step 4 · 上传

### 方式 A：管理后台手动上传

左侧菜单 → **执行器包** → **上传** → 填写名称/版本/类型 → 选择 zip 文件。

### 方式 B：API 上传（AI agent 用这个）

```bash
# 1. 登录获取 token
TOKEN=$(curl -s -X POST http://<HOST>:3105/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<PASSWORD>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. 上传 zip
curl -X POST http://<HOST>:3105/api/executor-packages \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=my-app" \
  -F "version=1.0.0" \
  -F "type=python" \
  -F "description=应用描述" \
  -F "file=@my-app-1.0.0.zip"

# 返回：{"id":"<PKG_UUID>","name":"my-app","version":"1.0.0","status":"active"}
# 记录返回的 id，后面建任务用
```

---

## Step 5 · 创建任务

### 方式 A：管理后台手动建

左侧菜单 → **任务** → **新建任务** → 选择应用、填名称、选执行器包 `my-app`、选任务入口 `run`、配置调度。

### 方式 B：API 建任务（AI agent 用这个）

```bash
curl -X POST http://<HOST>:3105/api/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "任务名称",
    "applicationId": "<APP_UUID>",
    "executorPackageName": "my-app",
    "taskEntry": "run",
    "scheduleType": "cron",
    "cronExpression": "0 9 * * *",
    "params": {"target": "prod"}
  }'
```

`scheduleType` 也可以是 `manual`（只手动触发）。

常用 Cron：`0 9 * * *` 每天9点 / `0 9 * * 1-5` 工作日9点 / `*/30 * * * *` 每30分钟

---

## Step 6 · 发版迭代

1. 修改代码
2. 更新 `manifest.yaml` 里的 `version` 字段（如 `1.0.0` → `1.1.0`）
3. 重新打包：`zip -r ../my-app-1.1.0.zip manifest.yaml tasks/ requirements.txt`
4. 上传新版本（Step 4，version 填 `1.1.0`）
5. 在管理后台将任务切换到新版本，或废弃旧包：

```bash
# 废弃旧包（可选）
curl -X PATCH http://<HOST>:3105/api/executor-packages/<OLD_PKG_ID>/deprecate \
  -H "Authorization: Bearer $TOKEN"
```

---

## 验证

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
