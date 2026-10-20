/**
 * R105：破坏性 IPC 通道的主进程二次确认。
 *
 * 钉三件事：
 *  ① **策略表**：需要确认的通道恰好是那 4 个（不可逆/外发型），可恢复的 `executor:start|stop` 不在内；
 *  ② **fail-closed**：确认函数返回 false / 抛错 / 缺失 / 通道未登记 ⇒ 一律不执行；
 *  ③ **接线钉子**：`ipc-handlers.ts` 里每个登记通道的 handler 体内必须出现 `confirmDestructive('<通道>'`。
 *     没有这条，策略表写得再对也可能**没有一个调用点**（本仓已踩过：`get_zip_limits_from_env` 存在、
 *     有测试、文档也写会生效，但生产路径从不调用 ⇒ 部署方收紧后静默失效）。
 */
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  CONFIRM_CANCELED,
  DESTRUCTIVE_CHANNELS,
  confirmDestructive,
} from './destructive-actions';

const EXPECTED = [
  'apps:delete-release',
  'apps:uninstall',
  'history:clear',
  'updater:install',
] as const;

async function main(): Promise<void> {
  // ① 策略表
  assert.deepEqual(
    Object.keys(DESTRUCTIVE_CHANNELS).sort(),
    [...EXPECTED].sort(),
    '策略表必须恰好覆盖这 4 个不可逆通道（新增通道时同时更新本断言）',
  );
  for (const channel of EXPECTED) {
    const policy = DESTRUCTIVE_CHANNELS[channel];
    assert.ok(policy.label.length > 0, `${channel} 缺 label`);
    assert.ok(policy.detail.length > 0, `${channel} 缺 detail（用户要知道后果）`);
  }
  // 可恢复动作不该在这里 —— 多问一次会变成「确认疲劳」，反而降低真实确认的注意力。
  assert.ok(!('executor:stop' in DESTRUCTIVE_CHANNELS), 'executor:stop 可恢复，不应要求原生确认');

  // ② fail-closed 矩阵
  const yes = async () => true;
  const no = async () => false;
  const boom = async () => {
    throw new Error('dialog failed');
  };
  assert.equal(await confirmDestructive('apps:uninstall', yes), true);
  assert.equal(await confirmDestructive('apps:uninstall', no), false);
  assert.equal(await confirmDestructive('apps:uninstall', boom), false, '确认函数抛错必须不放行');
  assert.equal(await confirmDestructive('apps:uninstall', null), false, '缺确认函数必须不放行');
  assert.equal(await confirmDestructive('apps:uninstall', undefined), false);
  // 非严格 true（例如 'yes' / 1 / truthy 对象）一律拒绝
  const truthyButNotTrue = (async () => 1) as unknown as () => Promise<boolean>;
  assert.equal(await confirmDestructive('updater:install', truthyButNotTrue as never), false);
  // 未登记通道
  assert.equal(
    await confirmDestructive('not:a-channel' as never, yes as never),
    false,
    '未登记通道必须 fail-closed',
  );

  // 取消回执形态（渲染层无需为「取消」写新分支）
  assert.deepEqual(CONFIRM_CANCELED, { ok: false, canceled: true });

  // ③ 接线钉子：源码里每个通道都必须被真正调用
  // 编译产物在 dist-selftest/ 下（与源树 src/main 不同层），所以路径要**逐个候选试**，
  // 全都找不到就**直接失败**。
  //
  // 这一条是反证逼出来的：初版写成 `path.join(__dirname, '..', 'ipc-handlers.ts')` +
  // `if (existsSync)`，而 dist-selftest 下该路径不存在 ⇒ 整段接线检查被**静默跳过**，
  // 撤掉 apps:uninstall 的确认调用后 selftest 依然全绿。
  // **一条会静默跳过的接线钉子，比没有更糟** —— 它给出「已检查」的错觉。
  const candidates = [
    path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts'),
    path.join(__dirname, '..', '..', 'src', 'main', 'ipc-handlers.ts'),
    path.join(__dirname, 'ipc-handlers.ts'),
  ];
  const handlersPath = candidates.find((p) => fs.existsSync(p));
  assert.ok(
    handlersPath,
    '找不到 ipc-handlers.ts（候选全不存在）—— 接线检查无法进行，按失败处理',
  );
  const src = fs.readFileSync(handlersPath!, 'utf8');
  for (const channel of EXPECTED) {
    assert.ok(
      src.includes(`confirmDestructive('${channel}'`),
      `ipc-handlers.ts 里没有对 ${channel} 的确认调用 —— 策略表再对也没生效`,
    );
  }

  console.log('destructive-actions selftest: all assertions passed (policy matrix + fail-closed + wiring nails)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
