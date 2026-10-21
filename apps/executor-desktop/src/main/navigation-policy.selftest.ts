/**
 * R106：导航白名单判定的行为矩阵。
 *
 * 这条纯函数替换了原来的 `url.startsWith('file://')` —— 后者在生产形态下等于**放行任意本地文件**，
 * 而导航后 preload 桥仍挂在同一个 webContents 上。
 *
 * 用例覆盖四类：
 *  ① 生产形态：入口页自身（含 hash/query）放行；**任何其它** file:// 拒绝；
 *  ② 生产形态：http(s) / javascript: / data: / 相对串 / 空串 一律拒绝（fail-closed）；
 *  ③ 归一化：`..` 路径段与百分号编码后仍指向入口页的放行；指向别处的拒绝；
 *  ④ dev 形态：只认 dev server 前缀，且此时**不**放行 file://。
 */
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { isAllowedNavigation } from './navigation-policy';

const RENDERER = 'file:///C:/app/dist/renderer/index.html';
const PROD = { devUrl: null, rendererFileUrl: RENDERER };
const DEV = { devUrl: 'http://localhost:5173', rendererFileUrl: null };

function main(): void {
  // ① 生产：入口页自身
  assert.equal(isAllowedNavigation(RENDERER, PROD), true, '入口页本身必须放行');
  assert.equal(
    isAllowedNavigation(RENDERER + '#/tabs/logs', PROD),
    true,
    'SPA hash 路由属于同一页面',
  );
  assert.equal(isAllowedNavigation(RENDERER + '?x=1', PROD), true, 'query 也属于同一页面');

  // ① 生产：其它本地文件全拒（这就是旧判据漏掉的部分）
  for (const bad of [
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'file:///C:/app/dist/renderer/other.html',
    'file:///C:/app/dist/main/index.js',
    'file:///tmp/evil.html',
  ]) {
    assert.equal(isAllowedNavigation(bad, PROD), false, `必须拒绝 ${bad}`);
  }

  // ② 非 file 协议与畸形输入
  for (const bad of [
    'http://evil.example/x',
    'https://evil.example/x',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'about:blank',
    '',
    'not a url',
  ]) {
    assert.equal(isAllowedNavigation(bad, PROD), false, `必须拒绝 ${JSON.stringify(bad)}`);
  }

  // ③ 归一化：指向入口页的等价写法放行，指向别处的不放行
  assert.equal(
    isAllowedNavigation('file:///C:/app/dist/renderer/../renderer/index.html', PROD),
    true,
    '路径归一后仍是入口页',
  );
  assert.equal(
    isAllowedNavigation('file:///C:/app/dist/renderer/../renderer/evil.html', PROD),
    false,
  );

  // ④ dev 形态
  assert.equal(isAllowedNavigation('http://localhost:5173/', DEV), true);
  assert.equal(isAllowedNavigation('http://localhost:5173/index.html', DEV), true);
  assert.equal(
    isAllowedNavigation(RENDERER, DEV),
    false,
    'dev 形态下 file:// 不应被放行（生产判据不生效）',
  );
  assert.equal(isAllowedNavigation('http://localhost:5174/', DEV), false, '端口不同即不同来源');

  // 策略缺 rendererFileUrl 时必须 fail-closed（宁可白屏也不放行任意文件）
  assert.equal(isAllowedNavigation(RENDERER, { devUrl: null, rendererFileUrl: null }), false);

  // 接线钉子：window-manager 必须**两个事件都挂**同一条判据。
  // 路径候选逐个试、全都找不到即失败（别让检查静默跳过——R105 踩过）。
  const candidates = [
    path.join(__dirname, '..', 'src', 'main', 'window-manager.ts'),
    path.join(__dirname, '..', '..', 'src', 'main', 'window-manager.ts'),
  ];
  const wmPath = candidates.find((p) => fs.existsSync(p));
  assert.ok(wmPath, '找不到 window-manager.ts：接线检查无法进行，按失败处理');
  const wm = fs.readFileSync(wmPath!, 'utf8');
  assert.ok(wm.includes('isAllowedNavigation('), 'window-manager 必须使用 isAllowedNavigation');
  assert.ok(wm.includes("'will-navigate'"), '必须挂 will-navigate');
  assert.ok(wm.includes("'will-redirect'"), '必须挂 will-redirect（3xx 是另一条事件）');
  assert.ok(
    !/startsWith\('file:\/\/'\)/.test(wm),
    '不得回退到 startsWith(\'file://\') 的前缀判据',
  );

  console.log('navigation-policy selftest: all assertions passed (prod pin + fail-closed + dev + wiring nails)');
}

main();
