# 桌面自动化示例任务集合

这个目录包含了使用 AutoCodeFlow 实现桌面自动化的示例任务，类似于影刀（RPA）的功能。

> **关于失败语义（重要）**：执行器以**进程退出码**判定成败，不解析脚本返回的
> dict。示例统一采用「成功 = 正常返回；失败 = **抛异常**」，绝不 `return
> {"success": False}` —— 那样任务会以退出码 0 结束，在平台上显示为**成功**。

> **关于截图**：截图与报告写入执行器注入的 `AUTOFLOW_ARTIFACTS_DIR`
> （FEAT-05 产物通道），任务结束时由执行器上传、随终态回调上报清单，用户可在
> **执行详情页**查看/下载。写到 `/tmp` 或只把路径塞进返回值，UI 里都看不到。

## 📋 目录

- [功能特性](#功能特性)
- [环境准备](#环境准备)
- [示例任务说明](#示例任务说明)
- [快速开始](#快速开始)
- [任务配置示例](#任务配置示例)
- [平台兼容性](#平台兼容性)
- [常见问题](#常见问题)

## ✨ 功能特性

### 1. 浏览器自动化 (`browser_automation.py` / `.js`)
- 自动打开网页
- 执行搜索操作
- 页面截图保存为**执行产物**
- 搜索结果提取
- 支持无头模式

### 2. 桌面GUI自动化 (`desktop_gui_automation.py` / `.js`)
- 鼠标操作（移动、点击、拖拽）
- 键盘操作（输入、快捷键）
- 屏幕截图
- 图像识别点击
- 滚动操作

### 3. 文件系统自动化 (`file_system_automation.py`)
- 批量文件操作（复制、移动、删除）
- 文件重命名
- 目录创建和管理
- 文件压缩
- 目录同步
- 文件分析统计

### 4. 系统集成自动化 (`system_integration_automation.py`)
- 应用程序启动/停止
- 进程管理
- 系统监控
- 命令执行
- 端口检查
- 系统通知
- 截图功能

## 🔧 环境准备

### 基础依赖

```bash
# Python 执行器基础依赖（TaskContext / 日志 / 回调能力探测）
pip install autoflow-sdk

# 通用依赖
pip install psutil
```

### 浏览器自动化依赖

```bash
# Python：Selenium 方式
pip install selenium
# 需要下载对应浏览器的 WebDriver

# Node：Puppeteer 方式
npm install puppeteer
```

### 桌面GUI自动化依赖

```bash
# Python：PyAutoGUI 方式
pip install pyautogui pillow opencv-python

# Linux 额外依赖
sudo apt-get install python3-tk python3-dev

# Node：robotjs + canvas
npm install robotjs canvas
```

### 系统集成依赖

```bash
# 基础依赖已包含在 psutil 中

# macOS 通知功能（系统自带）
# Windows 通知功能
pip install pywin32 win10toast

# Linux 通知功能
sudo apt-get install libnotify-bin
```

## 📖 示例任务说明

### 1. 浏览器自动化任务

**功能**：自动打开百度，搜索关键词，截图保存结果

**参数配置**（参数名请用小写，见 [常见问题](#q-为什么我传的参数不生效)）：
```json
{
  "url": "https://www.baidu.com",
  "keyword": "AutoCodeFlow",
  "headless": false
}
```

**输出结果**（全部作为执行产物出现在执行详情页）：
- `01_initial_page.png` 初始页面截图
- `02_search_results.png` 搜索结果截图
- `03_target_page.png` 目标页面截图（有搜索结果时）
- `search_results.txt` 搜索结果文本文件

### 2. 桌面GUI自动化任务

**功能**：执行一系列鼠标键盘操作

**参数配置**：
```json
{
  "actions": [
    {
      "type": "move",
      "x": 500,
      "y": 300,
      "duration": 0.5
    },
    {
      "type": "click",
      "x": 500,
      "y": 300,
      "clicks": 1
    },
    {
      "type": "type",
      "text": "Hello AutoCodeFlow",
      "interval": 0.1
    },
    {
      "type": "screenshot"
    }
  ],
  "screenshotinterval": 1
}
```

**支持的动作类型**：
- `move` - 移动鼠标
- `click` - 点击
- `double_click` - 双击
- `right_click` - 右键点击
- `drag` - 拖拽
- `type` - 输入文本
- `hotkey` - 快捷键
- `press` - 按键
- `scroll` - 滚动
- `screenshot` - 截图
- `find_and_click` - 图像识别点击

> 截图数量受产物通道上限约束（**最多 20 个文件**），示例会在预算内落盘，
> 超出的动作不再逐个截图。

### 3. 文件系统自动化任务

**功能**：批量文件操作和管理

**参数配置**：
```json
{
  "sourcedir": "/tmp/source",
  "targetdir": "/tmp/target",
  "createtestfiles": true,
  "operations": [
    {
      "type": "list_files",
      "pattern": "*",
      "recursive": true
    },
    {
      "type": "copy_files",
      "pattern": "*.txt",
      "preserveStructure": false
    },
    {
      "type": "rename_files",
      "pattern": "*.txt",
      "prefix": "backup_",
      "suffix": "_v1"
    },
    {
      "type": "compress_files",
      "pattern": "*",
      "archiveName": "backup.zip",
      "format": "zip"
    }
  ]
}
```

> 注意：**顶层参数名**是小写的（`sourcedir` / `targetdir` / `createtestfiles`），
> 而 `operations` 数组**内部**的对象键保持 camelCase（`preserveStructure`）——
> 数组是整体 JSON 序列化后传递的，不经过环境变量键名转换。

**支持的操作类型**：
- `list_files` - 列出文件
- `copy_files` - 复制文件
- `move_files` - 移动文件
- `delete_files` - 删除文件
- `rename_files` - 重命名文件
- `create_directories` - 创建目录
- `compress_files` - 压缩文件
- `analyze_directory` - 分析目录
- `sync_directories` - 同步目录

### 4. 系统集成自动化任务

**功能**：应用程序管理和系统监控

**参数配置**：
```json
{
  "outputdir": "/tmp/system_automation",
  "operations": [
    {
      "type": "monitor_system",
      "duration": 10,
      "interval": 2
    },
    {
      "type": "start_application",
      "appPath": "/usr/bin/vscode",
      "args": ["."],
      "wait": false
    },
    {
      "type": "list_processes",
      "nameFilter": "code",
      "limit": 10
    },
    {
      "type": "send_notification",
      "title": "自动化任务",
      "message": "任务执行完成"
    }
  ]
}
```

**支持的操作类型**：
- `start_application` - 启动应用程序
- `stop_application` - 停止应用程序
- `list_processes` - 列出进程
- `monitor_system` - 系统监控
- `execute_command` - 执行命令
- `kill_zombie_processes` - 清理僵尸进程
- `check_port` - 检查端口
- `take_screenshot` - 系统截图
- `send_notification` - 发送通知

## 🚀 快速开始

### 方式一：通过管理界面创建任务

1. 启动 AutoCodeFlow 系统
2. 登录管理界面
3. 创建新任务，runtime 选 `python`（或 `node`）
4. 把示例代码作为 **glue 脚本**粘贴，或按[方式三](#方式三打包-zip-上传推荐)打成 zip 包上传
5. 配置任务参数与调度
6. 保存并执行任务

### 方式二：通过 API 创建任务

```bash
# 1) 登录（响应字段是 accessToken，驼峰）
TOKEN=$(curl -s -X POST http://<HOST>:3105/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<PASSWORD>"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")

# 2) 建任务（triggerType 必填；cron 必须 5 段）
curl -X POST http://<HOST>:3105/api/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "浏览器自动化演示",
    "triggerType": "cron",
    "cronExpression": "0 9 * * *",
    "runtime": "python",
    "runtimeVersion": "3.12",
    "codeSource": "application_zip",
    "applicationId": "<APP_UUID>",
    "entrypoint": "main.py",
    "timeout": 300,
    "maxRetry": 2,
    "params": {
      "url": "https://www.baidu.com",
      "keyword": "AutoCodeFlow",
      "headless": false
    },
    "requirements": ["selenium", "autoflow-sdk"]
  }'
```

### 方式三：打包 zip 上传（推荐）

任务包 = 一个 zip，`manifest.yaml` 必须在**包根**，且只写
`runtime` / `entrypoint` / `timeout` / `requirements` 四个字段：

```bash
cd my-app/
zip -r ../my-app-1.0.0.zip manifest.yaml main.py requirements.txt

# 上传（业务包走 applications/upload）
curl -X POST http://<HOST>:3105/api/applications/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "name=my-app" -F "runtime=python" \
  -F "file=@my-app-1.0.0.zip"
```

> 完整规范见 [`.qoder/skills/acf-python-task-package/SKILL.md`](../../.qoder/skills/acf-python-task-package/SKILL.md)
> 与 [`docs/autoapp-skill.md`](../../docs/autoapp-skill.md)。

### 方式四：本地测试

```bash
# 设置环境变量（模拟执行器环境）
export EXECUTION_ID="test-exec-001"
export TASK_ID="browser-auto-demo"
export TASK_NAME="浏览器自动化演示"

# 运行任务
python browser_automation.py
```

## 📋 任务配置示例

### 定时浏览器监控任务

```json
{
  "name": "每日网站监控",
  "triggerType": "cron",
  "cronExpression": "0 9 * * *",
  "runtime": "python",
  "runtimeVersion": "3.12",
  "codeSource": "application_zip",
  "applicationId": "<APP_UUID>",
  "entrypoint": "main.py",
  "timeout": 600,
  "maxRetry": 3,
  "params": {
    "url": "https://your-website.com",
    "keyword": "重要信息",
    "headless": true
  },
  "requirements": ["selenium", "autoflow-sdk"],
  "alarmEmail": "ops@example.com",
  "alarmChannels": ["email"]
}
```

> 告警字段是 `alarmEmail` / `alarmChannels`。**没有** `notificationConfig`
> 字段——请求体带未知字段会被 400 拒绝（全局 ValidationPipe 开了
> `forbidNonWhitelisted`）。

### 批量文件处理任务

```json
{
  "name": "每日文件备份",
  "triggerType": "cron",
  "cronExpression": "0 18 * * *",
  "runtime": "python",
  "codeSource": "application_zip",
  "applicationId": "<APP_UUID>",
  "entrypoint": "main.py",
  "timeout": 1800,
  "params": {
    "sourcedir": "/home/user/documents",
    "targetdir": "/backup/daily",
    "createtestfiles": false,
    "operations": [
      {
        "type": "copy_files",
        "pattern": "*",
        "preserveStructure": true
      },
      {
        "type": "compress_files",
        "pattern": "*",
        "archiveName": "backup.zip",
        "format": "zip"
      }
    ]
  },
  "requirements": ["autoflow-sdk"]
}
```

### 系统监控任务

```json
{
  "name": "系统健康检查",
  "triggerType": "cron",
  "cronExpression": "*/30 * * * *",
  "runtime": "python",
  "codeSource": "application_zip",
  "applicationId": "<APP_UUID>",
  "entrypoint": "main.py",
  "timeout": 300,
  "params": {
    "operations": [
      {
        "type": "monitor_system",
        "duration": 60,
        "interval": 5
      },
      {
        "type": "list_processes",
        "limit": 20
      }
    ]
  },
  "requirements": ["psutil", "autoflow-sdk"],
  "alarmEmail": "ops@example.com",
  "alarmChannels": ["email"]
}
```

## 🌐 平台兼容性

### Windows
- ✅ 完全支持
- 需要管理员权限进行某些操作
- 推荐使用 Selenium WebDriver
- 输出目录走系统临时目录（`tempfile.gettempdir()` / `os.tmpdir()`），不再硬编码 `/tmp`

### macOS
- ✅ 完全支持
- 需要授予辅助功能权限
- 系统通知功能原生支持

### Linux
- ✅ 完全支持
- 可能需要安装额外的系统工具
- X11/Wayland 显示服务器支持

## ❓ 常见问题

### Q: 为什么我传的参数不生效？

A: 这是**参数键名大小写**导致的静默失效，最隐蔽的一类问题：

- 执行器注入时把键名**大写**：`AUTOFLOW_{k.upper()}`
- Python SDK 读回时把键名**小写**：`params[...lower()]`

于是任务配置里写成 camelCase 的键（`sourceDir`），在 `ctx.params` 里只以小写
形态（`sourcedir`）存在，脚本按原样 `ctx.get_param("sourceDir")` 恒为 `None`，
**静默落回代码里的默认值**——不报错，只是参数被忽略。

**建议**：顶层参数名一律用**全小写**（`sourcedir` / `createtestfiles`）。示例脚本
同时做了一次小写回退查找作为兜底，但不要依赖它。

### Q: 任务失败了，为什么平台显示成功？

A: 执行器以**进程退出码**判定成败，不解析脚本返回的 dict。在 `except` 里
`return {"success": False}` 会让进程以退出码 0 结束 → 平台判为**成功**。

正确做法是**抛异常**（Python `raise` / Node `throw`），让退出码非 0。示例脚本
已统一按此实现。

### Q: 截图/报告在平台上哪里看？

A: 写进执行器注入的 `AUTOFLOW_ARTIFACTS_DIR` 目录（FEAT-05 产物通道）。任务
结束时执行器扫描该目录、上传文件，并把清单 `[{name, size, sha256}]` 随终态回调
上报，之后可在**执行详情页**查看和下载。

约束：
- 最多 **20 个**文件（超出被跳过）
- 单文件最大 **100 MB**
- 文件名须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`（字母/数字开头；不能有空格、`#`、前导 `.` 或 `_`）
- 只扫描**顶层**，不递归子目录
- 收集/上传是 best-effort，失败不影响任务终态

把文件写到 `/tmp`、或只把路径放进返回值，UI 里都**看不到**。

### Q: 如何处理浏览器驱动的兼容性问题？

A: 推荐使用 Playwright，它会自动管理浏览器驱动：
```bash
pip install playwright
playwright install
```

### Q: 桌面自动化操作不准确怎么办？

A: 可以调整以下参数：
- 增加 `pyautogui.PAUSE` 值（默认为1秒）
- 使用图像识别代替坐标定位
- 降低操作速度

### Q: 如何调试自动化任务？

A: 
1. 先使用 `headless: false` 模式观察执行过程
2. 查看执行日志与执行详情页的产物（截图）
3. 使用本地测试环境调试
4. 逐步增加操作复杂度

### Q: 任务执行失败如何处理？

A:
1. 检查依赖是否正确安装
2. 查看执行日志中的错误信息（失败分因：`dependency_install_failed` / `script_error` / `timeout` / `interpreter_unavailable`）
3. 确认系统权限是否足够
4. 使用重试机制配置

### Q: 如何提高自动化任务的稳定性？

A:
1. 添加适当的等待时间
2. 使用异常处理机制
3. 实现重试逻辑
4. 添加操作前后的状态检查
5. 保存详细的执行日志

### Q: cron 表达式怎么写？

A: 平台只接受**严格 5 段**（`分 时 日 月 周`）、**纯数字**的 cron：

| 写法 | 结果 |
|------|------|
| `0 9 * * *` | ✅ 每天 9:00 |
| `0 9 * * 1-5` | ✅ 工作日 9:00 |
| `*/30 * * * *` | ✅ 每 30 分钟 |
| `0 12,18 * * *` | ✅ 每天 12 点与 18 点 |
| `0 9-17 * * *` | ✅ 时段范围 |
| `0 0 9 * * *` | ❌ 6 段（带秒）被拒 |
| `0 */30 * * * *` | ❌ 6 段被拒 |
| `0 12 * * sun` | ❌ 星期名被拒（只认数字） |

## 📚 相关资源

- [AutoCodeFlow 官方文档](../../README.md)
- [任务包开发规范（skill）](../../.qoder/skills/acf-python-task-package/SKILL.md)
- [平台侧应用开发说明](../../docs/autoapp-skill.md)
- [Python SDK 文档](../../packages/autoflow-sdk/README.md)
- [Selenium 文档](https://selenium-python.readthedocs.io/)
- [PyAutoGUI 文档](https://pyautogui.readthedocs.io/)
- [Playwright 文档](https://playwright.dev/python/)

## 🤝 贡献

欢迎提交问题和改进建议！

## 📄 许可证

本项目采用 MIT 许可证。
