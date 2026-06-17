#!/bin/bash

# 桌面自动化依赖安装脚本
# 用于安装 Python 和 Node.js 执行器所需的桌面自动化依赖

set -e

echo "========================================="
echo "桌面自动化依赖安装脚本"
echo "========================================="

# 检测操作系统
OS="$(uname -s)"
case "${OS}" in
    Linux*)     MACHINE=Linux;;
    Darwin*)    MACHINE=Mac;;
    CYGWIN*)    MACHINE=Cygwin;;
    MINGW*)     MACHINE=MinGw;;
    MSYS_NT*)   MACHINE=Git;;
    *)          MACHINE="UNKNOWN:${OS}"
esac

echo "检测到操作系统: ${MACHINE}"

# Python 依赖安装
echo ""
echo "========================================="
echo "安装 Python 依赖"
echo "========================================="

if command -v python3 &> /dev/null; then
    PYTHON_CMD=python3
elif command -v python &> /dev/null; then
    PYTHON_CMD=python
else
    echo "错误: 未找到 Python，请先安装 Python 3.10+"
    exit 1
fi

echo "使用 Python: $($PYTHON_CMD --version)"

# 基础依赖
echo "安装基础依赖..."
$PYTHON_CMD -m pip install --upgrade pip
$PYTHON_CMD -m pip install autoflow-sdk psutil

# 浏览器自动化依赖
echo ""
echo "安装浏览器自动化依赖..."
read -p "是否安装浏览器自动化依赖 (Selenium/Playwright)? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "安装 Selenium..."
    $PYTHON_CMD -m pip install selenium
    
    echo "安装 Playwright (推荐)..."
    $PYTHON_CMD -m pip install playwright
    $PYTHON_CMD -m playwright install
    
    echo "浏览器驱动安装完成"
fi

# 桌面GUI自动化依赖
echo ""
echo "安装桌面GUI自动化依赖..."
read -p "是否安装桌面GUI自动化依赖 (PyAutoGUI)? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "安装 PyAutoGUI 和相关依赖..."
    $PYTHON_CMD -m pip install pyautogui opencv-python pillow
    
    # Linux 特定依赖
    if [ "${MACHINE}" = "Linux" ]; then
        echo "安装 Linux 特定依赖..."
        sudo apt-get update
        sudo apt-get install -y python3-tk python3-dev scrot
    fi
    
    echo "桌面GUI自动化依赖安装完成"
fi

# Node.js 依赖安装
echo ""
echo "========================================="
echo "安装 Node.js 依赖"
echo "========================================="

if command -v npm &> /dev/null; then
    echo "使用 npm: $(npm --version)"
    
    # 进入 Node.js 执行器目录
    EXECUTOR_NODE_DIR="../../../apps/executor-node"
    if [ -d "$EXECUTOR_NODE_DIR" ]; then
        echo "进入 Node.js 执行器目录: $EXECUTOR_NODE_DIR"
        cd "$EXECUTOR_NODE_DIR"
        
        # 浏览器自动化依赖
        echo ""
        read -p "是否安装 Node.js 浏览器自动化依赖 (Puppeteer)? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "安装 Puppeteer..."
            npm install puppeteer
            echo "Puppeteer 安装完成"
        fi
        
        # 桌面GUI自动化依赖
        echo ""
        read -p "是否安装 Node.js 桌面GUI自动化依赖 (robotjs)? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "安装 robotjs 和 canvas..."
            npm install robotjs canvas
            echo "robotjs 和 canvas 安装完成"
        fi
        
        cd - > /dev/null
    else
        echo "警告: 未找到 Node.js 执行器目录 ($EXECUTOR_NODE_DIR)"
        echo "跳过 Node.js 依赖安装"
    fi
else
    echo "警告: 未找到 npm，跳过 Node.js 依赖安装"
fi

# 系统特定配置
echo ""
echo "========================================="
echo "系统特定配置"
echo "========================================="

if [ "${MACHINE}" = "Mac" ]; then
    echo "macOS 特定配置:"
    echo "1. 如果需要桌面自动化，请在系统偏好设置 > 安全性与隐私 > 辅助功能中添加终端权限"
    echo "2. 如果需要文件系统访问，请在隐私 > 文件和文件夹中添加终端权限"
    
elif [ "${MACHINE}" = "Linux" ]; then
    echo "Linux 特定配置:"
    echo "1. 如果需要截图功能，已安装 scrot 工具"
    echo "2. 如果需要通知功能，已安装 libnotify-bin"
    echo "3. 如果使用 X11，确保 DISPLAY 环境变量正确设置"
    
elif [[ "${MACHINE}" == *"MINGW"* ]] || [[ "${MACHINE}" == *"Git"* ]]; then
    echo "Windows 特定配置:"
    echo "1. 某些功能可能需要管理员权限"
    echo "2. 建议使用 Windows Terminal 或 PowerShell"
    echo "3. 如果遇到权限问题，请以管理员身份运行终端"
fi

# 测试安装
echo ""
echo "========================================="
echo "测试安装"
echo "========================================="

echo "测试 Python 导入..."
$PYTHON_CMD -c "import psutil; print('✓ psutil 安装成功')" || echo "✗ psutil 导入失败"

if $PYTHON_CMD -c "import selenium" 2>/dev/null; then
    echo "✓ selenium 安装成功"
else
    echo "○ selenium 未安装"
fi

if $PYTHON_CMD -c "import playwright" 2>/dev/null; then
    echo "✓ playwright 安装成功"
else
    echo "○ playwright 未安装"
fi

if $PYTHON_CMD -c "import pyautogui" 2>/dev/null; then
    echo "✓ pyautogui 安装成功"
else
    echo "○ pyautogui 未安装"
fi

echo ""
echo "========================================="
echo "安装完成！"
echo "========================================="
echo ""
echo "下一步:"
echo "1. 查看 README.md 了解如何使用示例任务"
echo "2. 在 AutoCodeFlow 管理界面中创建任务"
echo "3. 或直接运行示例任务进行测试"
echo ""
echo "测试命令示例:"
echo "  # Python 浏览器自动化"
echo "  python browser_automation.py"
echo ""
echo "  # Python 桌面GUI自动化"
echo "  python desktop_gui_automation.py"
echo ""
echo "  # Node.js 浏览器自动化"
echo "  node browser_automation.js"
echo ""
echo "  # Node.js 桌面GUI自动化"
echo "  node desktop_gui_automation.js"
echo ""