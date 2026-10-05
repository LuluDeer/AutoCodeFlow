/**
 * REFACTOR-TASKFORM 回归（commit 7d66a9b0 记录的既有 bug 之 3）：
 *
 * 创建成功滚 Glue 原为 `setTimeout(() => scrollToSection('sec-glue'), 50)`——
 * 50ms 是「赌渲染在 50ms 内完成」的魔法延时：慢机器/长任务下渲染未提交就滚空，
 * 快机器又白等。替代工具 scrollToSectionWhenReady 的语义是「rAF 两连等待渲染
 * 提交 + 目标存在性轮询（有界）」，本文件按四种环境/时序钉死行为：
 *   1) 目标已在：两帧后按原 scrollToSection 参数滚动一次；
 *   2) 目标延后挂载：轮询等到出现才滚动（等真实渲染就绪，不赌固定毫秒）；
 *   3) 目标永不挂载：有界放弃（rAF 调用次数有上限，不无限轮询、不抛错）；
 *   4) 无 rAF 环境：立即尝试一次（与原同步滚动等价的保底路径）。
 *
 * 用例 2-4 注入 fake document 驱动（手动 rAF 队列，逐帧确定性推进、零真实等待）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { scrollToSectionWhenReady } from '../utils/scroll-when-ready';

// jsdom 未实现 Element.scrollIntoView——补 no-op 桩以便按元素 spy
// （对齐 task-form-app-select.test 先例）。
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** 手动 rAF 队列 + 可控 getElementById 的假 document（逐帧确定性推进） */
function makeFakeDoc(getElementById: (id: string) => HTMLElement | null) {
  const rafCalls: FrameRequestCallback[] = [];
  const doc = {
    getElementById,
    defaultView: {
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        rafCalls.push(cb);
        return rafCalls.length;
      },
    },
  } as unknown as Document;
  /** 推进 n 帧（清空当前队列逐个执行，模拟浏览器的逐帧回调） */
  const pump = (n: number) => {
    for (let i = 0; i < n; i += 1) {
      for (const cb of rafCalls.splice(0)) cb(i * 16);
    }
  };
  return { doc, rafCalls, pump };
}

function mountTarget(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('scrollToSectionWhenReady（rAF 两连 + 存在性轮询）', () => {
  it('目标已挂载：两帧后按原 scrollToSection 参数滚动一次（真实 document）', async () => {
    const el = mountTarget('scroll-ready-real');
    const spy = vi.spyOn(el, 'scrollIntoView').mockImplementation(() => {});

    scrollToSectionWhenReady('scroll-ready-real');
    // 未让出帧不滚——至少给渲染提交让出一帧
    expect(spy).not.toHaveBeenCalled();
    await frame();
    await frame();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('目标延后挂载：轮询等到出现才滚动（fake document，不赌固定毫秒）', () => {
    const el = mountTarget('scroll-ready-late');
    el.remove(); // 先移除，模拟「状态更新后的下一次渲染提交才挂载」
    const spy = vi.spyOn(el, 'scrollIntoView').mockImplementation(() => {});
    const { doc, pump } = makeFakeDoc((id) => document.getElementById(id));

    scrollToSectionWhenReady('scroll-ready-late', doc);
    pump(2);
    expect(spy).not.toHaveBeenCalled();

    document.body.appendChild(el); // 渲染提交，目标出现
    pump(1);
    expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('目标永不挂载：有界放弃（rAF 次数有上限，不无限轮询）', () => {
    const { doc, rafCalls, pump } = makeFakeDoc(() => null);

    scrollToSectionWhenReady('scroll-ready-never', doc, 3);
    pump(20);

    // 两连帧引导（2 次）+ 轮询上限（3 次）后必须停手
    expect(rafCalls.length).toBeLessThanOrEqual(5);
  });

  it('无 rAF 环境：立即尝试一次滚动（保底路径，与原同步滚动等价）', () => {
    const el = mountTarget('scroll-ready-norf');
    const spy = vi.spyOn(el, 'scrollIntoView').mockImplementation(() => {});
    const doc = {
      getElementById: (id: string) => (id === 'scroll-ready-norf' ? el : null),
      defaultView: {}, // 无 requestAnimationFrame
    } as unknown as Document;

    scrollToSectionWhenReady('scroll-ready-norf', doc);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });
});
