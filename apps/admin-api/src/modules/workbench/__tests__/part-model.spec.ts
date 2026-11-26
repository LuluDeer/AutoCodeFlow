/**
 * N10 Part 模型单测（纯类型/纯函数级）。
 *
 * 本切片只有类型与投影函数，零 Nest/DB 依赖，无须 jest.mock 框架替身。
 * 覆盖：12 类判别（每类 1 条）+ generation fail-closed 判旧（含缺失转红点）
 * + share 可见性 + blob 标记 + 控制组。
 */
import {
  BLOB_BACKED_KINDS,
  WORKBENCH_PART_KINDS,
  isBlobBackedKind,
  isPartVisible,
  isStaleGeneration,
  projectPart,
  type BlobRef,
  type GenerationToken,
  type WorkbenchPart,
  type WorkbenchPartKind,
} from "../part-model";

const CURRENT: GenerationToken = "aaaaaaaaaaaaaaaa";
const OLD: GenerationToken = "bbbbbbbbbbbbbbbb";

/** 每类 Part 一个最小合法实例，kind 为判别字段。 */
const FIXTURES: ReadonlyArray<{
  kind: WorkbenchPartKind;
  part: WorkbenchPart;
}> = [
  {
    kind: "text",
    part: {
      kind: "text",
      id: "p1",
      sessionId: "s1",
      generation: CURRENT,
      text: "hello",
    },
  },
  {
    kind: "reasoning",
    part: {
      kind: "reasoning",
      id: "p2",
      sessionId: "s1",
      generation: CURRENT,
      text: "think",
    },
  },
  {
    kind: "tool",
    part: {
      kind: "tool",
      id: "p3",
      sessionId: "s1",
      generation: CURRENT,
      toolCallId: "c1",
      toolName: "read",
      state: "completed",
    },
  },
  {
    kind: "step-start",
    part: {
      kind: "step-start",
      id: "p4",
      sessionId: "s1",
      generation: CURRENT,
      step: 1,
    },
  },
  {
    kind: "step-finish",
    part: {
      kind: "step-finish",
      id: "p5",
      sessionId: "s1",
      generation: CURRENT,
      step: 1,
      reason: "done",
    },
  },
  {
    kind: "file",
    part: {
      kind: "file",
      id: "p6",
      sessionId: "s1",
      generation: CURRENT,
      mime: "text/plain",
      filename: "a.txt",
    },
  },
  {
    kind: "agent",
    part: {
      kind: "agent",
      id: "p7",
      sessionId: "s1",
      generation: CURRENT,
      name: "reviewer",
    },
  },
  {
    kind: "subtask",
    part: {
      kind: "subtask",
      id: "p8",
      sessionId: "s1",
      generation: CURRENT,
      subtaskId: "t1",
    },
  },
  {
    kind: "compaction",
    part: {
      kind: "compaction",
      id: "p9",
      sessionId: "s1",
      generation: CURRENT,
    },
  },
  {
    kind: "snapshot",
    part: {
      kind: "snapshot",
      id: "p10",
      sessionId: "s1",
      generation: CURRENT,
      snapshotId: "snap1",
    },
  },
  {
    kind: "patch",
    part: {
      kind: "patch",
      id: "p11",
      sessionId: "s1",
      generation: CURRENT,
      hash: "h1",
      files: ["a.ts"],
    },
  },
  {
    kind: "retry",
    part: {
      kind: "retry",
      id: "p12",
      sessionId: "s1",
      generation: CURRENT,
      attempt: 2,
    },
  },
];

describe("N10 12 类 Part 判别联合", () => {
  it("WORKBENCH_PART_KINDS 恰好 12 类且无重复", () => {
    expect(WORKBENCH_PART_KINDS).toHaveLength(12);
    expect(new Set<string>(WORKBENCH_PART_KINDS).size).toBe(12);
  });

  it.each(FIXTURES)("$kind 判别：kind 字段与联合成员一致", ({ kind, part }) => {
    expect(part.kind).toBe(kind);
    expect(WORKBENCH_PART_KINDS).toContain(kind);
    const projected = projectPart(part, {
      currentGeneration: CURRENT,
      viewerIsOwner: true,
    });
    expect(projected.kind).toBe(kind);
    expect(projected.id).toBe(part.id);
  });
});

