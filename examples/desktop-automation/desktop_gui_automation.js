/**
 * 桌面GUI自动化示例任务 (Node.js版本)
 * 功能：鼠标键盘操作、屏幕截图
 * 依赖：npm install robotjs @nut-tree/nut-js
 */

const robot = require('robotjs');
const path = require('path');
const fs = require('fs').promises;
const { createCanvas, loadImage } = require('canvas');

// 从环境变量获取上下文
const executionId = process.env.EXECUTION_ID || 'local-test';
const taskId = process.env.TASK_ID || 'desktop-gui-demo';
const taskName = process.env.TASK_NAME || '桌面GUI自动化演示';

// 简单的日志记录器
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  warning: (msg) => console.warn(`[WARNING] ${msg}`)
};

// 从环境变量或默认值获取参数
const getParam = (key, defaultValue) => {
  const envKey = `AUTOFLOW_${key.toUpperCase()}`;
  const envValue = process.env[envKey];
  if (envValue !== undefined) {
    try {
      return JSON.parse(envValue);
    } catch (e) {
      return envValue;
    }
  }
  return defaultValue;
};

async function takeScreenshot(outputPath) {
  try {
    // 使用 robotjs 进行屏幕截图
    const screenSize = robot.getScreenSize();
    const width = screenSize.width;
    const height = screenSize.height;
    
    // 获取屏幕像素数据
    const img = robot.screen.capture();
    
    // 创建 Canvas 并绘制图像
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // 将图像数据绘制到 Canvas
    const imageData = ctx.createImageData(width, height);
    for (let i = 0; i < img.data.length; i++) {
      imageData.data[i] = img.data[i];
    }
    ctx.putImageData(imageData, 0, 0);
    
    // 保存为 PNG
    const buffer = canvas.toBuffer('image/png');
    await fs.writeFile(outputPath, buffer);
    
    return outputPath;
  } catch (error) {
    logger.error(`截图失败: ${error.message}`);
    throw error;
  }
}

