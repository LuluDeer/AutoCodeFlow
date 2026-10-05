/**
 * BUGFIX（P3，commit 7d66a9b0 清单）：TaskFormPage 创建成功滚 Glue 原为
 * `setTimeout(() => scrollToSection(id), 50)`——50ms 是「赌渲染在 50ms 内完成」
 * 的魔法延时：慢机器/长任务下渲染尚未提交就滚空，快机器又白等。
 *
 * 本工具把「等待」换成真实渲染就绪信号：
 *   1. rAF 两连——第一帧让 React 提交本轮状态更新，第二帧确认已过一次绘制；
 *   2. 目标存在性轮询——若目标区块按条件挂载（尚未出现），逐帧重查直到出现，
 *      命中即滚动；有 `maxFrames` 上限，目标始终不出现则静默放弃（定位增强
 *      无业务语义，与原实现滚动空目标时的空操作等价）。
 *
 * 无 rAF 的环境（旧 jsdom 等）退化为立即尝试一次，与原同步滚动路径等价。
 * `doc` 参数供测试注入假 document（手动 rAF 队列逐帧确定性推进）。
 */
export function scrollToSectionWhenReady(
  id: string,
  doc: Document = document,
  /** 存在性轮询的帧数上限（默认 120 ≈ 2s @60fps）；超限静默放弃 */
  maxFrames = 120,
): void {
  const view = doc.defaultView;
  const raf = view?.requestAnimationFrame?.bind(view);
  // jsdom 无布局引擎，Element.scrollIntoView 未实现——可选调用守卫后调用，
  // 真浏览器生效；测试环境静默跳过（与 TaskFormPage 原 scrollToSection 同款）。
  const tryScroll = () => {
    doc.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
  if (typeof raf !== 'function') {
    tryScroll();
    return;
  }
  let framesLeft = maxFrames;
  const step = () => {
    if (doc.getElementById(id)) {
      tryScroll();
      return;
    }
    if (framesLeft > 0) {
      framesLeft -= 1;
      raf(step);
    }
  };
  raf(() => raf(step));
}
