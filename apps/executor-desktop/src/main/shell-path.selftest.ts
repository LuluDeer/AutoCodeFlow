/**
 * macOS 登录 shell PATH 解析与合并的自检。
 * Run via: npm run test:main
 *
 * 覆盖的都是「写错了却很难发现」的点——每一条都对应一个具体故障形态：
 *   1. 非 darwin **一次 shell 都不许起**（浪费 + 行为变化，见 shell-path.ts 守卫）；
 *   2. rc 文件横幅必须被哨兵剥离（把横幅当 PATH = 静默污染子进程 env）；
 *   3. 哨兵缺失必须返回 null（**绝不能**退化成 raw stdout 当 PATH）；
 *   4. 失败（非零退出 / 抛异常 / 空 PATH）一律 null，且绝不冒泡到启动链；
 *   5. 合并是 fail-safe：登录 PATH 解析出任何东西，都不得丢掉原有 PATH 条目。
 *
 * 所有用例都注入 exec 桩：本文件**不得**真的起 shell（否则在 CI/Linux 上会
 * 静默走另一条路径，或在 macOS 上执行用户 rc 文件——自检绝不能有副作用）。
 */
import * as assert from 'node:assert';
import {
  augmentedPath,
  mergePathLists,
  parsePathList,
  resolveLoginShellPath,
  type ShellExec,
} from './shell-path';

/**
 * 可计数的 exec 桩。返回固定 stdout/ok，并记录调用次数与参数——「非 darwin
 * 不得调用 exec」这条只能靠计数断言。
 */
function stubExec(result: {
  ok?: boolean;
  stdout?: string;
  throws?: boolean;
}): { exec: ShellExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ShellExec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (result.throws) throw new Error('spawn failed (ENOENT)');
    return { ok: result.ok ?? true, stdout: result.stdout ?? '' };
  };
  return { exec, calls };
}

