/**
 * diag-probes（轮 #7 桌面轴 / 轮 #9 收尾）自检：
 *   ① uv PATH 探测必须**异步 + 缓存 + 并发合流**（旧实现是同步 spawnSync，5s 上限
 *      冻主线程：心跳/托盘/全部 IPC/executor stdout 解析全停）；
 *   ② 工作目录可写性判定必须**不落盘**（旧实现写 .acf-diag-*.tmp 再删，面板每次
 *      刷新都在用户 workDir 留一次写事件）；
 *   ③ 源码钉：ipc-handlers.ts 不得再出现 spawnSync / 写探针临时文件。
 *
 * 反证（改回旧行为应转红）：
 *   · 把 probeUvVersionOnce 换成 spawnSync → 第 ③ 组源码钉直接红；
 *   · 去掉缓存（每次 available 都 count += 1）→ 「TTL 内只探一次」红；
 *   · 把 probeWorkDirWritable 改回写文件 → 「目录内容前后一致」红。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  UV_PATH_PROBE_TTL_MS,
  createUvPathProbe,
  probeWorkDirWritable,
} from './diag-probes';

/**
 * 源码钉读的是 **src/main** 下的实现，而本文件编译产物落 dist-selftest/
 * （tsconfig.selftest.json 的 outDir）——所以不能直接用 __dirname。
 * 两种运行形态都覆盖：编译后（dist-selftest/.. → src/main）与直跑 TS（src/main）。
 */
const MAIN_DIR = fs.existsSync(path.join(__dirname, 'ipc-handlers.ts'))
  ? __dirname
  : path.join(__dirname, '..', 'src', 'main');

async function testUvProbeCacheAndCoalescing(): Promise<void> {
  let calls = 0;
  let clock = 1_000_000;
  const probe = createUvPathProbe({
    runUvVersion: async () => {
      calls += 1;
      return true;
    },
    now: () => clock,
    ttlMs: 1_000,
  });

  assert.strictEqual(await probe.available(), true);
  assert.strictEqual(calls, 1, '首次探测必须实跑一次');
  assert.strictEqual(await probe.available(), true);
  assert.strictEqual(calls, 1, 'TTL 内必须命中缓存（不得重复 execFile）');

  clock += 1_001;
  await probe.available();
  assert.strictEqual(calls, 2, 'TTL 过期后必须重新探测');

  // 并发合流：同时挂载设置页与健康面板只应探一次
  probe.invalidate();
  calls = 0;
  const slow = createUvPathProbe({
    runUvVersion: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return false;
    },
    ttlMs: 1_000,
  });
  const [a, b] = await Promise.all([slow.available(), slow.available()]);
  assert.strictEqual(a, false);
  assert.strictEqual(b, false);
  assert.strictEqual(calls, 1, '并发调用必须合流成一次探测');

  // 失败也是结论：ENOENT/超时的机器不该每次刷新都再探一遍
  const failing = createUvPathProbe({
    runUvVersion: async () => {
      throw new Error('ENOENT');
    },
    ttlMs: 1_000,
  });
  assert.strictEqual(await failing.available(), false, '探测失败必须 resolve(false) 而不是抛');
  assert.strictEqual(failing.probeCount(), 1);
  assert.strictEqual(await failing.available(), false);
  assert.strictEqual(failing.probeCount(), 1, '失败结论也必须被缓存');

  // invalidate 后重新探测（配置里改 uvPath 时用）
  const p3 = createUvPathProbe({ runUvVersion: async () => true, ttlMs: 60_000 });
  await p3.available();
  p3.invalidate();
  await p3.available();
  assert.strictEqual(p3.probeCount(), 2, 'invalidate 后必须重新探测');
  assert.strictEqual(UV_PATH_PROBE_TTL_MS, 60_000, '默认 TTL 是 60s（设置页/健康面板共用）');
  console.log('  ✔ uv 探测：TTL 缓存 / 并发合流 / 失败即结论 / invalidate');
}

