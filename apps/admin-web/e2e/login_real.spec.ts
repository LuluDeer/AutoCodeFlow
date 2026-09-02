import { test } from '@playwright/test';

test('真实登录流程 - 不注入token', async ({ page }) => {
  const networkLogs: string[] = [];
  const consoleLogs: string[] = [];

  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('response', async (response) => {
    if (response.url().includes('/api/')) {
      let body = '';
      try { body = await response.text(); } catch {
        // Body read may fail (e.g. aborted requests); fall back to status-only logging.
      }
      networkLogs.push(`${response.status()} ${response.url().split('/api/')[1]} → ${body.substring(0, 400)}`);
    }
  });

  console.log('Step 1: 打开登录页');
  await page.goto('http://localhost:5176/login');
  await page.waitForTimeout(500);
  console.log('当前 URL:', page.url());

  console.log('Step 2: 填写用户名密码');
  await page.fill('input[placeholder="用户名"]', 'admin');
  await page.fill('input[placeholder="密码"]', 'admin123');

  console.log('Step 3: 点击登录');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  console.log('Step 4: 登录后 URL:', page.url());

  const authData = await page.evaluate(() => {
    const raw = localStorage.getItem('autoflow-auth');
    return raw ? JSON.parse(raw) : null;
  });
  console.log('Step 5: localStorage state:', JSON.stringify(authData, null, 2));

  console.log('\n=== 网络请求 ===');
  networkLogs.forEach(l => console.log(l));

  console.log('\n=== 控制台日志 ===');
  consoleLogs.forEach(l => console.log(l));
});
