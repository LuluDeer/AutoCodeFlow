/**
 * R279：「多久判离线」的前端口径（契约层纯函数）。
 *
 * ## 钉住的缺陷
 *
 * 详情页离线 Alert 曾用 `heartbeatTimeoutMs`（单次墙钟，默认 90s）渲染判死窗口，
 * 而后端真实判死是**两段式**：连续 `staleOfflineConfirmations`（默认 2）轮未确认
 * 才 ONLINE→OFFLINE ⇒ 真实窗口 `effectiveOfflineAfterMs` = 90s × 2 = 180s。
 * UI 报 90s ⇒ 运维把「90 秒了还显示在线」当后端 bug 报障、按 90s 估 SLA 偏小一半。
 *
 * ## 夹具与真机同源
 *
 * 下列 `REAL_RUNTIME_CONFIG` 逐字来自真机
 * `GET http://127.0.0.1:3106/api/executors/runtime-config`（HTTP 200）：
 * `{"heartbeatIntervalMs":30000,"heartbeatTimeoutMultiplier":3,
 *   "heartbeatTimeoutMs":90000,"staleOfflineConfirmations":2,
 *   "effectiveOfflineAfterMs":180000,"listLimit":500,"executorTotal":0}`
 *
 * ## 为什么不许「缺字段就回落 90s」
 *
 * 旧后端/旧缓存没有 `effectiveOfflineAfterMs` 时，静默回落单次墙钟正好复现本缺陷。
 * 正确做法是用同一算式折算：`heartbeatTimeoutMs × (staleOfflineConfirmations ?? 1)`。
 */
import { describe, it, expect } from 'vitest';
import {
  describeOfflineWindow,
  resolveEffectiveOfflineAfterMs,
  type ExecutorRuntimeConfig,
} from '../api/executors';
import { HEARTBEAT_TIMEOUT_FALLBACK_MS } from '../utils/executorLiveness';

/** 真机响应逐字复制（见文件头）。 */
const REAL_RUNTIME_CONFIG: ExecutorRuntimeConfig = {
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMultiplier: 3,
  heartbeatTimeoutMs: 90_000,
  staleOfflineConfirmations: 2,
  effectiveOfflineAfterMs: 180_000,
  listLimit: 500,
  executorTotal: 0,
};

describe('R279: 判死窗口以 effectiveOfflineAfterMs 为准（不是单次墙钟）', () => {
  it('真机响应 ⇒ 180000ms / 180 秒 / 连续 2 轮确认；单次墙钟 90 秒只作对照', () => {
    const view = describeOfflineWindow(REAL_RUNTIME_CONFIG);
    expect(view.windowMs).toBe(180_000);
    expect(view.windowSeconds).toBe(180);
    expect(view.confirmations).toBe(2);
    expect(view.singleTimeoutSeconds).toBe(90);
    // 反证：拿单次墙钟当判死窗口的那版实现会得到 90（正是被修的缺陷）
    expect(Math.round(REAL_RUNTIME_CONFIG.heartbeatTimeoutMs / 1000)).toBe(90);
  });

  it('后端下发值优先于算式：effectiveOfflineAfterMs 与 墙钟×轮数 不一致时信后端', () => {
    // 后端若把扫描周期也算进窗口（+1 个周期），前端不得用算式「纠正」它。
    expect(
      resolveEffectiveOfflineAfterMs({ ...REAL_RUNTIME_CONFIG, effectiveOfflineAfterMs: 210_000 }),
    ).toBe(210_000);
  });

  it('缺 effectiveOfflineAfterMs（旧后端/旧缓存）⇒ 折算 90s × 2 = 180s，绝不回落 90s', () => {
    const legacy: Partial<ExecutorRuntimeConfig> = {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMultiplier: 3,
      heartbeatTimeoutMs: 90_000,
      staleOfflineConfirmations: 2,
      listLimit: 500,
      executorTotal: 0,
    };
    expect(resolveEffectiveOfflineAfterMs(legacy)).toBe(180_000);
    expect(describeOfflineWindow(legacy).windowSeconds).toBe(180);
  });

  it('连 staleOfflineConfirmations 也缺 ⇒ 按 1 折算（后端该值为 1 即「单轮判死」回滚开关）', () => {
    expect(resolveEffectiveOfflineAfterMs({ heartbeatTimeoutMs: 90_000 })).toBe(90_000);
  });

  it('整份配置不可达（端点失败/首帧未加载）⇒ 后端缺省 90s × 2 = 180s，不是 90s', () => {
    expect(resolveEffectiveOfflineAfterMs(undefined)).toBe(
      HEARTBEAT_TIMEOUT_FALLBACK_MS * 2,
    );
    expect(resolveEffectiveOfflineAfterMs(null)).toBe(180_000);
    expect(describeOfflineWindow(undefined).windowSeconds).toBe(180);
  });

  it('配置被调大时窗口随之变化（3 轮 ⇒ 270 秒），迟滞轮数同步自洽', () => {
    const view = describeOfflineWindow({
      ...REAL_RUNTIME_CONFIG,
      staleOfflineConfirmations: 3,
      effectiveOfflineAfterMs: 270_000,
    });
    expect(view.windowSeconds).toBe(270);
    expect(view.confirmations).toBe(3);
  });

  it('非法值（0 / 负数 / NaN）不得被当成有效窗口，走折算路径', () => {
    expect(resolveEffectiveOfflineAfterMs({ ...REAL_RUNTIME_CONFIG, effectiveOfflineAfterMs: 0 }))
      .toBe(180_000);
    expect(resolveEffectiveOfflineAfterMs({ ...REAL_RUNTIME_CONFIG, effectiveOfflineAfterMs: Number.NaN }))
      .toBe(180_000);
    // 轮数非法（<1 / NaN）按 1 折算，且窗口不会算出 0 或负数
    expect(resolveEffectiveOfflineAfterMs({
      heartbeatTimeoutMs: 90_000,
      staleOfflineConfirmations: 0,
    })).toBe(90_000);
  });
});