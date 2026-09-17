/**
 * 回归（P2-4）：任务表单的解释器能力**读面咨询**判据。
 *
 * 背景：执行器心跳上报 interpreters 缓存池清单（后端 findAll 一直返回），
 * 但前端读模型长期没声明该字段，用户声明 Python 版本时无法知道在线舰队里
 * 有没有执行器能接。后端**刻意**不做舰队级写前预检（AC-06c「解释器先下载
 * 后有」，在线层执行时可按需下载），所以这是且只能是一条非阻断提示。
 *
 * 判据必须与 admin-api `interpreter-match.util` 逐条对齐（前端无法 import
 * 后端，同判据复制一份，本测试钉死漂移）：
 *  - 点安全前缀（3.13.0 不满足 3.1）；
 *  - available===false 的项永不满足；
 *  - 未上报(null/undefined) 的旧执行器按 3.12 兜底；
 *  - []（已上报且池空）不兜底，任何声明版本都不满足；
 *  - 舰队里没有在线执行器时返回 unknown（不提示，避免列表未加载时误报）。
 */
import { describe, expect, it } from 'vitest';
import {
  interpreterCapabilitySatisfies,
  interpreterFleetAdvisory,
  matchesInterpreterVersion,
} from '../pages/executor-mode';

const online = (
  interpreters: Parameters<typeof interpreterCapabilitySatisfies>[0],
) => ({ status: 'online', interpreters });
const offline = (
  interpreters: Parameters<typeof interpreterCapabilitySatisfies>[0],
) => ({ status: 'offline', interpreters });

describe('matchesInterpreterVersion（点安全前缀）', () => {
  it('相等或「请求版本.」前缀才命中', () => {
    expect(matchesInterpreterVersion('3.7.9', '3.7')).toBe(true);
    expect(matchesInterpreterVersion('3.7', '3.7')).toBe(true);
    // 点安全：3.13.0 不得满足 3.1
    expect(matchesInterpreterVersion('3.13.0', '3.1')).toBe(false);
    expect(matchesInterpreterVersion('3.12.3', '3.7')).toBe(false);
  });

  it('非字符串入参不命中（上报面不可信，不抛错）', () => {
    expect(matchesInterpreterVersion(null, '3.7')).toBe(false);
    expect(matchesInterpreterVersion(123, '3.7')).toBe(false);
  });
});

describe('interpreterCapabilitySatisfies（单台执行器）', () => {
  it('未声明版本恒满足（存量任务不拦截）', () => {
    expect(interpreterCapabilitySatisfies([], null)).toBe(true);
    expect(interpreterCapabilitySatisfies([], undefined)).toBe(true);
    expect(interpreterCapabilitySatisfies([], '  ')).toBe(true);
  });

  it('命中点安全前缀即满足；available===false 的项永不满足', () => {
    expect(interpreterCapabilitySatisfies([{ version: '3.7.9' }], '3.7')).toBe(true);
    expect(
      interpreterCapabilitySatisfies([{ version: '3.7.9', available: false }], '3.7'),
    ).toBe(false);
    expect(
      interpreterCapabilitySatisfies(
        [
          { version: '3.7.9', available: false },
          { version: '3.7.11', available: true },
        ],
        '3.7',
      ),
    ).toBe(true);
  });

  it('未上报（null/undefined）的旧执行器按 3.12 兜底，其余版本不满足', () => {
    expect(interpreterCapabilitySatisfies(null, '3.12')).toBe(true);
    expect(interpreterCapabilitySatisfies(undefined, '3.12')).toBe(true);
    expect(interpreterCapabilitySatisfies(null, '3.7')).toBe(false);
  });

  it('[]（已上报且池空）不兜底：任何声明版本都不满足', () => {
    expect(interpreterCapabilitySatisfies([], '3.12')).toBe(false);
    expect(interpreterCapabilitySatisfies([], '3.7')).toBe(false);
  });

  it('脏项被跳过而非整池放行/抛错', () => {
    const dirty = [
      null,
      { version: 123 },
      { version: '3.7.9' },
    ] as unknown as Parameters<typeof interpreterCapabilitySatisfies>[0];
    expect(interpreterCapabilitySatisfies(dirty, '3.7')).toBe(true);
    expect(interpreterCapabilitySatisfies(dirty, '3.9')).toBe(false);
  });
});

describe('interpreterFleetAdvisory（舰队级咨询）', () => {
  it('未声明版本 → satisfied（不提示）', () => {
    expect(interpreterFleetAdvisory([online([])], null)).toBe('satisfied');
  });

  it('有在线执行器满足 → satisfied', () => {
    expect(
      interpreterFleetAdvisory([online([{ version: '3.12.13' }])], '3.12'),
    ).toBe('satisfied');
  });

  it('在线执行器无一台满足 → unsatisfied（提示，但不阻断）', () => {
    expect(
      interpreterFleetAdvisory(
        [online([{ version: '3.12.13' }]), online([{ version: '3.11.9' }])],
        '3.7',
      ),
    ).toBe('unsatisfied');
    // 全部在线但池空（[]）也是 unsatisfied
    expect(interpreterFleetAdvisory([online([])], '3.7')).toBe('unsatisfied');
  });

  it('没有在线执行器 / 列表未加载 → unknown（不提示，避免误报）', () => {
    expect(interpreterFleetAdvisory([], '3.7')).toBe('unknown');
    expect(interpreterFleetAdvisory(null, '3.7')).toBe('unknown');
    // 离线执行器不满足也算 unknown——它可能只是暂时下线
    expect(
      interpreterFleetAdvisory([offline([{ version: '3.12.13' }])], '3.7'),
      'unknown',
    );
  });

  it('混合舰队：只要一台在线满足即 satisfied；旧执行器对 3.12 兜底', () => {
    expect(
      interpreterFleetAdvisory(
        [offline([{ version: '3.7.9' }]), online(null)],
        '3.12',
      ),
    ).toBe('satisfied');
    expect(
      interpreterFleetAdvisory(
        [offline([{ version: '3.7.9' }]), online(null)],
        '3.7',
      ),
    ).toBe('unsatisfied');
  });
});
