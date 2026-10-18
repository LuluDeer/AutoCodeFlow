/**
 * DRAFT-01：useDraft 表单草稿 hook（jsdom localStorage）。
 *
 * 覆盖点（每条都对应一个真实故障形态，不是"函数被调用了"式弱断言）：
 *  1) 落盘：值变化经防抖写入，信封含 version/savedAt/data；
 *  2) 恢复：挂载时**同步**读到草稿（惰性初始化，无"先空渲染再闪现"）；
 *  3) 防抖：delay 窗口内的连续改动只落盘一次（localStorage 是同步 API，
 *     逐键写会卡输入）；
 *  4) 清除：discard 删存储，且**取消挂起的防抖写入**——否则点完"丢弃草稿"
 *     800ms 后草稿又复活；
 *  5) 版本隔离：schema 版本不符的旧草稿整体丢弃（不尝试兼容半份旧数据）；
 *  6) 作用域隔离：不同 scope 的 key 互不覆盖（A 任务草稿不进 B 任务表单）；
 *  7) quota/隐私模式容错：setItem 抛错 → 不冒泡，降级标记 unavailable；
 *  8) 卸载 flush：防抖未到期就卸载，改动仍然落盘；
 *  9) enabled=false 不写；key=null 完全惰性；
 * 10) SSR/无 storage 安全：window.localStorage 访问抛错也不炸。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  DRAFT_SCHEMA_VERSION,
  draftKey,
  parseDraft,
  readDraft,
  removeDraft,
  useDraft,
  writeDraft,
  type DraftEnvelope,
} from '../hooks/useDraft';

const KEY = draftKey('taskform.draft', 1, 'new');
const DELAY = 20;

/**
 * 真实等待防抖（fake timers 与 localStorage 组合易踩 React act 边界）。
 * 用 `act` 包裹：防抖到点后 hook 内部会 setSavedAt/setUnavailable，
 * 裸 setTimeout 等待会让这些更新落在 act 之外（React 会打 act 警告）。
 */
const wait = (ms: number) =>
  act(async () => {
    await new Promise<void>((r) => setTimeout(r, ms));
  });

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('draftKey：版本化 + 作用域', () => {
  it('拼出版本段；无作用域时只有版本段', () => {
    expect(draftKey('taskform')).toBe(`taskform:v${DRAFT_SCHEMA_VERSION}`);
    expect(draftKey('taskform', 7)).toBe('taskform:v7');
  });

  it('作用域段用 :: 分隔，多段按序拼接，空段被剔除', () => {
    expect(draftKey('ns', 1, 'new')).toBe('ns:v1::new');
    expect(draftKey('ns', 1, ['edit', 'task-1'])).toBe('ns:v1::edit::task-1');
    // 空串/undefined 段被剔除（编辑态 id 尚未就绪时不该产生 `ns:v1::` 这种 key）
    expect(draftKey('ns', 1, ['edit', '', 'task-1'])).toBe('ns:v1::edit::task-1');
    expect(draftKey('ns', 1, [])).toBe('ns:v1');
    expect(draftKey('ns', 1, null)).toBe('ns:v1');
  });

  it('不同作用域产出不同 key（A 任务草稿不会进 B 任务表单）', () => {
    expect(draftKey('ns', 1, 'task-a')).not.toBe(draftKey('ns', 1, 'task-b'));
  });
});

describe('parseDraft：信封解析的防御性', () => {
  it('合法信封原样解出', () => {
    const env = { version: 1, savedAt: 1700000000000, data: { a: 1 } };
    expect(parseDraft(JSON.stringify(env), 1)).toEqual(env);
  });

  it('坏 JSON / 非对象 / 版本不符 / savedAt 非法 / 缺 data → null', () => {
    expect(parseDraft(null, 1)).toBeNull();
    expect(parseDraft('', 1)).toBeNull();
    expect(parseDraft('{not json', 1)).toBeNull();
    expect(parseDraft('"str"', 1)).toBeNull();
    expect(parseDraft('null', 1)).toBeNull();
    // 版本不符：整体丢弃（不兼容半份旧草稿）
    expect(parseDraft(JSON.stringify({ version: 0, savedAt: 1, data: {} }), 1)).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, savedAt: 'x', data: {} }), 1)).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, savedAt: NaN, data: {} }), 1)).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, savedAt: 1 }), 1)).toBeNull();
  });
});

describe('readDraft / writeDraft / removeDraft：低层存取', () => {
  it('写后可读；remove 后读为 null；重复 remove 不抛错', () => {
    expect(readDraft(KEY, 1)).toBeNull();
    expect(writeDraft(KEY, { name: 'x' }, 1)).toBe(true);
    const env = readDraft<{ name: string }>(KEY, 1)!;
    expect(env.data).toEqual({ name: 'x' });
    expect(env.version).toBe(1);
    expect(typeof env.savedAt).toBe('number');
    expect(removeDraft(KEY)).toBe(true);
    expect(readDraft(KEY, 1)).toBeNull();
    expect(removeDraft(KEY)).toBe(true);
  });

  it('quota 满（setItem 抛错）→ writeDraft 返回 false，不抛错', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => writeDraft(KEY, { a: 1 }, 1)).not.toThrow();
    expect(writeDraft(KEY, { a: 1 }, 1)).toBe(false);
    spy.mockRestore();
  });

  it('getItem 抛错 → readDraft 返回 null，不抛错', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => readDraft(KEY, 1)).not.toThrow();
    expect(readDraft(KEY, 1)).toBeNull();
    spy.mockRestore();
  });
});