describe("N10 generation 判据（fail-closed，N23 同口径）", () => {
  it("同代（严格 ===）→ 不陈旧", () => {
    expect(isStaleGeneration({ generation: CURRENT }, CURRENT)).toBe(false);
  });

  it("异代 → 陈旧", () => {
    expect(isStaleGeneration({ generation: OLD }, CURRENT)).toBe(true);
  });

  it("generation 缺失（字段不存在）→ 判旧", () => {
    expect(isStaleGeneration({}, CURRENT)).toBe(true);
  });

  it("generation = undefined → 判旧", () => {
    expect(isStaleGeneration({ generation: undefined }, CURRENT)).toBe(true);
  });

  it("generation = null → 判旧", () => {
    expect(isStaleGeneration({ generation: null }, CURRENT)).toBe(true);
  });

  it("part 本身缺失（undefined / null）→ 判旧", () => {
    expect(isStaleGeneration(undefined, CURRENT)).toBe(true);
    expect(isStaleGeneration(null, CURRENT)).toBe(true);
  });

  it("空串是合法 opaque token，不因空串判旧", () => {
    expect(isStaleGeneration({ generation: "" }, CURRENT)).toBe(true);
    expect(isStaleGeneration({ generation: "" }, "")).toBe(false);
  });

  it("控制组：projectPart 在同代标 stale=false，异代与缺失标 stale=true", () => {
    const base = FIXTURES[0].part;
    expect(
      projectPart(base, { currentGeneration: CURRENT, viewerIsOwner: true })
        .stale,
    ).toBe(false);
    expect(
      projectPart(base, { currentGeneration: OLD, viewerIsOwner: true }).stale,
    ).toBe(true);
    const missing: WorkbenchPart = { ...base, generation: undefined };
    expect(
      projectPart(missing, { currentGeneration: CURRENT, viewerIsOwner: true })
        .stale,
    ).toBe(true);
  });
});

describe("N10 会话级 share 可见性标记", () => {
  const base = FIXTURES[0].part;

  it("private 仅所有者可见", () => {
    const part: WorkbenchPart = { ...base, share: { visibility: "private" } };
    expect(isPartVisible(part, true)).toBe(true);
    expect(isPartVisible(part, false)).toBe(false);
  });

  it("session 同会话可见（非所有者也可见）", () => {
    const part: WorkbenchPart = { ...base, share: { visibility: "session" } };
    expect(isPartVisible(part, false)).toBe(true);
  });

  it("share 缺省按 private 处理", () => {
    expect(isPartVisible(base, false)).toBe(false);
    expect(isPartVisible(base, true)).toBe(true);
  });
});

describe("N10 大字段入 blob 的类型标记", () => {
  it("只有 tool/file/compaction/patch 是大字段类别", () => {
    expect([...BLOB_BACKED_KINDS]).toEqual([
      "tool",
      "file",
      "compaction",
      "patch",
    ]);
    expect(isBlobBackedKind("tool")).toBe(true);
    expect(isBlobBackedKind("file")).toBe(true);
    expect(isBlobBackedKind("compaction")).toBe(true);
    expect(isBlobBackedKind("patch")).toBe(true);
    expect(isBlobBackedKind("text")).toBe(false);
    expect(isBlobBackedKind("reasoning")).toBe(false);
    expect(isBlobBackedKind("agent")).toBe(false);
  });

  it("投影保留 blobRefs 引用标记，不内联正文", () => {
    const ref: BlobRef = {
      blobKey: "part:p3:output",
      byteLength: 42,
      mimeType: "text/plain",
    };
    const part: WorkbenchPart = {
      ...FIXTURES[2].part,
      blobRefs: [ref],
    } as WorkbenchPart;
    const projected = projectPart(part, {
      currentGeneration: CURRENT,
      viewerIsOwner: true,
    });
    expect(projected.blobRefs).toEqual([ref]);
    expect(projected.kind).toBe("tool");
    expect(projected.stale).toBe(false);
  });
});
