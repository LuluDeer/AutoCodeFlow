/**
 * 浏览器自动化示例任务 (Node.js版本)
 * 功能：打开网页，执行搜索，截图保存
 * 依赖：npm install puppeteer
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs').promises;

// 从环境变量获取上下文（在实际执行时由执行器注入）
const executionId = process.env.EXECUTION_ID || 'local-test';
const taskId = process.env.TASK_ID || 'browser-auto-demo';
const taskName = process.env.TASK_NAME || '浏览器自动化演示';

// 简单的日志记录器
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  warning: (msg) => console.warn(`[WARNING] ${msg}`)
};

// 从环境变量或默认值获取参数
const getParam = (key, defaultValue) => {
  const envKey = `AUTOFLOW_${key.toUpperCase()}`;
  return process.env[envKey] !== undefined ? JSON.parse(process.env[envKey]) : defaultValue;
};

async function main() {
  logger.info(`开始浏览器自动化任务 (执行ID: ${executionId})`);
  
  // 获取任务参数
  const url = getParam('url', 'https://www.baidu.com');
  const searchKeyword = getParam('keyword', 'AutoCodeFlow');
  const headless = getParam('headless', false);
  
  logger.info(`目标URL: ${url}`);
  logger.info(`搜索关键词: ${searchKeyword}`);
  logger.info(`无头模式: ${headless}`);
  
  // 创建输出目录
  const outputDir = path.join('/tmp', `browser_automation_${executionId}`);
  await fs.mkdir(outputDir, { recursive: true });
  
  let browser;
  try {
    // 启动浏览器
    browser = await puppeteer.launch({
      headless: headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1920,1080'
      ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    logger.info('浏览器启动成功');
    
    // 打开网页
    await page.goto(url, { waitUntil: 'networkidle2' });
    logger.info(`已打开: ${url}`);
    
    // 截图 - 初始页面
    const initialScreenshot = path.join(outputDir, '01_initial_page.png');
    await page.screenshot({ path: initialScreenshot, fullPage: true });
    logger.info(`已保存初始截图: ${initialScreenshot}`);
    
    // 执行搜索
    await page.type('#kw', searchKeyword);
    await page.click('#su');
    
    logger.info(`已执行搜索: ${searchKeyword}`);
    
    // 等待搜索结果加载
    await page.waitForSelector('.result', { timeout: 10000 });
    await page.waitForTimeout(2000);
    
    // 截图 - 搜索结果
    const resultsScreenshot = path.join(outputDir, '02_search_results.png');
    await page.screenshot({ path: resultsScreenshot, fullPage: true });
    logger.info(`已保存搜索结果截图: ${resultsScreenshot}`);
    
    // 获取搜索结果
    const searchResults = await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('.result h3 a');
      items.forEach((item, index) => {
        results.push({
          index: index + 1,
          text: item.textContent,
          href: item.href
        });
      });
      return results;
    });
    
    logger.info(`找到 ${searchResults.length} 个搜索结果`);
    
    // 保存搜索结果到文件
    const resultsFile = path.join(outputDir, 'search_results.txt');
    let resultsText = `搜索结果 - ${new Date().toLocaleString('zh-CN')}\n`;
    resultsText += `关键词: ${searchKeyword}\n`;
    resultsText += `${'='.repeat(50)}\n\n`;
    
    searchResults.slice(0, 10).forEach(result => {
      resultsText += `${result.index}. ${result.text}\n`;
      resultsText += `   链接: ${result.href}\n\n`;
    });
    
    await fs.writeFile(resultsFile, resultsText, 'utf-8');
    logger.info(`搜索结果已保存到: ${resultsFile}`);
    
    // 点击第一个结果
    if (searchResults.length > 0) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('.result h3 a')
      ]);
      
      logger.info('已点击第一个搜索结果');
      await page.waitForTimeout(3000);
      
      // 截图 - 目标页面
      const targetScreenshot = path.join(outputDir, '03_target_page.png');
      await page.screenshot({ path: targetScreenshot, fullPage: true });
      logger.info(`已保存目标页面截图: ${targetScreenshot}`);
    }
    
    // 关闭浏览器
    await browser.close();
    logger.info('浏览器已关闭');
    
    // 返回结果
    const result = {
      success: true,
      message: '浏览器自动化任务完成',
      executionId,
      outputDir,
      screenshots: [
        initialScreenshot,
        resultsScreenshot,
        path.join(outputDir, '03_target_page.png')
      ].filter(Boolean),
      resultsFile,
      searchResultsCount: searchResults.length,
      timestamp: new Date().toISOString()
    };
    
    console.log(`RESULT: ${JSON.stringify(result, null, 2)}`);
    return result;
    
  } catch (error) {
    logger.error(`任务执行失败: ${error.message}`);
    
    if (browser) {
      await browser.close();
    }
    
    const errorResult = {
      success: false,
      error: error.message,
      executionId,
      outputDir,
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