describe('useDraft：落盘 / 恢复 / 防抖 / 清除 / 容错', () => {
  it('值变化经防抖落盘（信封含 version/savedAt/data）', async () => {
    const { rerender } = renderHook(
      ({ value }) => useDraft({ key: KEY, value, delay: DELAY }),
      { initialProps: { value: { name: 'a' } } },
    );
    await wait(DELAY * 3);
    const env = readDraft<{ name: string }>(KEY, 1)!;
    expect(env).toBeTruthy();
    expect(env.version).toBe(1);
    expect(env.data).toEqual({ name: 'a' });

    rerender({ value: { name: 'ab' } });
    await wait(DELAY * 3);
    expect(readDraft<{ name: string }>(KEY, 1)!.data).toEqual({ name: 'ab' });
  });

  it('挂载时同步恢复草稿（惰性初始化，无需等待）', () => {
    writeDraft(KEY, { name: 'restored' }, 1);
    const { result, unmount } = renderHook(() =>
      useDraft({ key: KEY, value: { name: '' }, delay: DELAY }),
    );
    // 首次渲染即可读（不是 effect 之后才填）
    expect(result.current.restored?.data).toEqual({ name: 'restored' });
    expect(result.current.unavailable).toBe(false);
    // 卸载：flush 挂起的防抖写入，避免定时器在用例结束后 setState
    unmount();
  });

  it('防抖：窗口内连续改动只落盘一次，落盘的是最后一次的值', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const { rerender } = renderHook(
      ({ value }) => useDraft({ key: KEY, value, delay: 50 }),
      { initialProps: { value: { n: 1 } } },
    );
    // 50ms 窗口内连续 4 次改动
    rerender({ value: { n: 2 } });
    rerender({ value: { n: 3 } });
    rerender({ value: { n: 4 } });
    await wait(150);
    const writes = setItemSpy.mock.calls.filter(([k]) => k === KEY);
    expect(writes.length).toBe(1);
    expect(readDraft<{ n: number }>(KEY, 1)!.data).toEqual({ n: 4 });
  });

  it('discard：删除存储、清空 restored，且取消挂起的防抖写入（不复活）', async () => {
    writeDraft(KEY, { name: 'old' }, 1);
    const { result, rerender } = renderHook(
      ({ value }) => useDraft({ key: KEY, value, delay: 50 }),
      { initialProps: { value: { name: 'old' } } },
    );
    expect(result.current.restored?.data).toEqual({ name: 'old' });

    // 制造一个挂起的写入，然后立刻丢弃
    rerender({ value: { name: 'edited' } });
    act(() => result.current.discard());

    expect(readDraft(KEY, 1)).toBeNull();
    expect(result.current.restored).toBeNull();

    // 等过防抖窗口：草稿**不得**复活
    await wait(150);
    expect(readDraft(KEY, 1)).toBeNull();
  });

  it('discard 之后值再变化也不落盘（不会把丢弃的草稿写回来）', async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDraft({ key: KEY, value, delay: DELAY }),
      { initialProps: { value: { n: 1 } } },
    );
    act(() => result.current.discard());
    rerender({ value: { n: 2 } });
    await wait(DELAY * 3);
    expect(readDraft(KEY, 1)).toBeNull();
  });

  /**
   * **丢弃后卸载**不得把草稿写回来（补强）。
   *
   * 为什么单独一条：上面那条「discard：…取消挂起的防抖写入」挡不住这条路径。
   * 实测反证：把 `discard()` 里的 `pendingRef.current = false` 删掉，上面那条
   * **照样绿**——因为防抖 effect 的依赖含 `active`，`setActive(false)` 会让它
   * 重跑并执行上一轮的 cleanup（`return clearTimer`），挂起的定时器已被清掉，
   * `discard` 里的 `clearTimer()` 其实是冗余的第二道保险。
   *
   * 真正的复活路径在**卸载 flush**：那个 effect 的判据是 `pendingRef.current`
   * （它必须能看到"还有一笔没写"，见 hook 内注释——依赖 timerRef 会因为
   * effect cleanup 顺序而漏判）。若 discard 不清 pendingRef，用户「丢弃草稿 →
   * 立刻切页/关标签」，卸载 flush 会把刚丢掉的草稿原样写回去，下次进页面
   * 提示"已恢复草稿"——用户明确丢弃过的东西又回来了。
   */
  it('discard 后立即卸载：卸载 flush 不得把丢弃的草稿写回来', async () => {
    writeDraft(KEY, { name: 'old' }, 1);
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useDraft({ key: KEY, value, delay: 50 }),
      { initialProps: { value: { name: 'old' } } },
    );
    expect(result.current.restored?.data).toEqual({ name: 'old' });

    // 制造挂起写入 → 丢弃 → **在防抖窗口内卸载**
    rerender({ value: { name: 'edited' } });
    act(() => result.current.discard());
    unmount();

    expect(readDraft(KEY, 1)).toBeNull();
  });

  it('版本不符的旧草稿整体丢弃（restored 为 null）', () => {
    writeDraft(KEY, { name: 'legacy' }, 0);
    const { result, unmount } = renderHook(() =>
      useDraft({ key: KEY, value: { name: '' }, delay: DELAY, version: 1 }),
    );
    expect(result.current.restored).toBeNull();
    unmount();
  });

  it('quota 满：不抛错，unavailable 置位（草稿降级为不持久化）', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const { result, unmount } = renderHook(() =>
      useDraft({ key: KEY, value: { n: 1 }, delay: DELAY }),
    );
    await wait(DELAY * 3);
    expect(result.current.unavailable).toBe(true);
    expect(result.current.savedAt).toBeNull();
    unmount();
    spy.mockRestore();
  });

  it('卸载时 flush：防抖未到期就卸载，改动仍然落盘', async () => {
    const { rerender, unmount } = renderHook(
      ({ value }) => useDraft({ key: KEY, value, delay: 10_000 }),
      { initialProps: { value: { n: 1 } } },
    );
    rerender({ value: { n: 2 } });
    // 防抖 10s 远未到期就卸载
    unmount();
    expect(readDraft<{ n: number }>(KEY, 1)!.data).toEqual({ n: 2 });
  });

  it('enabled=false：不落盘（表单尚未回填完成时不覆盖真草稿）', async () => {
    const { rerender } = renderHook(
      ({ value, enabled }) => useDraft({ key: KEY, value, enabled, delay: DELAY }),
      { initialProps: { value: { n: 1 }, enabled: false } },
    );
    await wait(DELAY * 3);
    expect(readDraft(KEY, 1)).toBeNull();
    // 打开后正常落盘
    rerender({ value: { n: 2 }, enabled: true });
    await wait(DELAY * 3);
    expect(readDraft<{ n: number }>(KEY, 1)!.data).toEqual({ n: 2 });
  });

  it('key=null：完全惰性（不读、不写）', async () => {
    writeDraft(KEY, { n: 'existing' }, 1);
    const { result } = renderHook(() =>
      useDraft({ key: null, value: { n: 1 }, delay: DELAY }),
    );
    expect(result.current.restored).toBeNull();
    await wait(DELAY * 3);
    // 已有草稿不被空表单覆盖
    expect(readDraft<{ n: string }>(KEY, 1)!.data).toEqual({ n: 'existing' });
  });

  it('key 变化：重读对应作用域的草稿（编辑态 id 就绪）', () => {
    const keyA = draftKey('ns', 1, 'task-a');
    const keyB = draftKey('ns', 1, 'task-b');
    writeDraft(keyA, { n: 'A' }, 1);
    writeDraft(keyB, { n: 'B' }, 1);
    const { result, rerender } = renderHook(
      ({ key }) => useDraft({ key, value: { n: '' }, delay: 10_000 }),
      { initialProps: { key: keyA } },
    );
    expect(result.current.restored?.data).toEqual({ n: 'A' });
    rerender({ key: keyB });
    expect(result.current.restored?.data).toEqual({ n: 'B' });
  });

  it('flush()：立即落盘（不等防抖）', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDraft({ key: KEY, value, delay: 10_000 }),
      { initialProps: { value: { n: 1 } } },
    );
    rerender({ value: { n: 2 } });
    expect(readDraft(KEY, 1)).toBeNull();
    act(() => result.current.flush());
    expect(readDraft<{ n: number }>(KEY, 1)!.data).toEqual({ n: 2 });
    expect(result.current.savedAt).toBeTypeOf('number');
  });

  it('SSR/无 storage 安全：window.localStorage 访问抛错也不炸', async () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const { result, unmount } = renderHook(() =>
      useDraft({ key: KEY, value: { n: 1 }, delay: DELAY }),
    );
    expect(result.current.restored).toBeNull();
    await wait(DELAY * 3);
    // 写入失败 → 降级标记（不冒泡）
    expect(result.current.unavailable).toBe(true);
    unmount();
    spy.mockRestore();
  });

  it('信封形状稳定：savedAt 随时间推进而更新', async () => {
    const { rerender } = renderHook(
      ({ value }) => useDraft({ key: KEY, value, delay: DELAY }),
      { initialProps: { value: { n: 1 } } },
    );
    await wait(DELAY * 3);
    const first: DraftEnvelope<{ n: number }> = readDraft(KEY, 1)!;
    await wait(5);
    rerender({ value: { n: 2 } });
    await wait(DELAY * 3);
    const second: DraftEnvelope<{ n: number }> = readDraft(KEY, 1)!;
    expect(second.savedAt).toBeGreaterThanOrEqual(first.savedAt);
    expect(second.data).toEqual({ n: 2 });
  });
});
