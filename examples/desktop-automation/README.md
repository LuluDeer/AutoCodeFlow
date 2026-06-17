# 桌面自动化示例任务集合

这个目录包含了使用 AutoCodeFlow 实现桌面自动化的示例任务，类似于影刀（RPA）的功能。

## 📋 目录

- [功能特性](#功能特性)
- [环境准备](#环境准备)
- [示例任务说明](#示例任务说明)
- [快速开始](#快速开始)
- [任务配置示例](#任务配置示例)
- [平台兼容性](#平台兼容性)
- [常见问题](#常见问题)

## ✨ 功能特性

### 1. 浏览器自动化 (`browser_automation.py`)
- 自动打开网页
- 执行搜索操作
- 页面截图保存
- 搜索结果提取
- 支持无头模式

### 2. 桌面GUI自动化 (`desktop_gui_automation.py`)
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
# Python 执行器基础依赖
pip install autoflow-sdk

# 通用依赖
pip install psutil
```

### 浏览器自动化依赖

```bash
# Selenium 方式
pip install selenium
# 需要下载对应浏览器的 WebDriver

# Playwright 方式（推荐）
pip install playwright
playwright install
```

### 桌面GUI自动化依赖

```bash
# PyAutoGUI 方式
pip install pyautogui opencv-python pillow

# Linux 额外依赖
sudo apt-get install python3-tk python3-dev
```

### 系统集成依赖

```bash
# 基础依赖已包含在 psutil 中

# macOS 通知功能（系统自带）
# Windows 通知功能
pip install pywin32

# Linux 通知功能
sudo apt-get install libnotify-bin
```

## 📖 示例任务说明

### 1. 浏览器自动化任务

**功能**：自动打开百度，搜索关键词，截图保存结果

**参数配置**：
```json
{
  "url": "https://www.baidu.com",
  "keyword": "AutoCodeFlow",
  "headless": false
}
```

**输出结果**：
- 初始页面截图
- 搜索结果截图
- 目标页面截图
- 搜索结果文本文件

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
  "screenshotInterval": 1
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

### 3. 文件系统自动化任务

**功能**：批量文件操作和管理

**参数配置**：
```json
{
  "sourceDir": "/tmp/source",
  "targetDir": "/tmp/target",
  "createTestFiles": true,
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
3. 创建新任务，选择运行时为 `python`
4. 将示例代码复制到 Glue 脚本编辑器
5. 配置任务参数
6. 保存并执行任务

### 方式二：通过 API 创建任务

```bash
curl -X POST http://localhost:3105/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "id": "browser-auto-demo",
    "name": "浏览器自动化演示",
    "runtime": "python",
    "entrypoint": "examples/desktop-automation/browser_automation.py",
    "cronExpression": "0 0 9 * * *",
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

### 方式三：本地测试

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
  "id": "daily-browser-monitor",
  "name": "每日网站监控",
  "runtime": "python",
  "entrypoint": "examples/desktop-automation/browser_automation.py",
  "cronExpression": "0 0 9 * * *",
  "timeout": 600,
  "maxRetry": 3,
  "params": {
    "url": "https://your-website.com",
    "keyword": "重要信息",
    "headless": true
  },
  "requirements": ["selenium", "autoflow-sdk"],
  "notificationConfig": {
    "onFailure": true,
    "channels": ["email", "dingtalk"]
  }
}
```

### 批量文件处理任务

```json
{
  "id": "daily-file-backup",
  "name": "每日文件备份",
  "runtime": "python",
  "entrypoint": "examples/desktop-automation/file_system_automation.py",
  "cronExpression": "0 0 18 * * *",
  "timeout": 1800,
  "params": {
    "sourceDir": "/home/user/documents",
    "targetDir": "/backup/daily",
    "createTestFiles": false,
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
  "id": "system-health-check",
  "name": "系统健康检查",
  "runtime": "python",
  "entrypoint": "examples/desktop-automation/system_integration_automation.py",
  "cronExpression": "0 */30 * * * *",
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
  "notificationConfig": {
    "onFailure": true,
    "channels": ["email"]
  }
}
```

## 🌐 平台兼容性

### Windows
- ✅ 完全支持
- 需要管理员权限进行某些操作
- 推荐使用 Selenium WebDriver

### macOS
- ✅ 完全支持
- 需要授予辅助功能权限
- 系统通知功能原生支持

### Linux
- ✅ 完全支持
- 可能需要安装额外的系统工具
- X11/Wayland 显示服务器支持

## ❓ 常见问题

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
2. 查看执行日志和截图
3. 使用本地测试环境调试
4. 逐步增加操作复杂度

### Q: 任务执行失败如何处理？

A:
1. 检查依赖是否正确安装
2. 查看执行日志中的错误信息
3. 确认系统权限是否足够
4. 使用重试机制配置

### Q: 如何提高自动化任务的稳定性？

A:
1. 添加适当的等待时间
2. 使用异常处理机制
3. 实现重试逻辑
4. 添加操作前后的状态检查
5. 保存详细的执行日志

## 📚 相关资源

- [AutoCodeFlow 官方文档](../../README.md)
- [Python SDK 文档](../../packages/autocodeflow-sdk/README.md)
- [Selenium 文档](https://selenium-python.readthedocs.io/)
- [PyAutoGUI 文档](https://pyautogui.readthedocs.io/)
- [Playwright 文档](https://playwright.dev/python/)

## 🤝 贡献

欢迎提交问题和改进建议！

## 📄 许可证

本项目采用 MIT 许可证。