/**
 * 保留期清理（视频转 SOP）。
 *
 * 这类"每天跑一次"的任务没有用户可见的失败面：漏清就是**悄悄涨盘/涨表**，
 * 误清就是**删掉还在用的素材**。所以两条都钉住：过期该删的删干净、未过期
 * 一条不动；另外钉住"多实例只由 leader 清"与"可疑路径不删"。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AiMediaRetentionService } from "../ai-media-retention.service";
import { getAiMediaRootDir } from "../ai-media.service";

function harness(
  opts: {
    media?: Array<Record<string, unknown>>;
    sessionsOld?: number;
    leader?: boolean;
  } = {},
) {
  const deletedMediaIds: string[] = [];
  const mediaRepo = {
    find: jest.fn(async () => opts.media ?? []),
    delete: jest.fn(async (ids: string[]) => {
      deletedMediaIds.push(...ids);
      return { affected: ids.length };
    }),
  };
  const sessionRepo = {
    delete: jest.fn(async () => ({ affected: opts.sessionsOld ?? 0 })),
  };
  const config = {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === "ai.mediaRetentionDays") return 7;
      if (key === "ai.sessionRetentionDays") return 30;
      return def;
    }),
  };
  const leaderGate =
    opts.leader === undefined ? null : { isLeader: opts.leader };
  const svc = new AiMediaRetentionService(
    leaderGate as never,
    mediaRepo as never,
    sessionRepo as never,
    config as never,
  );
  return { svc, mediaRepo, sessionRepo, deletedMediaIds };
}

const ROOT = path.join(getAiMediaRootDir(), "retention-fixture");

function makeDir(name: string): string {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.mp4"), "x");
  return path.join("retention-fixture", name, "a.mp4");
}

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("cleanupExpiredMedia", () => {
  it("过期：删目录 + 删行（磁盘与清单同步，不留 404 僵尸行）", async () => {
    const storedPath = makeDir("old-one");
    const h = harness({ media: [{ id: "m-old", storedPath }] });

    const res = await h.svc.cleanupExpiredMedia(new Date());
    expect(res).toEqual({ rows: 1, dirs: 1 });
    expect(h.deletedMediaIds).toEqual(["m-old"]);
    expect(
      fs.existsSync(
        path.join(getAiMediaRootDir(), "retention-fixture", "old-one"),
      ),
    ).toBe(false);
  });

  it("未过期：一条不动（find 的 where 由仓储执行，这里钉住没有行就不删）", async () => {
    const h = harness({ media: [] });
    const res = await h.svc.cleanupExpiredMedia(new Date());
    expect(res).toEqual({ rows: 0, dirs: 0 });
    expect(h.mediaRepo.delete).not.toHaveBeenCalled();
  });

  it("目录已不在：仍然删行（幂等，不因磁盘先被清而留僵尸）", async () => {
    const h = harness({
      media: [{ id: "m-ghost", storedPath: "retention-fixture/gone/a.mp4" }],
    });
    const res = await h.svc.cleanupExpiredMedia(new Date());
    expect(res.rows).toBe(1);
    expect(res.dirs).toBe(0);
  });

  it("可疑路径（越界/相对根）：跳过磁盘操作但清行，并记 warn", async () => {
    const h = harness({
      media: [{ id: "m-bad", storedPath: "../../etc/passwd" }],
    });
    const res = await h.svc.cleanupExpiredMedia(new Date());
    expect(res.dirs).toBe(0);
    expect(h.deletedMediaIds).toEqual(["m-bad"]);
  });
});

describe("cleanupExpiredSessions", () => {
  it("按 createdAt 删行（返回受影响行数）", async () => {
    const h = harness({ sessionsOld: 3 });
    expect(await h.svc.cleanupExpiredSessions(new Date())).toBe(3);
    const arg = (h.sessionRepo.delete as jest.Mock).mock.calls[0][0];
    expect(arg).toHaveProperty("createdAt");
  });
});

describe("cron 门禁", () => {
  it("非 leader → 什么都不清（多实例不重复删）", async () => {
    const h = harness({ leader: false, sessionsOld: 5 });
    await h.svc.handleDailyCleanup();
    expect(h.sessionRepo.delete).not.toHaveBeenCalled();
    expect(h.mediaRepo.find).not.toHaveBeenCalled();
  });

  it("leader（或 gate 缺席）→ 正常清", async () => {
    const h = harness({ leader: true, sessionsOld: 2 });
    await h.svc.handleDailyCleanup();
    expect(h.sessionRepo.delete).toHaveBeenCalled();
  });
});