async function main() {
  logger.info(`开始桌面GUI自动化任务 (执行ID: ${executionId})`);
  
  // 获取任务参数
  const actions = getParam('actions', []);
  const screenshotInterval = getParam('screenshotInterval', 2);
  const outputDir = getParam('outputDir', `/tmp/desktop_automation_${executionId}`);
  
  logger.info(`动作数量: ${actions.length}`);
  
  // 创建输出目录
  const outputDirPath = path.join(outputDir);
  await fs.mkdir(outputDirPath, { recursive: true });
  
  // 设置 robotjs
  robot.setMouseDelay(100);
  robot.setKeyboardDelay(100);
  
  try {
    const screenshots = [];
    const actionResults = [];
    
    // 初始截图
    const initialScreen = path.join(outputDirPath, '00_initial_screen.png');
    await takeScreenshot(initialScreen);
    screenshots.push(initialScreen);
    logger.info(`已保存初始屏幕截图: ${initialScreen}`);
    
    // 获取屏幕尺寸
    const screenSize = robot.getScreenSize();
    logger.info(`屏幕尺寸: ${screenSize.width}x${screenSize.height}`);
    
    // 执行动作序列
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const actionType = action.type;
      
      logger.info(`执行动作 ${i + 1}/${actions.length}: ${actionType}`);
      
      const result = { action: actionType, success: true, timestamp: new Date().toISOString() };
      
      try {
        switch (actionType) {
          case 'move':
            const x = action.x || screenSize.width / 2;
            const y = action.y || screenSize.height / 2;
            robot.moveMouse(x, y);
            result.position = { x, y };
            break;
            
          case 'click':
            const clickX = action.x || screenSize.width / 2;
            const clickY = action.y || screenSize.height / 2;
            const clicks = action.clicks || 1;
            const button = action.button || 'left';
            
            for (let j = 0; j < clicks; j++) {
              robot.moveMouse(clickX, clickY);
              robot.mouseClick(button);
              await new Promise(resolve => setTimeout(resolve, 200));
            }
            
            result.position = { x: clickX, y: clickY };
            result.clicks = clicks;
            break;
            
          case 'double_click':
            const dcX = action.x || screenSize.width / 2;
            const dcY = action.y || screenSize.height / 2;
            robot.moveMouse(dcX, dcY);
            robot.mouseClick('left', true);
            result.position = { x: dcX, y: dcY };
            break;
            
          case 'right_click':
            const rcX = action.x || screenSize.width / 2;
            const rcY = action.y || screenSize.height / 2;
            robot.moveMouse(rcX, rcY);
            robot.mouseClick('right');
            result.position = { x: rcX, y: rcY };
            break;
            
          case 'drag':
            const startX = action.startX || screenSize.width / 2;
            const startY = action.startY || screenSize.height / 2;
            const endX = action.endX || startX + 100;
            const endY = action.endY || startY;
            
            robot.moveMouse(startX, startY);
            robot.mouseToggle('down', 'left');
            robot.moveMouse(endX, endY);
            robot.mouseToggle('up', 'left');
            
            result.from = { x: startX, y: startY };
            result.to = { x: endX, y: endY };
            break;
            
          case 'type':
            const text = action.text || '';
            const interval = action.interval || 10;
            robot.typeString(text, interval);
            result.textLength = text.length;
            break;
            
          case 'hotkey':
            const keys = action.keys || [];
            robot.keyTap(keys[keys.length - 1], keys.slice(0, -1));
            result.keys = keys;
            break;
            
          case 'press':
            const key = action.key || 'enter';
            const presses = action.presses || 1;
            for (let j = 0; j < presses; j++) {
              robot.keyTap(key);
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            result.key = key;
            result.presses = presses;
            break;
            
          case 'scroll':
            const scrollClicks = action.clicks !== undefined ? action.clicks : -10;
            const scrollX = action.x || screenSize.width / 2;
            const scrollY = action.y || screenSize.height / 2;
            robot.scrollMouse(scrollClicks);
            result.scrollClicks = scrollClicks;
            break;
            
          case 'screenshot':
            const screenshotPath = path.join(outputDirPath, `screenshot_${i + 1}.png`);
            await takeScreenshot(screenshotPath);
            screenshots.push(screenshotPath);
            result.path = screenshotPath;
            break;
            
          default:
            result.success = false;
            result.error = `未知动作类型: ${actionType}`;
        }
        
        // 动作后截图（除了专门的截图动作）
        if (actionType !== 'screenshot') {
          await new Promise(resolve => setTimeout(resolve, 500));
          const actionScreenshot = path.join(outputDirPath, `action_${i + 1}.png`);
          await takeScreenshot(actionScreenshot);
          screenshots.push(actionScreenshot);
        }
        
      } catch (error) {
        result.success = false;
        result.error = error.message;
        logger.error(`动作执行失败: ${error.message}`);
      }
      
      actionResults.push(result);
      await new Promise(resolve => setTimeout(resolve, screenshotInterval * 1000));
    }
    
    // 最终截图
    const finalScreen = path.join(outputDirPath, '99_final_screen.png');
    await takeScreenshot(finalScreen);
    screenshots.push(finalScreen);
    logger.info(`已保存最终屏幕截图: ${finalScreen}`);
    
    // 生成动作报告
    const reportFile = path.join(outputDirPath, 'automation_report.txt');
    let reportText = '桌面GUI自动化任务报告\n';
    reportText += '='.repeat(50) + '\n\n';
    reportText += `执行ID: ${executionId}\n`;
    reportText += `屏幕尺寸: ${screenSize.width}x${screenSize.height}\n`;
    reportText += `动作总数: ${actions.length}\n`;
    reportText += `截图数量: ${screenshots.length}\n\n`;
    
    reportText += '动作执行详情:\n';
    reportText += '-'.repeat(50) + '\n';
    actionResults.forEach((result, index) => {
      const status = result.success ? '✓' : '✗';
      reportText += `${index + 1}. [${status}] ${result.action}\n`;
      if (!result.success) {
        reportText += `   错误: ${result.error || 'Unknown'}\n`;
      }
    });
    
    reportText += '\n截图文件:\n';
    reportText += '-'.repeat(50) + '\n';
    screenshots.forEach(screenshot => {
      reportText += `- ${screenshot}\n`;
    });
    
    await fs.writeFile(reportFile, reportText, 'utf-8');
    logger.info(`动作报告已保存: ${reportFile}`);
    
    // 返回结果
    const result = {
      success: true,
      message: '桌面GUI自动化任务完成',
      executionId,
      outputDir: outputDirPath,
      screenshots,
      actionResults,
      reportFile,
      totalActions: actions.length,
      successfulActions: actionResults.filter(r => r.success).length,
      timestamp: new Date().toISOString()
    };
    
    console.log(`RESULT: ${JSON.stringify(result, null, 2)}`);
    return result;
    
  } catch (error) {
    logger.error(`任务执行失败: ${error.message}`);
    
    const errorResult = {
      success: false,
      error: error.message,
      executionId,
      outputDir: outputDirPath,
      timestamp: new Date().toISOString()
    };
    
    console.log(`RESULT: ${JSON.stringify(errorResult, null, 2)}`);
    return errorResult;
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main };