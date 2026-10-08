/**
 * 浏览器自动化示例任务 (Node.js版本)
 * 功能：打开网页，执行搜索，截图保存为执行产物（artifacts）
 * 依赖：npm install puppeteer
 */

const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');
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
// Node 侧没有 Python 的键名大小写陷阱：这里自己 toUpperCase()，
// 与执行器注入的 `AUTOFLOW_${k.toUpperCase()}`（execute.ts）逐字对齐。
const getParam = (key, defaultValue) => {
  const envKey = `AUTOFLOW_${key.toUpperCase()}`;
  const envValue = process.env[envKey];
  if (envValue !== undefined) {
    try {
      return JSON.parse(envValue);
    } catch (e) {
      // 纯字符串参数（URL、关键词等）不是合法 JSON —— 原样返回，
      // 不让 SyntaxError 崩掉整个任务
      return envValue;
    }
  }
  return defaultValue;
};

// 产物目录：优先用执行器注入的 AUTOFLOW_ARTIFACTS_DIR（FEAT-05）。
// 执行器把它指向 <workDir>/artifacts/ 并已预建；任务结束时执行器扫描该目录、
// 上传文件、把清单随终态回调上报，用户即可在执行详情页查看截图/文本。
// 本地裸跑（无执行器）时回退到系统临时目录，保持可调试。
const resolveArtifactsDir = () =>
  process.env.AUTOFLOW_ARTIFACTS_DIR ||
  path.join(os.tmpdir(), `browser_automation_${executionId}`);

async function main() {
  logger.info(`开始浏览器自动化任务 (执行ID: ${executionId})`);

  // 获取任务参数
  const url = getParam('url', 'https://www.baidu.com');
  const searchKeyword = getParam('keyword', 'AutoCodeFlow');
  const headless = getParam('headless', false);

  logger.info(`目标URL: ${url}`);
  logger.info(`搜索关键词: ${searchKeyword}`);
  logger.info(`无头模式: ${headless}`);

  // 产物目录（FEAT-05）：写进这里才能在执行详情页看到
  const outputDir = resolveArtifactsDir();
  await fs.mkdir(outputDir, { recursive: true });
  logger.info(`产物目录: ${outputDir}`);

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
    await new Promise((resolve) => setTimeout(resolve, 2000));

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

    // 点击第一个结果（截图路径无条件预置，避免结果为空时引用未定义变量）
    const targetScreenshot = path.join(outputDir, '03_target_page.png');
    const screenshots = [initialScreenshot, resultsScreenshot];
    if (searchResults.length > 0) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('.result h3 a')
      ]);

      logger.info('已点击第一个搜索结果');
      await new Promise((resolve) => setTimeout(resolve, 3000));

      await page.screenshot({ path: targetScreenshot, fullPage: true });
      logger.info(`已保存目标页面截图: ${targetScreenshot}`);
      screenshots.push(targetScreenshot);
    }

    // 返回结果。产物以裸文件名列出（执行器上报的清单用的就是裸名）。
    const result = {
      success: true,
      message: '浏览器自动化任务完成',
      executionId,
      artifactsDir: outputDir,
      screenshots: screenshots.map((p) => path.basename(p)),
      resultsFile: path.basename(resultsFile),
      searchResultsCount: searchResults.length,
      timestamp: new Date().toISOString()
    };

    console.log(`RESULT: ${JSON.stringify(result, null, 2)}`);
    return result;

  } finally {
    // 无论成功/失败/异常都要关掉浏览器，避免执行器节点残留进程
    if (browser) {
      try {
        await browser.close();
        logger.info('浏览器已关闭');
      } catch (e) {
        logger.warning(`关闭浏览器失败: ${e.message}`);
      }
    }
  }
}

// 如果直接运行此文件
if (require.main === module) {
  // 失败语义：抛异常 → 执行器判 FAILED（退出码非 0）。
  // 刻意**不**在 catch 里 `return {success:false}`——执行器只认进程退出码，
  // 返回对象不影响判定，那样会让失败任务在平台上显示为成功（假绿）。
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main };