async function testWorkDirProbeDoesNotWrite(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-diag-probe-'));
  try {
    const before = fs.readdirSync(dir).sort();
    const res = await probeWorkDirWritable(dir);
    const after = fs.readdirSync(dir).sort();
    assert.strictEqual(res.writable, true, '正常临时目录必须判可写');
    assert.deepStrictEqual(
      after,
      before,
      '可写性判定**不得在用户目录留下任何文件**（旧实现的 .acf-diag-*.tmp）',
    );

    // 目录是普通文件：必须判不可写，且给出可读原因（旧实现写 .acf-diag-*.tmp 时 ENOTDIR）
    const filePath = path.join(dir, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'x');
    const asFile = await probeWorkDirWritable(filePath);
    assert.strictEqual(asFile.writable, false, '把文件路径当 workDir 必须判不可写');
    assert.ok(
      (asFile.probeError ?? '').includes('不是目录'),
      '不可写必须说明原因（不是目录）',
    );

    // 不存在的目录：不可写 + 带 errno 文本
    const missing = await probeWorkDirWritable(path.join(dir, 'nope'));
    assert.strictEqual(missing.writable, false);
    assert.ok((missing.probeError ?? '').length > 0, '不存在也必须给出原因');

    // 注入 access 拒绝（模拟只读挂载）：不可写 + 原因是注入的错误
    const denied = await probeWorkDirWritable(dir, {
      access: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    assert.strictEqual(denied.writable, false);
    assert.ok((denied.probeError ?? '').includes('EACCES'));
    console.log('  ✔ workDir 可写性：不落盘 / 文件路径 / 不存在 / EACCES');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testSourcePins(): void {
  const ipc = fs.readFileSync(path.join(MAIN_DIR, 'ipc-handlers.ts'), 'utf8');
  // 先剥注释再断言：旧行为的说明**必须允许**写在注释里（本仓的纪律就是把故障形态
  // 写在代码旁），否则这条 pin 会逼着后人删掉最有价值的那段解释。
  const ipcCode = ipc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  assert.ok(
    !ipcCode.includes('spawnSync('),
    'ipc-handlers.ts 不得再出现同步 spawnSync（会冻住主线程；探测已抽到 diag-probes）',
  );
  assert.ok(
    !/\.acf-diag-/.test(ipcCode),
    'ipc-handlers.ts 不得再出现写探针临时文件（面板是纯展示面，不该落盘）',
  );
  const probeSrc = fs.readFileSync(path.join(MAIN_DIR, 'diag-probes.ts'), 'utf8');
  assert.ok(
    probeSrc.includes('execFile('),
    'uv 探测必须走异步 execFile（同步 spawn 会冻主线程）',
  );
  assert.ok(
    !probeSrc.includes('writeFile'),
    'diag-probes 不得写文件（可写性判定只查权限）',
  );
  const ignore = fs.readFileSync(
    path.join(MAIN_DIR, '..', '..', '.gitignore'),
    'utf8',
  );
  assert.ok(
    fs.existsSync(path.join(MAIN_DIR, 'diag-probes.ts')),
    '源码钉必须真的读到 src/main（路径推导错了会读到空目录，断言会假绿）',
  );
  assert.ok(
    ignore.includes('src/preload/*.js'),
    '.gitignore 必须挡住 src/preload 下的编译产物（防止再落一份与 .ts 漂移的副本）',
  );
  console.log('  ✔ 源码钉：无同步 spawn / 无写探针 / execFile / preload 产物被忽略');
}

(async () => {
  await testUvProbeCacheAndCoalescing();
  await testWorkDirProbeDoesNotWrite();
  testSourcePins();
  console.log('diag-probes.selftest: all assertions passed');
  process.exit(0);
})().catch((err) => {
  console.error('diag-probes.selftest FAILED:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
