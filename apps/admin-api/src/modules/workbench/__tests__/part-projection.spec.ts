import {
  WORKBENCH_PART_KINDS,
  isStaleGeneration,
  type GenerationToken,
  type WorkbenchPart,
  type WorkbenchPartKind,
} from "../part-model";
import {
  InMemoryWorkbenchPartProvider,
  PartProjectionService,
} from "../part-projection.service";
import { S3LogStorage } from "../../task/log-storage/s3-log-storage";
import { WorkbenchBlobStore } from "../workbench-blob.store";

const CURRENT: GenerationToken = "aaaaaaaaaaaaaaaa";
const OLD: GenerationToken = "bbbbbbbbbbbbbbbb";

function fakeConfig(driver: "memory" | "s3" = "memory"): never {
  return {
    get: (key: string): unknown => {
      if (key === "logStorage.driver") return driver;
      if (key === "logStorage.endpoint") return "127.0.0.1:9000";
      return undefined;
    },
  } as never;
}

function basePart(kind: WorkbenchPartKind, id: string, sessionId: string) {
  return {
    kind,
    id,
    sessionId,
    generation: CURRENT,
  } as Record<string, unknown>;
}

function makePart(
  kind: WorkbenchPartKind,
  id: string,
  generation: GenerationToken | undefined = CURRENT,
  sessionId = "s1",
): WorkbenchPart {
  const base = basePart(kind, id, sessionId);
  base.generation = generation;
  switch (kind) {
    case "text":
      base.text = "hello";
      break;
    case "reasoning":
      base.text = "think";
      break;
    case "tool":
      Object.assign(base, {
        toolCallId: `c-${id}`,
        toolName: "read",
        state: "completed",
      });
      break;
    case "step-start":
      base.step = 1;
      break;
    case "step-finish":
      Object.assign(base, { step: 1, reason: "done" });
      break;
    case "file":
      Object.assign(base, { mime: "text/plain", filename: "a.txt" });
      break;
    case "agent":
      base.name = "reviewer";
      break;
    case "subtask":
      base.subtaskId = `t-${id}`;
      break;
    case "compaction":
      break;
    case "snapshot":
      base.snapshotId = `snap-${id}`;
      break;
    case "patch":
      Object.assign(base, { hash: "h1", files: ["a.ts"] });
      break;
    case "retry":
      base.attempt = 2;
      break;
  }
  return base as unknown as WorkbenchPart;
}

function makeService() {
  const blobs = new WorkbenchBlobStore(fakeConfig());
  const parts = new InMemoryWorkbenchPartProvider();
  const service = new PartProjectionService(blobs, parts);
  return { blobs, parts, service };
}

describe("N10 Part blob + 投影接线", () => {
  it("大字段写入后内联内容被 BlobRef 替换，get 能读回原文", async () => {
    const { blobs, parts, service } = makeService();
    const content = "行".repeat(2048);
    const tool = {
      ...makePart("tool", "p-tool", CURRENT, "s-tool"),
      output: content,
    } as unknown as WorkbenchPart;

    const stored = await service.ingestPart({ part: tool });
    const key = "part:p-tool:output";

    expect(
      (stored as unknown as Record<string, unknown>).output,
    ).toBeUndefined();
    expect(stored.blobRefs).toEqual([
      { blobKey: key, byteLength: Buffer.byteLength(content, "utf8") },
    ]);
    expect(await blobs.get(key)).toBe(content);
    expect(await parts.getPart("p-tool")).toEqual(stored);
  });

  it("visible=false 的投影完全不含 blob 正文，也不读 blob 后端", async () => {
    const { blobs, parts, service } = makeService();
    const content = "private-secret-body";
    const part = {
      ...makePart("tool", "p-private", CURRENT, "s-private"),
      output: content,
      share: { visibility: "private" },
    } as unknown as WorkbenchPart;
    await service.ingestPart({ part });
    parts.setOwners("s-private", ["user:owner", "1"]);

    const getSpy = jest.spyOn(blobs, "get");
    const outsider = await service.projectById("p-private", CURRENT, {
      id: 9,
      username: "viewer",
    });

    expect(outsider?.visible).toBe(false);
    expect(outsider && "blobContent" in outsider).toBe(false);
    expect(JSON.stringify(outsider)).not.toContain(content);
    expect(getSpy).not.toHaveBeenCalled();

    const owner = await service.projectById("p-private", CURRENT, {
      id: 1,
      username: "owner",
    });
    expect(owner?.visible).toBe(true);
    expect(owner?.blobContent?.["part:p-private:output"]).toBe(content);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("remove 后 get 抛错（内存降级后端）", async () => {
    const { blobs } = makeService();
    const key = "part:p-remove:content";
    await blobs.put(key, "abc", "text/plain");
    expect(await blobs.get(key)).toBe("abc");

    await blobs.remove(key);
    await expect(blobs.get(key)).rejects.toThrow(/不存在/);
  });

  it("12 类 kind 均可投影，stale 与 part-model.isStaleGeneration 同判", async () => {
    const { service } = makeService();
    const parts = WORKBENCH_PART_KINDS.map((kind, index) =>
      makePart(kind, `p${index}`, index === 3 ? OLD : CURRENT),
    );
    parts[4] = { ...parts[4], generation: undefined } as WorkbenchPart;

    const projections = await service.projectMany(parts, {
      currentGeneration: CURRENT,
      viewerIsOwner: true,
    });

    expect(projections.map((item) => item.kind)).toEqual([
      ...WORKBENCH_PART_KINDS,
    ]);
    projections.forEach((projection, index) => {
      expect(projection.stale).toBe(isStaleGeneration(parts[index], CURRENT));
      expect(projection.visible).toBe(true);
    });

    // 空串是合法 opaque token，只有严格相等才算同代。
    const emptyGeneration = await service.projectOne(
      { ...makePart("text", "p-empty", ""), generation: "" } as WorkbenchPart,
      { currentGeneration: "", viewerIsOwner: true },
    );
    expect(emptyGeneration.stale).toBe(false);
  });

  it("s3 配置走 S3LogStorage.fromConfig，对象 key 与逻辑 blobKey 分离", async () => {
    const put = jest.fn(async (key: string, _content: string) => key);
    const get = jest.fn(async (key: string) => `read:${key}`);
    const remove = jest.fn(async (_key: string) => undefined);
    const fakeStorage = {
      objectKey: (key: string) => `execution-logs/${key}.log.gz`,
      put,
      get,
      remove,
    } as unknown as S3LogStorage;
    const spy = jest
      .spyOn(S3LogStorage, "fromConfig")
      .mockReturnValue(fakeStorage);
    try {
      const blobs = new WorkbenchBlobStore(fakeConfig("s3"));
      const ref = await blobs.put("part:x:output", "abc", "text/plain");

      expect(ref).toEqual({
        blobKey: "part:x:output",
        byteLength: 3,
        mimeType: "text/plain",
      });
      expect(put).toHaveBeenCalledWith("part:x:output", "abc");
      expect(await blobs.get(ref.blobKey)).toBe(
        "read:execution-logs/part:x:output.log.gz",
      );
      expect(get).toHaveBeenCalledWith("execution-logs/part:x:output.log.gz");
      await blobs.remove(ref.blobKey);
      expect(remove).toHaveBeenCalledWith(
        "execution-logs/part:x:output.log.gz",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
