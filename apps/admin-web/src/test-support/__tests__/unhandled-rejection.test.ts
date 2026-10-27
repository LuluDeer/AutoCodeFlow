import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  KNOWN_TEARDOWN_SIGNATURES,
  UNEXPECTED_REJECTION_PREFIX,
  classifyUnhandledRejection,
  installUnhandledRejectionReporter,
} from "../unhandled-rejection";

/**
 * 分类器的判定边界（2026-10-27 实施轮 #9）。
 *
 * 为什么值得单测：vite.config.ts 的 dangerouslyIgnoreUnhandledErrors 是**全域**
 * 开关，它把真缺陷的浮空拒绝一起无视了。分类器的价值就在于「已知 teardown 竞态
 * 静默、其余大声打日志」——分类判错任一方向都会退化：
 *  · 判宽了（把真回归当 teardown）→ 回归继续隐身；
 *  · 判窄了（把 teardown 当回归）→ 日志刷屏，等于噪声。
 */
describe("classifyUnhandledRejection", () => {
  it("已知 teardown 竞态：三类特征都判 known", () => {
    expect(
      classifyUnhandledRejection(new Error("prepareForCommit failed")),
    ).toBe("known-teardown");
    expect(
      classifyUnhandledRejection(
        new TypeError("Cannot read properties of null (reading 'document')"),
      ),
    ).toBe("known-teardown");
    expect(classifyUnhandledRejection("document is not defined")).toBe(
      "known-teardown",
    );
  });

  it("真实回归形态判 unexpected（错误对象/字符串/任意值都不抛）", () => {
    expect(classifyUnhandledRejection(new Error("kaboom"))).toBe("unexpected");
    expect(classifyUnhandledRejection("some rejected string")).toBe("unexpected");
    expect(classifyUnhandledRejection({ weird: true })).toBe("unexpected");
    // 循环引用也不许抛（JSON.stringify 会炸，必须被兜）
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(classifyUnhandledRejection(cyclic)).toBe("unexpected");
    expect(classifyUnhandledRejection(undefined)).toBe("unexpected");
  });

  it("签名表非空且都是正则（防止有人把它清空导致全部判 unexpected → 日志刷屏）", () => {
    expect(KNOWN_TEARDOWN_SIGNATURES.length).toBeGreaterThanOrEqual(2);
    for (const re of KNOWN_TEARDOWN_SIGNATURES) expect(re).toBeInstanceOf(RegExp);
  });
});

describe("installUnhandledRejectionReporter", () => {
  function makeTarget() {
    const emitter = new EventEmitter();
    return {
      emitter,
      target: {
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
      } as unknown as Pick<NodeJS.Process, "on" | "off">,
    };
  }

  it("已知 teardown 静默；非已知形态打固定前缀日志", () => {
    const { emitter, target } = makeTarget();
    const error = vi.fn();
    const uninstall = installUnhandledRejectionReporter(target, { error });

    emitter.emit("unhandledRejection", new Error("prepareForCommit boom"), Promise.resolve());
    expect(error).not.toHaveBeenCalled();

    emitter.emit("unhandledRejection", new Error("real regression"), Promise.resolve());
    expect(error).toHaveBeenCalledTimes(1);
    const [firstArg] = error.mock.calls[0] as [string, unknown];
    expect(firstArg).toContain(UNEXPECTED_REJECTION_PREFIX);
    // 前缀必须稳定：CI 里靠它 grep（写成自由文本等于没有信号）
    expect(UNEXPECTED_REJECTION_PREFIX).toBe("[ACF][unhandledRejection]");

    // 卸载后不再接收（避免测试之间串扰）
    uninstall();
    emitter.emit("unhandledRejection", new Error("after uninstall"), Promise.resolve());
    expect(error).toHaveBeenCalledTimes(1);
  });
});
