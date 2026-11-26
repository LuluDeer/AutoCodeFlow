import {
  classifyReachability,
  degradePath,
  E2E_DATA_SOURCE_CAPABILITY_IDS,
  GHOST_CAPABILITY_ID,
  type ReachabilityCapability,
} from "../reachability";

const browserCapability: ReachabilityCapability = {
  id: "browser",
  key: "browser",
};

const guiCapability: ReachabilityCapability = {
  id: "gui",
  key: "gui",
  manifest: { driver: "x11" },
};

const filesystemCapability: ReachabilityCapability = {
  id: "filesystem",
  key: "filesystem",
};

const ghostCapability: ReachabilityCapability = {
  id: GHOST_CAPABILITY_ID,
  key: GHOST_CAPABILITY_ID,
};

describe("classifyReachability（纯函数，零 I/O）", () => {
  it("真实数据源 + 明确可达证据 → reachable", () => {
    expect(
      classifyReachability({ capabilityId: "browser", status: "ok", ok: true }),
    ).toBe("reachable");
    expect(
      classifyReachability({
        capabilityKey: "filesystem",
        status: "reachable",
      }),
    ).toBe("reachable");
  });

  it("明确失败证据 → unreachable", () => {
    expect(
      classifyReachability({
        capabilityId: "gui",
        status: "timeout",
        ok: false,
      }),
    ).toBe("unreachable");
    expect(
      classifyReachability({ capabilityId: "browser", status: "denied" }),
    ).toBe("unreachable");
  });

  it("缺失或畸形信号 → unknown（fail-closed）", () => {
    expect(classifyReachability(undefined)).toBe("unknown");
    expect(classifyReachability(null)).toBe("unknown");
    expect(classifyReachability({ capabilityId: "gui" })).toBe("unknown");
    expect(
      classifyReachability({ capabilityId: "gui", status: "unknown" }),
    ).toBe("unknown");
    expect(
      classifyReachability({ capabilityId: "gui", status: "ok", ok: false }),
    ).toBe("unreachable");
  });

  it("首个 e2e 用已有 API/已就绪文件数据源，不用幽灵能力：finance.erp.readonly 不得判 reachable", () => {
    expect([...E2E_DATA_SOURCE_CAPABILITY_IDS].sort()).toEqual([
      "browser",
      "filesystem",
      "gui",
    ]);
    expect(
      classifyReachability({
        capabilityId: GHOST_CAPABILITY_ID,
        status: "reachable",
        ok: true,
      }),
    ).toBe("unknown");
  });
});

describe("degradePath（纯函数，返回编排标记）", () => {
  it("reachable → direct", () => {
    expect(degradePath(browserCapability, "reachable")).toBe("direct");
  });

  it("unreachable + GUI 能力 → x11+fromVideo 降级编排标记", () => {
    // 反证锚点：把 unreachable 分支的 x11+fromVideo 改掉，本例转红。
    expect(degradePath(guiCapability, "unreachable")).toBe("x11+fromVideo");
    expect(
      degradePath(
        { id: "gui-driver", manifest: { driver: "x11" } },
        "unreachable",
      ),
    ).toBe("x11+fromVideo");
  });

  it("unknown → unknown（fail-closed）", () => {
    // 反证锚点：把 unknown 分支改成 direct，本例转红。
    expect(degradePath(guiCapability, "unknown")).toBe("unknown");
    expect(
      degradePath(guiCapability, classifyReachability({ status: "ok" })),
    ).toBe("unknown");
  });

  it("控制组：无 GUI 能力的 filesystem unreachable → unknown", () => {
    expect(degradePath(filesystemCapability, "unreachable")).toBe("unknown");
    expect(degradePath(browserCapability, "unreachable")).toBe("unknown");
    expect(degradePath(null, "unreachable")).toBe("unknown");
  });

  it("控制组：幽灵能力串联判定停在 unknown", () => {
    const reachability = classifyReachability({
      capabilityId: GHOST_CAPABILITY_ID,
      status: "reachable",
      ok: true,
    });
    expect(reachability).toBe("unknown");
    expect(degradePath(ghostCapability, reachability)).toBe("unknown");
  });
});
