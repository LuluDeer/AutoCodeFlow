import { describe, it, expect } from 'vitest';
import {
  CONTROL_PLANE_MIN_PROTOCOL,
  isControlPlaneAvailable,
  isControlPlaneUnavailable,
} from '../utils/control-plane';

/**
 * ARCH-33（ADR-016）：pull 控制面可用性判据。
 *
 * 这个判据取代了 UI-18 的 `dispatchMode === 'pull'`。它必须是**合取**
 * （pull 且 协议<2），只看任一项都会错：
 *   - 只看 pull  → 误伤协议 v2 的 pull 执行器（把新能力白做）；
 *   - 只看协议   → 误伤 push 的 v1 执行器（它们走 HTTP，本来就能热更新）。
 */
describe('isControlPlaneUnavailable (ARCH-33)', () => {
  it('门禁常量与 admin-api PROTOCOL_CONTROL_PLANE_MIN 同值', () => {
    expect(CONTROL_PLANE_MIN_PROTOCOL).toBe(2);
  });

  it('push 执行器恒可用（走 HTTP，与协议版本无关）', () => {
    expect(isControlPlaneUnavailable({ dispatchMode: 'push' })).toBe(false);
    expect(isControlPlaneUnavailable({ dispatchMode: 'push', protocolVersion: 1 })).toBe(false);
    expect(isControlPlaneUnavailable({ dispatchMode: 'push', protocolVersion: 2 })).toBe(false);
    // dispatchMode 缺省 = push（旧快照兼容）
    expect(isControlPlaneUnavailable({})).toBe(false);
    expect(isControlPlaneUnavailable({ protocolVersion: 1 })).toBe(false);
  });

  it('pull + 协议 v2：可用（ADR-016 的控制面 pull 通道）', () => {
    expect(isControlPlaneUnavailable({ dispatchMode: 'pull', protocolVersion: 2 })).toBe(false);
    expect(isControlPlaneUnavailable({ dispatchMode: 'pull', protocolVersion: 3 })).toBe(false);
  });

  it('pull + 协议 v1：不可用（会静默忽略 commands）', () => {
    expect(isControlPlaneUnavailable({ dispatchMode: 'pull', protocolVersion: 1 })).toBe(true);
  });

  it('pull + 未上报版本：不可用——兜底方向是「不支持」', () => {
    // 与 versionCompliant 的兜底方向**刻意相反**：那个缺省 true（不得剔除
    // 旧执行器），这个缺省 false（不向不认识的执行器发新语义字段）。
    // 抄错方向 = 全部存量执行器被误判可用 → 静默丢命令。
    expect(isControlPlaneUnavailable({ dispatchMode: 'pull' })).toBe(true);
    expect(isControlPlaneUnavailable({ dispatchMode: 'pull', protocolVersion: null })).toBe(true);
    expect(isControlPlaneUnavailable({ dispatchMode: 'pull', protocolVersion: undefined })).toBe(true);
  });

  it('pull + 非整数版本：不可用（防脏数据穿透）', () => {
    expect(
      isControlPlaneUnavailable({ dispatchMode: 'pull', protocolVersion: 2.5 }),
    ).toBe(true);
    expect(
      isControlPlaneUnavailable({
        dispatchMode: 'pull',
        protocolVersion: '2' as unknown as number,
      }),
    ).toBe(true);
    expect(
      isControlPlaneUnavailable({ dispatchMode: 'pull', protocolVersion: NaN }),
    ).toBe(true);
  });

  it('isControlPlaneAvailable 是严格取反', () => {
    const cases = [
      { dispatchMode: 'push' as const },
      { dispatchMode: 'push' as const, protocolVersion: 1 },
      { dispatchMode: 'pull' as const, protocolVersion: 1 },
      { dispatchMode: 'pull' as const, protocolVersion: 2 },
      { dispatchMode: 'pull' as const },
    ];
    for (const c of cases) {
      expect(isControlPlaneAvailable(c)).toBe(!isControlPlaneUnavailable(c));
    }
  });
});