async function main(): Promise<void> {
  // ---- 1. 非 darwin 短路：返回 null 且 exec 调用 0 次 ----
  //
  // 这条最容易被「顺手统一」写坏：有人可能觉得「解析一下 PATH 总没坏处」而把
  // 平台守卫删掉/放宽。Windows/Linux 的进程本来就继承完整 PATH（从资源管理器、
  // systemd、终端启动都拿得到），在这里跑 `-ilc` 是纯粹的进程开销；更糟的是
  // `-ilc` 会 source 用户 rc，引入与 PATH 无关的副作用与启动延迟。
  // 反证：删掉 resolveLoginShellPath 里的 `if (platform !== 'darwin') return null;`，
  // 本组断言立即失败（calls.length 变 1）。
  for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
    const { exec, calls } = stubExec({ stdout: `${'__ACF_PATH_BEGIN__'}/opt/homebrew/bin${'__ACF_PATH_END__'}` });
    const result = await resolveLoginShellPath({
      platform,
      exec,
      currentPath: '/usr/bin',
    });
    assert.strictEqual(result, null, `${platform} 上必须直接返回 null`);
    assert.strictEqual(
      calls.length,
      0,
      `${platform} 上不得调用 exec（不能起 shell）——实际调用 ${calls.length} 次：${JSON.stringify(calls)}`,
    );
  }

  // ---- 2. 正常路径：横幅与尾部噪音被哨兵剥离 ----
  //
  // 真实场景：用户的 ~/.zshrc 里有 `echo "welcome"` / nvm 提示 / 版本 banner。
  // 期望只取哨兵之间的 PATH，横幅与尾部输出一个字符都不能混进来。
  {
    const stdout =
      'WELCOME BANNER\nnvm: version 0.39.7\n__ACF_PATH_BEGIN__/opt/homebrew/bin:/usr/bin__ACF_PATH_END__\ntrailing';
    const { exec, calls } = stubExec({ stdout });
    const result = await resolveLoginShellPath({ platform: 'darwin', exec });
    assert.strictEqual(
      result,
      '/opt/homebrew/bin:/usr/bin',
      `必须精确剥离横幅与尾部，实际 ${JSON.stringify(result)}`,
    );
    // 顺带钉住命令形态：-ilc（既 source ~/.zprofile 又 source ~/.zshrc）与
    // 哨兵 printf。少了任一标志都会漏掉用户的一段 PATH 配置。
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][1], '-ilc', '必须用 -ilc（交互+登录）');
    assert.ok(
      calls[0][2].includes('__ACF_PATH_BEGIN__') &&
        calls[0][2].includes('__ACF_PATH_END__') &&
        calls[0][2].includes('$PATH'),
      `命令必须哨兵包裹 $PATH，实际 ${calls[0][2]}`,
    );
  }

  // ---- 3. 哨兵缺失 → null（防污染守卫，本文件最重要的一条）----
  //
  // 反证：若实现退化成「找不到哨兵就 return stdout.trim()」，那么 rc 文件打印
  // 一首 ASCII art 或一行 "nvm loaded" 就会被当成 PATH 下发给 executor-node。
  // 那条路径不报错、任务却开始 `command not found`（或更隐蔽地找到错误的
  // 同名可执行文件）——比解析失败难查一个数量级。故哨兵缺失必须判失败。
  for (const stdout of [
    'WELCOME TO MY ZSHRC\n/usr/local/bin:/usr/bin\n', // 纯横幅，无哨兵
    '__ACF_PATH_BEGIN__/usr/bin', // 只有 BEGIN，END 丢失（输出被截断）
    '', // 完全空输出
  ]) {
    const { exec } = stubExec({ stdout });
    const result = await resolveLoginShellPath({ platform: 'darwin', exec });
    assert.strictEqual(
      result,
      null,
      `哨兵不完整时必须返回 null，绝不能把原始 stdout 当 PATH：${JSON.stringify(stdout)}`,
    );
  }

  // ---- 4. exec 失败（非零退出/超时）→ null ----
  {
    const { exec } = stubExec({ ok: false, stdout: '__ACF_PATH_BEGIN__/usr/bin__ACF_PATH_END__' });
    assert.strictEqual(
      await resolveLoginShellPath({ platform: 'darwin', exec }),
      null,
      'ok:false 必须返回 null（即便 stdout 里正好有哨兵——非零退出的输出不可信）',
    );
  }

  // ---- 5. exec 抛异常 → null 且不冒泡 ----
  //
  // 这是 fail-open 的核心：shell 不存在（用户改了 SHELL 指向坏路径）、fork
  // 失败、被安全软件拦截——任何一个都不允许把 ExecutorProcess.start() 打断。
  {
    const { exec } = stubExec({ throws: true });
    const result = await resolveLoginShellPath({ platform: 'darwin', exec });
    assert.strictEqual(result, null, 'exec 抛异常必须被吞掉并返回 null，绝不冒泡到启动链');
  }

  // ---- 6. 哨兵之间为空 → null ----
  //
  // rc 文件里 `unset PATH` 或在不干净的登录环境里 PATH 为空时，printf 会输出
  // 两个紧邻的哨兵。下发空 PATH 会让子进程连 /bin 都找不到——比不改更糟。
  {
    for (const stdout of [
      '__ACF_PATH_BEGIN____ACF_PATH_END__',
      '__ACF_PATH_BEGIN__   __ACF_PATH_END__',
      '__ACF_PATH_BEGIN__::__ACF_PATH_END__', // 只有空条目
    ]) {
      const { exec } = stubExec({ stdout });
      assert.strictEqual(
        await resolveLoginShellPath({ platform: 'darwin', exec }),
        null,
        `哨兵之间为空/只有空条目时必须返回 null：${JSON.stringify(stdout)}`,
      );
    }
  }

  // ---- 7. parsePathList：去空、trim、保序去重、平台分隔符 ----
  {
    // 保序去重：第一次出现的 /usr/bin 留在原位，后面的重复项被丢弃。
    assert.deepStrictEqual(
      parsePathList('/a:/b:/a:/c:/b', 'darwin'),
      ['/a', '/b', '/c'],
      '重复条目必须保序去重（第一次出现的位置胜出）',
    );
    // trim + 去空：连续分隔符/首尾分隔符产生的空条目必须丢弃
    // （空条目在 PATH 查找语义里可能被解释为当前目录）。
    assert.deepStrictEqual(
      parsePathList('  /a  :: /b :  ', 'linux'),
      ['/a', '/b'],
      '条目必须 trim，空条目必须丢弃',
    );
    // 平台分隔符：win32 用 ';'，posix 用 ':'。以 Linux 上跑自检为前提，
    // 这条专门防「按运行平台而不是目标平台取分隔符」的写法。
    assert.deepStrictEqual(
      parsePathList('C:\\a;C:\\b', 'win32'),
      ['C:\\a', 'C:\\b'],
      'win32 必须按 ; 切分',
    );
    // 非 win32 上 ';' 不是分隔符（不得按运行平台猜）。刻意用不含 ':' 的串，
    // 否则 posix 会按 ':' 切出恰好看着像结果的碎片，断言反而失去鉴别力。
    assert.deepStrictEqual(
      parsePathList('/a;/b', 'linux'),
      ['/a;/b'],
      '非 win32 上 ; 不是分隔符（不得按运行平台猜）',
    );
    // 非字符串输入按空表处理，不抛。
    for (const bad of [null, undefined, 0 as any, {} as any]) {
      assert.deepStrictEqual(
        parsePathList(bad as string, 'linux'),
        [],
        `非字符串输入必须返回空表：${JSON.stringify(bad)}`,
      );
    }
  }

  // ---- 8. mergePathLists：preferred 在前、去重、绝不丢 existing ----
  {
    // preferred 在前，existing 中未出现过的随后。
    assert.strictEqual(
      mergePathLists('/brew/bin:/usr/bin', '/usr/bin:/bin', 'darwin'),
      '/brew/bin:/usr/bin:/bin',
      'preferred 条目在前，existing 未出现的条目追加在后',
    );
    // fail-safe：preferred 为 null/空时，existing 必须逐字保留。
    // 这是整条链路的兜底——登录 shell 解析出任何东西（包括空），
    // 进程原本能跑的命令都不得因此变得不能跑。
    assert.strictEqual(
      mergePathLists(null, '/usr/bin:/bin', 'darwin'),
      '/usr/bin:/bin',
      'preferred 为 null 时绝不能丢 existing（fail-safe）',
    );
    assert.strictEqual(
      mergePathLists('', '/usr/bin:/bin', 'darwin'),
      '/usr/bin:/bin',
      'preferred 为空串时绝不能丢 existing',
    );
    assert.strictEqual(
      mergePathLists(undefined, undefined, 'darwin'),
      '',
      '两边都缺省时返回空串',
    );
    // win32 用 ';' 拼接（自检在 Linux 上跑，专门防按运行平台取分隔符）。
    assert.strictEqual(
      mergePathLists('C:\\brew', 'C:\\Windows', 'win32'),
      'C:\\brew;C:\\Windows',
      'win32 必须用 ; 拼接',
    );
  }

  // ---- 9. augmentedPath：无需变更时 undefined，需要时返回合并值 ----
  {
    // 登录 PATH 完全被现有 PATH 覆盖 → 无新增 → undefined（不制造无谓 env churn）。
    {
      const { exec } = stubExec({
        stdout: '__ACF_PATH_BEGIN__/usr/bin__ACF_PATH_END__',
      });
      const result = await augmentedPath({
        platform: 'darwin',
        exec,
        currentPath: '/usr/bin:/bin',
      });
      assert.strictEqual(
        result,
        undefined,
        '登录 PATH 未带来新条目时必须返回 undefined（不改 env）',
      );
    }

    // 登录 PATH 带来新条目 → 前置合并（Homebrew 必须排在 /usr/bin 前）。
    {
      const { exec } = stubExec({
        stdout: '__ACF_PATH_BEGIN__/opt/homebrew/bin__ACF_PATH_END__',
      });
      const result = await augmentedPath({
        platform: 'darwin',
        exec,
        currentPath: '/usr/bin:/bin',
      });
      assert.strictEqual(
        result,
        '/opt/homebrew/bin:/usr/bin:/bin',
        '新增条目必须前置，且原有条目一个不少',
      );
    }

    // 非 darwin：解析直接 null → undefined（调用方完全不用分平台判断）。
    {
      const { exec, calls } = stubExec({ stdout: '__ACF_PATH_BEGIN__/brew__ACF_PATH_END__' });
      const result = await augmentedPath({
        platform: 'linux',
        exec,
        currentPath: '/usr/bin',
      });
      assert.strictEqual(result, undefined, '非 darwin 上 augmentedPath 必须是 undefined');
      assert.strictEqual(calls.length, 0, '非 darwin 上不得起 shell');
    }
  }

  // ---- 10. 默认 exec 未被本自检触达 ----
  //
  // 本文件所有用例都注入了 exec 桩。上面各条已分别断言调用次数，这里再统一
  // 说明：任何一处漏注入都会在 Linux CI 上「碰巧」返回 null 而测试仍绿——
  // 那等于没测。故把「桩是唯一执行器」当作纪律写进注释：新增用例必须注入 exec。
  console.log('[selftest] shell path: OK (darwin login-shell PATH, sentinel-guarded)');
  console.log('[selftest] shell path merge: OK (fail-safe, never drops existing entries)');
}

main().catch((err) => {
  // main 标了 async：必须显式收敛 rejection，否则断言失败会变成 unhandled
  // rejection——node 可能以 0 退出，CI 静默放行一个坏实现。
  console.error(err);
  process.exit(1);
});
