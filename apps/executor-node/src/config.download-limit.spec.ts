/**
 * 2026-10-24 安全审计轮登记缺陷的回归钉（executor-node 侧）：
 * PACKAGE_DOWNLOAD_MAX_BYTES 的裸 parseInt 解析——
 *  · 非数字（"abc"/"1.5"）→ NaN，下载链体积闸 bytes > maxBytes 与 NaN
 *    比较恒 false = **静默解除上限**（最危险方向：畸形 env 反而放开闸门）；
 *  · 0/负数 → 恒 true = 一切下载立即失败。
 * 两者都必须回落 200MB 默认（parsePositiveIntEnv），非法值不得改变安全
 * 闸的行为方向。config 是模块加载时求值的对象字面量，用 jest.isolateModules
 * 重建模块逐 env 断言。
 */
import { config } from './config';

const DEFAULT = 200 * 1024 * 1024;

function loadConfigWith(envValue: string | undefined): { packageDownloadMaxBytes: number } {
  const prev = process.env.PACKAGE_DOWNLOAD_MAX_BYTES;
  if (envValue === undefined) delete process.env.PACKAGE_DOWNLOAD_MAX_BYTES;
  else process.env.PACKAGE_DOWNLOAD_MAX_BYTES = envValue;
  let cfg: { packageDownloadMaxBytes: number } | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- config 是加载期求值对象，必须重建模块
    cfg = require('./config').config;
  });
  if (prev === undefined) delete process.env.PACKAGE_DOWNLOAD_MAX_BYTES;
  else process.env.PACKAGE_DOWNLOAD_MAX_BYTES = prev;
  return cfg!;
}

describe('PACKAGE_DOWNLOAD_MAX_BYTES 解析（安全审计轮收口）', () => {
  const ORIGINAL = process.env.PACKAGE_DOWNLOAD_MAX_BYTES;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PACKAGE_DOWNLOAD_MAX_BYTES;
    else process.env.PACKAGE_DOWNLOAD_MAX_BYTES = ORIGINAL;
  });

  it('缺省 = 200MB（行为零漂移）', () => {
    expect(loadConfigWith(undefined).packageDownloadMaxBytes).toBe(DEFAULT);
  });

  it('合法正整数覆盖生效（静态导入的 config 同样吃默认值——模块级快照）', () => {
    expect(config.packageDownloadMaxBytes).toBe(DEFAULT);
    expect(loadConfigWith('1024').packageDownloadMaxBytes).toBe(1024);
  });

  it.each(['abc', '1.5', '  ', '0', '-5'])(
    '非法值 %j 回落默认（不静默解除上限、不全拒下载）',
    (bad) => {
      expect(loadConfigWith(bad).packageDownloadMaxBytes).toBe(DEFAULT);
    },
  );

  it('缺陷方向反证：NaN 使 bytes > maxBytes 恒 false', () => {
    // 机制说明（修复前的危险形态）：NaN 比较恒 false = 任何体积都过闸。
    const nanLimit = parseInt('abc', 10);
    expect(Number.isNaN(nanLimit)).toBe(true);
    expect(999_999_999_999 > nanLimit).toBe(false);
  });
});
