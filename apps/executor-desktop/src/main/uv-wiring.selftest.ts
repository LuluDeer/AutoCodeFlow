/**
 * python_task_multiversion self-check for the desktop executor's uv wiring.
 * Run via: npm run test:main
 *
 * 覆盖的都是"客户端执行器与 python 执行器功能对等"的必要条件，且每一条都
 * 对应一个**曾经容易写错、错了却很难发现**的点：
 *   1. 池目录默认落点必须在 userData（安装目录只读，放那里 uv 必然写失败）；
 *   2. 显式配置优先，空白串视为未配置（用户清空输入框的场景）；
 *   3. 没自带 uv 时返回 null 而**不抛**（缺 uv 是降级，不是致命错误）；
 *   4. `UV_PYTHON_DOWNLOADS=manual` 必须始终下发（D8：venv 阶段绝不隐式下载）；
 *   5. 空值不得写成空串环境变量（否则会覆盖掉用户在系统里配的值）。
 */
import * as assert from 'node:assert';
import {
  buildExecutorChildEnv,
  buildUvChildEnv,
  pickPublicAddress,
  resolveBundledUvPath,
  resolveInterpretersDir,
  uvExecutableName,
  type UvPathInputs,
} from './uv-paths';

function inputs(overrides: Partial<UvPathInputs> = {}): UvPathInputs {
  return {
    isPackaged: false,
    resourcesPath: '/app/resources',
    appPath: '/repo/apps/executor-desktop',
    userDataDir: '/home/u/.config/AutoCodeFlow',
    platform: 'linux',
    existsFile: () => false,
    ...overrides,
  };
}

