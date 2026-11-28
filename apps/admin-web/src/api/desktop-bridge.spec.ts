import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as bridgeModule from './desktop-bridge';
import { getDesktopBridge, type DesktopBridge } from './desktop-bridge';

/**
 * 桌面桥退役三通道后的唯一消费面：五个方法缺一不可。
 * 顺序刻意与接口声明顺序不同，避免有人把「声明顺序」当成契约。
 */
const REQUIRED = [
  'getDesktopContext',
  'cancelAgentAssignment',
  'pickLocalFiles',
  'getRecentAgentEvents',
  'onAgentEvent',
] as const;

/** 已从桌面桥退役、admin-web 不得重新依赖的三条通道。 */
const RETIRED = ['getUrl', 'navigate', 'close'] as const;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type WorkbenchApi = Record<string, unknown>;
type WorkbenchWindow = Window & { workbenchApi?: unknown };

function makeCompleteBridge(): WorkbenchApi {
  return {
    getDesktopContext: async () => ({}),
    cancelAgentAssignment: async () => ({ ok: true }),
    pickLocalFiles: async () => [],
    getRecentAgentEvents: async () => [],
    onAgentEvent: () => () => {},
  };
}

function setWorkbenchApi(api: WorkbenchApi | undefined): void {
  const w = window as WorkbenchWindow;
  if (api === undefined) delete w.workbenchApi;
  else w.workbenchApi = api;
}

afterEach(() => {
  setWorkbenchApi(undefined);
});

describe('getDesktopBridge: runtime guard for the five required methods', () => {
  it('returns non-null when all five are present and every key is a function', () => {
    setWorkbenchApi(makeCompleteBridge());
    const bridge = getDesktopBridge();
    expect(bridge).not.toBeNull();
    for (const key of REQUIRED) {
      expect(typeof bridge?.[key]).toBe('function');
    }
  });

  for (const missing of REQUIRED) {
    it(`returns null after removing ${missing}`, () => {
      const api = makeCompleteBridge();
      delete api[missing];
      setWorkbenchApi(api);
      expect(getDesktopBridge()).toBeNull();
    });
  }

  it('returns null when no bridge is injected or a non-object is injected', () => {
    setWorkbenchApi(undefined);
    expect(getDesktopBridge()).toBeNull();

    (window as WorkbenchWindow).workbenchApi = 'not-a-bridge';
    expect(getDesktopBridge()).toBeNull();
  });
});

describe('retired channels counter-evidence', () => {
  it('type level: DesktopBridge keys exactly equal REQUIRED', () => {
    // 值级赋值触发编译期比较：键集合多/少/改名时此处即报错（vitest 侧恒为 true）。
    const exact: Equal<keyof DesktopBridge, (typeof REQUIRED)[number]> = true;
    expect(exact).toBe(true);
  });

  it('runtime module export surface excludes retired methods', () => {
    for (const name of RETIRED) {
      expect(name in bridgeModule).toBe(false);
    }
  });

  it('retired names occur zero times in source text', () => {
    const candidates = [
      resolve(process.cwd(), 'src/api/desktop-bridge.ts'),
      resolve(process.cwd(), 'apps/admin-web/src/api/desktop-bridge.ts'),
    ];
    const sourcePath = candidates.find((candidate) => existsSync(candidate));
    expect(sourcePath).toBeDefined();
    const source = readFileSync(sourcePath!, 'utf8');
    for (const name of RETIRED) {
      expect(source).not.toContain(name);
    }
  });
});
