/**
 * G-1（admin-web 深度审查）：executor-mode 的**可注入版本契约**。
 *
 * 背景：min/max/onlineMin/legacyDefault 此前全是前端硬编码常量，注释明言
 * "与后端同值，改动需两侧同步"。而后端 min/max 支持
 * PYTHON_RUNTIME_VERSION_MIN/MAX env 覆盖（admin-api runtime-version.util.ts），
 * legacy 兜底来自 LEGACY_DEFAULT_INTERPRETERS——运维任一侧一改，前端的区间提示
 * 与舰队能力咨询就静默漂移（前端还按旧区间判定，读面误报）。
 *
 * 本文件钉死两件事：
 *  ① 默认值与历史硬编码**逐字一致**（既有调用方零回归）；
 *  ② 注入后端下发值后，所有消费方（normalizeRuntimeVersion /
 *     runtimeVersionIsOfflineTier / interpreterCapabilitySatisfies /
 *     runtimeVersionOptions）确实跟随，而不是继续读硬编码。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureRuntimeVersionConfig,
  resetRuntimeVersionConfig,
  getRuntimeVersionConfig,
  normalizeRuntimeVersion,
  runtimeVersionIsOfflineTier,
  runtimeVersionOptions,
  interpreterCapabilitySatisfies,
} from '../pages/executor-mode';

afterEach(() => {
  // 可注入配置是模块级状态，必须逐用例复位（否则污染同进程其它 spec）
  resetRuntimeVersionConfig();
});

describe('G-1: 默认配置与历史硬编码逐字一致', () => {
  it('defaults are 3.7 / 3.14 / 3.8 / 3.12', () => {
    expect(getRuntimeVersionConfig()).toMatchObject({
      min: '3.7',
      max: '3.14',
      onlineMin: '3.8',
      legacyDefaultInterpreter: '3.12',
    });
  });

  it('normalizeRuntimeVersion keeps the historical 3.7~3.14 bounds', () => {
    expect(normalizeRuntimeVersion('3.7')).toBe('3.7');
    expect(normalizeRuntimeVersion('3.14')).toBe('3.14');
    // 边界外：下界以下 / 上界以上 / 主版本非 3 / 格式非法
    expect(normalizeRuntimeVersion('3.6')).toBeNull();
    expect(normalizeRuntimeVersion('3.15')).toBeNull();
    expect(normalizeRuntimeVersion('4.0')).toBeNull();
    expect(normalizeRuntimeVersion('3')).toBeNull();
  });
});

describe('G-1: 注入后端契约后所有消费方跟随（消除人工同步）', () => {
  it('narrowed range from backend is honored by normalizeRuntimeVersion', () => {
    // 运维把 PYTHON_RUNTIME_VERSION_MIN 调到 3.9、MAX 调到 3.13
    configureRuntimeVersionConfig({ min: '3.9', max: '3.13' });
    expect(normalizeRuntimeVersion('3.8')).toBeNull(); // 旧硬编码会放行 → 漂移误报
    expect(normalizeRuntimeVersion('3.9')).toBe('3.9');
    expect(normalizeRuntimeVersion('3.13')).toBe('3.13');
    expect(normalizeRuntimeVersion('3.14')).toBeNull();
  });

  it('onlineMin injection flips the offline-tier verdict', () => {
    expect(runtimeVersionIsOfflineTier('3.8')).toBe(false);
    // 后端契约变更：在线下界抬到 3.9（uv 能力边界变化）
    configureRuntimeVersionConfig({ onlineMin: '3.9' });
    expect(runtimeVersionIsOfflineTier('3.8')).toBe(true);
    expect(runtimeVersionIsOfflineTier('3.9')).toBe(false);
  });

  it('legacyDefaultInterpreter injection changes the fallback for non-reporting executors', () => {
    // 未上报 interpreters 的旧执行器（null/非数组脏数据）：只按 legacy 兜底版本视为满足
    expect(interpreterCapabilitySatisfies(null, '3.12')).toBe(true);
    expect(interpreterCapabilitySatisfies(null, '3.11')).toBe(false);
    // 后端把 LEGACY_DEFAULT_INTERPRETERS 改为 3.11
    configureRuntimeVersionConfig({ legacyDefaultInterpreter: '3.11' });
    expect(interpreterCapabilitySatisfies(null, '3.11')).toBe(true);
    expect(interpreterCapabilitySatisfies(null, '3.12')).toBe(false);
  });

  it('tier tables are injectable, so the candidate list follows the backend support matrix', () => {
    configureRuntimeVersionConfig({
      tier1: ['3.15'],
      tier2: [],
      tier3: [],
      min: '3.15',
      max: '3.15',
    });
    // Python 3.15 上市后无需改前端代码，只下发新契约
    expect(runtimeVersionOptions().map((o) => o.value)).toEqual(['3.15']);
    expect(normalizeRuntimeVersion('3.15')).toBe('3.15');
  });
});

describe('G-1: 复位与注入语义', () => {
  it('configureRuntimeVersionConfig shallow-merges; reset restores defaults', () => {
    configureRuntimeVersionConfig({ min: '3.10' });
    // 只传 partial：未提及的字段保持当前值
    expect(getRuntimeVersionConfig().max).toBe('3.14');
    expect(getRuntimeVersionConfig().min).toBe('3.10');

    resetRuntimeVersionConfig();
    expect(getRuntimeVersionConfig().min).toBe('3.7');
    expect(getRuntimeVersionConfig().max).toBe('3.14');
  });
});