function main(): void {
  // ---- 1. uv 可执行文件名随平台 ----
  assert.strictEqual(uvExecutableName('win32'), 'uv.exe');
  assert.strictEqual(uvExecutableName('linux'), 'uv');
  assert.strictEqual(uvExecutableName('darwin'), 'uv');

  // ---- 2. 池目录：显式配置优先；空白串视为未配置 ----
  assert.strictEqual(
    resolveInterpretersDir('/data/acf/interpreters', '/home/u/.config/ACF'),
    '/data/acf/interpreters',
    '显式配置必须原样采用',
  );
  for (const blank of ['', '   ', undefined, null]) {
    assert.strictEqual(
      resolveInterpretersDir(blank as any, '/home/u/.config/ACF'),
      '/home/u/.config/ACF/interpreters',
      `${JSON.stringify(blank)} 必须回退到 userData 默认`,
    );
  }
  // 关键：默认落点不得在安装目录（Program Files 只读）。
  const win = resolveInterpretersDir('', 'C:\\Users\\u\\AppData\\Roaming\\AutoCodeFlow');
  assert.ok(
    win.endsWith('interpreters'),
    `Windows 默认池目录应以 interpreters 结尾，实际 ${win}`,
  );

  // ---- 3. 自带 uv 探测：找不到返回 null 且不抛 ----
  assert.strictEqual(
    resolveBundledUvPath(inputs({ existsFile: () => false })),
    null,
    '没有自带 uv 时必须返回 null',
  );
  // 打包态优先看 resourcesPath/uv/<bin>
  let seen: string[] = [];
  const packaged = resolveBundledUvPath(
    inputs({
      isPackaged: true,
      resourcesPath: '/opt/app/resources',
      platform: 'win32',
      existsFile: (c) => {
        seen.push(c);
        return c === '/opt/app/resources\\uv\\uv.exe' || c === '/opt/app/resources/uv/uv.exe';
      },
    }),
  );
  assert.ok(packaged, `打包态应找到自带 uv，探测过的候选：${seen.join(' | ')}`);
  assert.ok(/uv(\.exe)?$/.test(packaged!), `必须指向 uv 可执行文件，实际 ${packaged}`);
  assert.ok(seen.some((c) => c.includes('resources')), '打包态必须探测 resourcesPath 下的 uv');

  // 开发态：appPath/resources/uv/<bin>
  const dev = resolveBundledUvPath(
    inputs({
      isPackaged: false,
      appPath: '/repo/apps/executor-desktop',
      existsFile: (c) => c === '/repo/apps/executor-desktop/resources/uv/uv',
    }),
  );
  assert.strictEqual(dev, '/repo/apps/executor-desktop/resources/uv/uv');

  // 存在性判定抛异常时不得冒泡（坏符号链接/权限不足）。
  assert.strictEqual(
    resolveBundledUvPath(
      inputs({
        existsFile: () => {
          throw new Error('EACCES');
        },
      }),
    ),
    null,
    'existsFile 抛异常时必须吞掉并返回 null，绝不冒泡',
  );

  // ---- 4. 子进程环境：manual 恒定下发 ----
  const env = buildUvChildEnv({
    uvBin: '/opt/app/resources/uv/uv',
    interpretersDir: '/home/u/.config/ACF/interpreters',
  });
  assert.strictEqual(
    env.UV_PYTHON_DOWNLOADS,
    'manual',
    'D8：UV_PYTHON_DOWNLOADS=manual 必须始终下发（venv 阶段绝不隐式下载）',
  );
  assert.strictEqual(env.UV_PYTHON_INSTALL_DIR, '/home/u/.config/ACF/interpreters');
  assert.strictEqual(env.UV_BIN, '/opt/app/resources/uv/uv');

  // ---- 5. 空值不得写成空串环境变量 ----
  const sparse = buildUvChildEnv({
    uvBin: null,
    interpretersDir: '/pool',
    mirror: '   ',
    pypiRegistryUrl: '',
    downloadTimeoutMs: 0,
  });
  assert.ok(
    !('UV_BIN' in sparse),
    'uvBin 为 null 时不得写 UV_BIN（让 executor-node 走 PATH 兜底）',
  );
  assert.ok(!('UV_PYTHON_INSTALL_MIRROR' in sparse), '空白 mirror 不得写环境变量');
  assert.ok(!('PYPI_REGISTRY_URL' in sparse), '空 registry 不得写环境变量');
  assert.ok(
    !('INTERPRETER_DOWNLOAD_TIMEOUT_MS' in sparse),
    '0/缺省超时不得写环境变量',
  );

  // 有值时才写。
  const full = buildUvChildEnv({
    uvBin: '/uv',
    interpretersDir: '/pool',
    mirror: 'https://mirror.internal/uv',
    pypiRegistryUrl: 'https://pypi.internal/simple',
    downloadTimeoutMs: 300000,
  });
  assert.strictEqual(full.UV_PYTHON_INSTALL_MIRROR, 'https://mirror.internal/uv');
  assert.strictEqual(full.PYPI_REGISTRY_URL, 'https://pypi.internal/simple');
  assert.strictEqual(full.INTERPRETER_DOWNLOAD_TIMEOUT_MS, '300000');

  // ---- 6. 子进程环境契约：两个"漏了不报错、只是永远不工作"的键 ----
  //
  // 反证：从 buildExecutorChildEnv 里删掉 BIND_ADDRESS 或
  // EXECUTOR_ALLOW_PRIVATE_NETWORK，本组断言立即失败。
  const childEnv = buildExecutorChildEnv({
    appName: 'my-executor',
    port: 8002,
    bindAddress: '0.0.0.0',
    executorHost: '0.0.0.0',
    adminApiUrl: 'http://192.168.1.10:3001',
    workDir: '/work',
    maxConcurrentTasks: 4,
    sharedToken: 'tok',
    logLevel: 'debug',
  });

  // E-25 回归：executor-node 默认绑 127.0.0.1，桌面端必须显式覆盖成对外地址，
  // 否则注册的是 LAN 地址而进程只监听 loopback —— 永远收不到任务（ECONNREFUSED）。
  assert.strictEqual(
    childEnv.BIND_ADDRESS,
    '0.0.0.0',
    'BIND_ADDRESS 必须下发：缺了它桌面执行器只监听 127.0.0.1，admin 派发全部 ECONNREFUSED',
  );
  // 用 `string` 宽化比较（字面量与字面量比较会被 TS 判为无意义）——这里要钉的是
  // "下发的值不得是 loopback"，而不是某个具体字面量。
  const loopback: string = '127.0.0.1';
  assert.ok(
    childEnv.BIND_ADDRESS !== loopback,
    'BIND_ADDRESS 不得是 loopback —— 桌面执行器的意义就是被 admin 从局域网推到',
  );

  // E-04 逃生开关：桌面执行器要下载的 packageUrl 按构造就是私网的。
  assert.strictEqual(
    childEnv.EXECUTOR_ALLOW_PRIVATE_NETWORK,
    'true',
    'EXECUTOR_ALLOW_PRIVATE_NETWORK 必须下发：缺了它 zip 渠道任务的下载被自身 SSRF 闸门拒掉',
  );

  // P3-1：logLevel 必须透传给子进程（此前 config.logLevel 是没有消费者的死字段）。
  assert.strictEqual(
    childEnv.LOG_LEVEL,
    'debug',
    'LOG_LEVEL 必须随子进程 env 下发，executor-node 的 winston logger 读它',
  );
  const noLogLevel = buildExecutorChildEnv({
    appName: 'x', port: 1, bindAddress: '0.0.0.0', executorHost: '0.0.0.0',
    adminApiUrl: 'http://a', workDir: '/w', maxConcurrentTasks: 1, sharedToken: 't',
  });
  assert.ok(
    !('LOG_LEVEL' in noLogLevel),
    'logLevel 为空时不得下发 LOG_LEVEL（保留 executor-node 的 info 默认）',
  );

  // 对外地址：显式配置优先（真实网卡地址照常下发）。
  const pinned = buildExecutorChildEnv({
    appName: 'x',
    port: 9001,
    bindAddress: '0.0.0.0',
    executorHost: '0.0.0.0',
    executorAddressPublic: '192.168.1.20:9001',
    adminApiUrl: 'http://a',
    workDir: '/w',
    maxConcurrentTasks: 1,
    sharedToken: 't',
  });
  assert.strictEqual(pinned.EXECUTOR_ADDRESS_PUBLIC, '192.168.1.20:9001');
  assert.strictEqual(childEnv.PORT, '8002');
  assert.strictEqual(childEnv.APP_NAME, 'my-executor');

  // 通配监听地址（0.0.0.0 / ::）**不得**被当成对外地址下发：admin-api 把
  // 0.0.0.0/8 归为 reserved 且无条件拒绝（连私网开关也不放行），下发它 =
  // 一个"注册成功、显示在线、永远派发不到"的执行器。此时应留空，让
  // executor-node 回落到 EXECUTOR_ADDRESS。
  assert.strictEqual(
    childEnv.EXECUTOR_ADDRESS_PUBLIC,
    '',
    '0.0.0.0 不是可路由的对外地址，不得下发（会让执行器永远收不到任务）',
  );
  assert.strictEqual(
    pickPublicAddress(undefined, '0.0.0.0', 8002),
    '',
    '留空 + 通配 host 时必须留空',
  );
  assert.strictEqual(
    pickPublicAddress('0.0.0.0:8002', '0.0.0.0', 8002),
    '',
    '显式填了 0.0.0.0 也要挡住',
  );
  assert.strictEqual(
    pickPublicAddress('   ', '0.0.0.0', 8002),
    '',
    '空白串视为未填',
  );
  assert.strictEqual(
    pickPublicAddress(undefined, '192.168.1.20', 8002),
    '192.168.1.20:8002',
    '真实网卡地址照常回落',
  );
  // 主进程探到真实网卡时：留空 / 显式通配 / 空白串都必须兜底成该网卡地址，
  // 而不是返回空串让 executor-node 再回落到同样是 0.0.0.0 的 EXECUTOR_ADDRESS
  // （那会让"兜底"形同虚设，注册仍被 admin 以 reserved 拒绝）。
  assert.strictEqual(
    pickPublicAddress(undefined, '0.0.0.0', 8002, '192.168.1.30'),
    '192.168.1.30:8002',
    '留空 + 通配 host + 探到网卡 → 用网卡兜底',
  );
  assert.strictEqual(
    pickPublicAddress('0.0.0.0:8002', '0.0.0.0', 8002, '192.168.1.30'),
    '192.168.1.30:8002',
    '显式填 0.0.0.0 + 探到网卡 → 同样兜底',
  );
  assert.strictEqual(
    pickPublicAddress('   ', '0.0.0.0', 8002, '192.168.1.30'),
    '192.168.1.30:8002',
    '空白串 + 网卡 → 兜底',
  );
  assert.strictEqual(
    pickPublicAddress('192.168.1.20:9001', '0.0.0.0', 9001, '192.168.1.30'),
    '192.168.1.20:9001',
    '显式真实地址优先于网卡兜底',
  );
  assert.strictEqual(
    pickPublicAddress('127.0.0.1:8002', '0.0.0.0', 8002, '192.168.1.30'),
    '127.0.0.1:8002',
    '显式 loopback 是用户刻意的同机部署选择，不替用户改写',
  );
  // builder 层面：传入 fallbackLanIp 后 EXECUTOR_ADDRESS_PUBLIC 直接是可用地址。
  const withLan = buildExecutorChildEnv({
    appName: 'x', port: 8002, bindAddress: '0.0.0.0', executorHost: '0.0.0.0',
    fallbackLanIp: '192.168.1.30', adminApiUrl: 'http://a', workDir: '/w',
    maxConcurrentTasks: 1, sharedToken: 't',
  });
  assert.strictEqual(
    withLan.EXECUTOR_ADDRESS_PUBLIC,
    '192.168.1.30:8002',
    'builder 必须把网卡兜底真正落进 EXECUTOR_ADDRESS_PUBLIC',
  );

  console.log('[selftest] desktop uv wiring: OK');
  console.log('[selftest] desktop child env contract: OK (BIND_ADDRESS + private-network escape hatch)');
  console.log(`[selftest]   default interpreters dir: ${resolveInterpretersDir('', '/home/u/.config/ACF')}`);
}

main();
