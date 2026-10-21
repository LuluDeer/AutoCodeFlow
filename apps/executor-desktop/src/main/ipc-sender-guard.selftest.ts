/**
 * SEC-IPC-SENDER selftest（R86-A1 轴 1）：sender 白名单闸 + 四轴源码钉子。
 *
 * 形式对齐既有 selftest（node:assert、无测试框架、`npm run test:main` 调用）。
 * 本文件直接驱动真实实现（ipc-sender-guard.ts 是纯 Node 模块，无 electron import），
 * 不拷贝副本——所以没有 SYNC 漂移风险；对 ipc-handlers.ts / updater.ts 这类
 * "加载即拉 electron" 的文件，只做**源码锚点**断言（与 export-flows.selftest.ts
 * 的 handlerBlock 形态一致）。
 *
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  IPC_SENDER_REJECTED,
  checkSender,
  createGuardedIpcMain,
  describeSender,
  isTrustedSenderUrl,
  safeOrigin,
} from './ipc-sender-guard';

const RENDERER_INDEX = path.join(os.tmpdir(), 'acf-audit', 'dist', 'renderer', 'index.html');
const RENDERER_DIR = path.dirname(RENDERER_INDEX);
const fileUrl = (abs: string, hash = ''): string => `${pathToFileURL(abs).href}${hash}`;

const PACKAGED = { devServerUrl: null, rendererIndexPath: RENDERER_INDEX };

// ── 1. 生产形态（packaged）：只认 renderer 目录下的 file: 页 ────────────────
{
  // 真实加载形态：loadFile(RENDERER_INDEX, { hash: 'status' })
  assert.ok(isTrustedSenderUrl(fileUrl(RENDERER_INDEX, '#status'), PACKAGED), 'index.html#status 必须可信');
  assert.ok(isTrustedSenderUrl(fileUrl(RENDERER_INDEX, '#wizard'), PACKAGED), 'index.html#wizard 必须可信');
  assert.ok(
    isTrustedSenderUrl(fileUrl(path.join(RENDERER_DIR, 'assets', 'x.html')), PACKAGED),
    'renderer 目录内的同包页面必须可信（未来新增入口页不破）',
  );

  // 目录逃逸：同一前缀但跳出 renderer 目录 —— path.resolve 会先折叠 ..
  assert.ok(
    !isTrustedSenderUrl(fileUrl(path.join(RENDERER_DIR, '..', '..', 'evil.html')), PACKAGED),
    '跳出 renderer 目录的 file: 页必须拒绝（.. 折叠后域外）',
  );
  // 前缀伪装：'renderer-evil' 与 'renderer' 是兄弟目录，不能让 startsWith 放行
  assert.ok(
    !isTrustedSenderUrl(fileUrl(path.join(RENDERER_DIR + '-evil', 'index.html')), PACKAGED),
    '兄弟目录 renderer-evil 必须拒绝（前缀伪装）',
  );

  // 远端 / 特殊协议一律拒绝（导航守卫是另一道闸，这里是 IPC 面自己的闸）
  for (const url of [
    'https://evil.example.com/',
    'http://127.0.0.1:8002/',
    'about:blank',
    'data:text/html,<script>1</script>',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '',
    '   ',
  ]) {
    assert.ok(!isTrustedSenderUrl(url, PACKAGED), `不可信 URL 必须拒绝: ${JSON.stringify(url)}`);
  }
  assert.ok(!isTrustedSenderUrl(null, PACKAGED), 'null url 必须拒绝');
  assert.ok(!isTrustedSenderUrl(undefined, PACKAGED), 'undefined url 必须拒绝');
  assert.ok(!isTrustedSenderUrl(42, PACKAGED), '非字符串 url 必须拒绝');

  // 策略缺锚点（rendererIndexPath 空）→ 连 file: 也不可信（fail-closed）
  assert.ok(
    !isTrustedSenderUrl(fileUrl(RENDERER_INDEX), { devServerUrl: null, rendererIndexPath: null }),
    '策略未配置锚点时必须 fail-closed',
  );
}

// ── 2. 开发形态：与 devServerUrl **同源**（origin 全等，非前缀）────────────
{
  const DEV = { devServerUrl: 'http://localhost:5173', rendererIndexPath: RENDERER_INDEX };
  assert.ok(isTrustedSenderUrl('http://localhost:5173/#status', DEV), 'dev server 同源页必须可信');
  assert.ok(isTrustedSenderUrl('http://localhost:5173/#wizard', DEV), 'dev server 同源页必须可信（hash 无关）');

  // 前缀绕过（经典错误）：startsWith('http://localhost:5173') 会放行 evil.tld
  assert.ok(
    !isTrustedSenderUrl('http://localhost:5173.evil.tld/#status', DEV),
    'localhost:5173.evil.tld 必须拒绝（前缀绕过钉死）',
  );
  assert.ok(!isTrustedSenderUrl('https://localhost:5173/#status', DEV), '协议不同（https）必须拒绝');
  assert.ok(!isTrustedSenderUrl('http://127.0.0.1:5173/#status', DEV), 'host 不同必须拒绝');
  assert.ok(!isTrustedSenderUrl('http://localhost:5174/#status', DEV), '端口不同必须拒绝');

  // dev 策略下 file: 页仍可信（打包形态 + 手起 dev server 的混合场景）
  assert.ok(isTrustedSenderUrl(fileUrl(RENDERER_INDEX, '#status'), DEV), 'dev 策略下同包 file: 页仍可信');

  // safeOrigin 本身：非 http(s) 一律 null
  assert.strictEqual(safeOrigin('http://localhost:5173/x'), 'http://localhost:5173');
  assert.strictEqual(safeOrigin('file:///x'), null);
  assert.strictEqual(safeOrigin('not a url'), null);
}

// ── 3. frame 身份：子 frame / 已销毁 frame 一律拒绝 ──────────────────────
{
  const trusted = fileUrl(RENDERER_INDEX, '#status');
  assert.deepStrictEqual(checkSender({ url: trusted, isSubFrame: false }, PACKAGED), { ok: true });

  const sub = checkSender({ url: trusted, isSubFrame: true }, PACKAGED);
  assert.strictEqual(sub.ok, false, '子 frame 必须拒绝（iframe 不得驱动主进程能力）');

  const dead = checkSender({ url: null, isSubFrame: false }, PACKAGED);
  assert.strictEqual(dead.ok, false, 'frame url 缺失必须拒绝（fail-closed）');

  const remote = checkSender({ url: 'https://evil.tld/', isSubFrame: false }, PACKAGED);
  assert.strictEqual(remote.ok, false, '域外 URL 必须拒绝');

  // describeSender：WebFrameMain.parent === null 才是主 frame
  assert.deepStrictEqual(describeSender({ senderFrame: { url: trusted, parent: null } }), {
    url: trusted,
    isSubFrame: false,
  });
  assert.deepStrictEqual(describeSender({ senderFrame: { url: trusted, parent: {} } }), {
    url: trusted,
    isSubFrame: true,
  });
  // frame 已销毁（null）→ url 置空，**不回退** sender.getURL()（那是"当前页面"不是"发送者"）
  assert.deepStrictEqual(
    describeSender({ senderFrame: null, sender: { getURL: () => trusted } }),
    { url: null, isSubFrame: false },
  );
  assert.deepStrictEqual(describeSender(null), { url: null, isSubFrame: false });
}

// ── 4. createGuardedIpcMain：注册面整体过闸（handle 抛错 / on 静默丢弃）──
{
  const registered = new Map<string, (event: any, ...args: any[]) => any>();
  const raw = {
    handle: (channel: string, listener: (event: any, ...args: any[]) => any) => {
      registered.set(channel, listener);
    },
  };
  const warnings: string[] = [];
  const ipc = createGuardedIpcMain(raw, {
    policy: () => PACKAGED,
    log: { warn: (msg: string) => warnings.push(msg) },
  });

  let calls = 0;
  ipc.handle('config:save', (_event, cfg) => {
    calls += 1;
    return { ok: true, got: cfg };
  });
  const handler = registered.get('config:save');
  assert.ok(handler, 'handle 必须把包装后的函数交给 electron ipcMain');

  // 可信 sender：正常透传（含参数）
  assert.deepStrictEqual(
    handler!({ senderFrame: { url: fileUrl(RENDERER_INDEX, '#status'), parent: null } }, { a: 1 }),
    { ok: true, got: { a: 1 } },
  );
  assert.strictEqual(calls, 1);

  // 不可信 sender（远端页）：必须抛 IPC_SENDER_REJECTED 且**不执行** handler
  assert.throws(
    () => handler!({ senderFrame: { url: 'https://evil.tld/', parent: null } }, { a: 2 }),
    (err: any) => err instanceof Error && err.message.includes(IPC_SENDER_REJECTED),
    '不可信 sender 必须抛错（invoke 侧 rejected）',
  );
  assert.strictEqual(calls, 1, '被闸拦下的调用绝不允许落到 handler');

  // 子 frame：同样拒绝
  assert.throws(
    () => handler!({ senderFrame: { url: fileUrl(RENDERER_INDEX, '#status'), parent: {} } }, { a: 3 }),
    /IPC sender rejected/,
    '子 frame 必须拒绝',
  );
  assert.strictEqual(calls, 1);

  // 拒绝必须留痕（托盘/文件日志可定位"是谁在调"）
  assert.ok(warnings.length >= 2, '拒绝必须落 warn 日志');
  assert.ok(warnings.every((w) => w.includes('config:save')), '日志必须带 channel 名');

  // on（单向通道）：不可信 → 不执行且不抛
  let onCalls = 0;
  const onRegistered = new Map<string, (event: any, ...args: any[]) => any>();
  const ipc2 = createGuardedIpcMain(
    { handle: () => undefined, on: (c, l) => onRegistered.set(c, l) },
    { policy: () => PACKAGED },
  );
  ipc2.on('some:event', () => {
    onCalls += 1;
  });
  onRegistered.get('some:event')!({ senderFrame: { url: 'https://evil.tld/', parent: null } });
  assert.strictEqual(onCalls, 0, '不可信 sender 的单向通道必须静默丢弃');
  onRegistered.get('some:event')!({ senderFrame: { url: fileUrl(RENDERER_INDEX), parent: null } });
  assert.strictEqual(onCalls, 1, '可信 sender 的单向通道必须正常触发');
}

// ── 5. SYNC 钉子：IPC 面必须整体过闸（ipc-handlers.ts 源码锚点）─────────
const repoMain = path.join(__dirname, '..', 'src', 'main');
const readMain = (name: string): string => fs.readFileSync(path.join(repoMain, name), 'utf-8');
{
  const ipc = readMain('ipc-handlers.ts');

  // (a) electron 侧只允许别名导入 ipcMain——本地 ipcMain 必须由闸产出。
  //     直接 `import { ipcMain } from 'electron'` 会让所有 handle 绕过闸。
  const electronImport = ipc.match(/import\s*\{[^}]*\}\s*from\s*'electron';/);
  assert.ok(electronImport, 'SYNC: 找不到 ipc-handlers.ts 的 electron import 语句');
  assert.ok(
    /ipcMain\s+as\s+electronIpcMain/.test(electronImport![0]),
    'SYNC: electron 的 ipcMain 必须以 electronIpcMain 别名导入（本地 ipcMain 由 createGuardedIpcMain 产出）',
  );
  assert.ok(
    !/[^a-zA-Z]ipcMain\s*,/.test(electronImport![0]) && !/\{\s*ipcMain\s*\}/.test(electronImport![0]),
    'SYNC: 不允许再把 electron 的 ipcMain 直接按原名导入（会绕过 sender 闸）',
  );

  // (b) 本地 ipcMain 必须是闸的产物，且策略接入 dev/packaged 两个锚点
  assert.ok(
    /const\s+ipcMain\s*=\s*createGuardedIpcMain\(/.test(ipc),
    'SYNC: 本地 ipcMain 必须由 createGuardedIpcMain( 产出（单一注册入口）',
  );
  assert.ok(
    /rendererIndexPath\s*:\s*resolveRendererIndex\(\)/.test(ipc),
    'SYNC: sender 白名单必须锚在 window-manager 的 rendererIndexPath（与 loadFile 同源）',
  );
  assert.ok(
    /devServerUrl\s*:\s*process\.env\.VITE_DEV_SERVER_URL/.test(ipc),
    'SYNC: sender 白名单必须接入 VITE_DEV_SERVER_URL（dev 形态）',
  );

  // (c) 记录基线：handler 数量不得因"改造"被静默删减（43 个是本轮审计时的实点）
  const handlerCount = (ipc.match(/ipcMain\.handle\(/g) ?? []).length;
  assert.ok(
    handlerCount >= 43,
    `SYNC: ipcMain.handle 注册数从 43 掉到 ${handlerCount}——handler 被静默删除？`,
  );

  // (d) check-port 必须委托 port-check.ts（参数闸的唯一真值源），不得再内联 net.createServer
  assert.ok(
    !/net\.createServer\(/.test(ipc),
    'SYNC: ipc-handlers.ts 不得再内联 net.createServer（config:check-port 必须走 port-check.ts 的参数闸）',
  );
  assert.ok(
    /from '\.\/port-check'/.test(ipc),
    'SYNC: ipc-handlers.ts 必须 import \'./port-check\'',
  );
}

// ── 6. SYNC 钉子：轴 2（凭据不过桥）/ 轴 3（更新链）/ 轴 4（子进程）────
{
  const ipc = readMain('ipc-handlers.ts');
  const handlerBlock = (name: string): string => {
    const start = ipc.indexOf(`ipcMain.handle('${name}'`);
    assert.ok(start >= 0, `SYNC: 找不到 handler ${name}`);
    const rest = ipc.slice(start + `ipcMain.handle('${name}'`.length);
    const next = rest.indexOf('ipcMain.handle(');
    return next >= 0 ? rest.slice(0, next) : rest;
  };

  // 轴 2：token 永不过 IPC —— 两个"交配置给渲染层"的通道只许用掩码读面
  for (const name of ['config:get', 'executor:status']) {
    const block = handlerBlock(name);
    assert.ok(block.includes('getAllMasked('), `SYNC: ${name} 必须用 getAllMasked()（token 不过桥）`);
    assert.ok(
      !/getAll\(\)/.test(block),
      `SYNC: ${name} 出现 getAll() —— 会把 enc:ss: 信封/明文 token 交给渲染层`,
    );
  }
  // 轴 2：诊断报告的已知凭据抹除面不得被摘掉
  assert.ok(
    /knownSecrets/.test(ipc),
    'SYNC: 诊断报告的 knownSecrets 抹除面不得被删除（自由文本里的 token 也要抹）',
  );

  // 轴 3：更新链——降级拦截 + generic feed 只收 https
  const updater = readMain('updater.ts');
  assert.ok(
    /isNewerVersion\(remote, local\)/.test(updater),
    'SYNC: update-available 必须先过 isNewerVersion(remote, local)（防降级/防回滚投毒）',
  );
  assert.ok(
    /u\.protocol === 'http:'/.test(updater) && /u\.protocol !== 'https:/.test(updater),
    'SYNC: resolveGenericFeedUrl 必须拒绝 http: 且只接受 https:（AUTOUPDATE_URL 覆盖源）',
  );
  assert.ok(
    /provider: 'generic', url: genericUrl/.test(updater),
    'SYNC: generic feed 只允许用已校验的 genericUrl 注入 setFeedURL',
  );

  // 轴 4：子进程——spawn 一律数组参数、不经 shell；输出有界
  for (const name of ['executor-process.ts', 'agent-worker-process.ts']) {
    const src = readMain(name);
    assert.ok(
      /spawn\(process\.execPath, \[/.test(src),
      `SYNC: ${name} 必须以数组参数 spawn(process.execPath, [...])（不经 shell）`,
    );
    assert.ok(
      !/shell\s*:\s*true/.test(src),
      `SYNC: ${name} 不得开启 shell:true（命令注入面）`,
    );
  }
  assert.ok(
    /MAX_PENDING_LINE_BYTES/.test(readMain('child-line-splitter.ts')),
    'SYNC: 子进程输出的按行缓冲必须有上限（MAX_PENDING_LINE_BYTES）',
  );
  assert.ok(
    /\/T', '\/F', '\/PID'/.test(readMain('executor-process.ts')),
    'SYNC: win32 强杀必须是 taskkill /T /F（进程树），不得退化为单进程 kill',
  );
}

console.log(
  'ipc-sender-guard selftest: all assertions passed ' +
    '(packaged/dev/file-URL allowlist, sub-frame & dead-frame deny, guarded registration, 4-axis SYNC nails)',
);
