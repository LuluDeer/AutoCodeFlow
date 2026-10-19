import { Logger } from "@nestjs/common";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AgentMediaRetentionService } from "../agent-media-retention.service";

/**
 * F-5b（ARCH-27 配置收口）：Agent 媒体保留期的读取路径。
 *
 * 此前本服务裸读 env 键 "AGENT_MEDIA_RETENTION_DAYS"（ConfigService 的
 * process.env 回退）——Joi 已注册、configuration.ts 却未映射，属于审计登记
 * 的「注册面/映射面/消费面三方漂移」形态。收口后：configuration.ts 的
 * agent.mediaRetentionDays 承载 env 映射与默认值，本服务只读收口后的配置节，
 * 并保留一层防御性兜底（单测装配 ConfigService 缺席该节时回退 7）。
 */
describe("AgentMediaRetentionService.resolveRetentionDays（F-5b 配置收口）", () => {
  const makeService = (configValue: unknown) => {
    const config = { get: jest.fn().mockReturnValue(configValue) };
    const service = new AgentMediaRetentionService(
      // @Optional 的 LeaderGateService / mediaRepo 在本用例中不触达
      null as never,
      {} as never,
      config as never,
    );
    return { service, config };
  };

  it("读取收口后的 agent.mediaRetentionDays（不再裸读 env 键）", () => {
    const { service, config } = makeService(14);
    expect(
      (
        service as unknown as { resolveRetentionDays(): number }
      ).resolveRetentionDays(),
    ).toBe(14);
    expect(config.get).toHaveBeenCalledWith("agent.mediaRetentionDays");
  });

  it("缺省/非法值回退 7（roadmap §11 决策值，与旧运行时回退逐字节一致）", () => {
    for (const bad of [undefined, null, 0, -3, Number.NaN, "14"]) {
      const { service } = makeService(bad);
      expect(
        (
          service as unknown as { resolveRetentionDays(): number }
        ).resolveRetentionDays(),
      ).toBe(7);
    }
  });
});

// ============================================================================
// P7b 清理任务本体：目录粒度回收 + DB 清单同步。
//
// 这些用例钉的是「媒体 TTL 清理到底删了谁」的四条真实不变量：
//  ① 目录内**最旧**文件超龄 → 整目录删（不是删文件级），DB 同 assignmentId
//     的行一起删（否则留「下载 404」的僵尸行）；
//  ② 保留期是**严格小于**：恰好等于 cutoff 的目录必须留下（边界不多删一天）；
//  ③ 只删过期、不动在途——同根下「有新鲜文件」的目录/空目录/游离文件一律保留；
//  ④ best-effort：单目录失败只跳过、DB 删失败不阻断其余目录，绝不抛出。
// 另钉 Leader 门禁（多实例只让 leader 删）与 cron 兜底（失败只记日志）。
// 盘上用真实临时目录（与 scripts/agent-sop-check.mjs 同手法），不 mock fs——
// 目录整删/空目录回退目录 mtime 这些行为只有真 FS 才成立。
// ============================================================================
describe("AgentMediaRetentionService.cleanupExpiredMedia（目录粒度 TTL 回收）", () => {
  const DAY = 86_400_000;
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const C = "33333333-3333-3333-3333-333333333333";

  let root: string;
  let mediaRepo: { delete: jest.Mock };
  let retentionDays: number | undefined;
  let service: AgentMediaRetentionService;

  /** 在 <root>/<assignmentId>/ 下写文件，并把 mtime 拨到 ageDays 天前。 */
  const writeMedia = (assignmentId: string, name: string, ageDays: number) => {
    const dir = path.join(root, assignmentId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, "x");
    const when = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(file, when, when);
    return file;
  };

  const makeDir = (assignmentId: string, ageDays: number) => {
    const dir = path.join(root, assignmentId);
    fs.mkdirSync(dir, { recursive: true });
    const when = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(dir, when, when);
    return dir;
  };

  const build = (
    leaderGate: { isLeader: boolean } | null = null,
  ): AgentMediaRetentionService =>
    new AgentMediaRetentionService(
      leaderGate as never,
      mediaRepo as never,
      {
        get: (key: string) =>
          key === "agent.mediaRetentionDays" ? retentionDays : undefined,
      } as never,
    );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-media-retention-"));
    process.env.AGENT_MEDIA_DIR = root;
    mediaRepo = { delete: jest.fn().mockResolvedValue({ affected: 1 }) };
    retentionDays = 7;
    service = build();
  });

  afterEach(() => {
    delete process.env.AGENT_MEDIA_DIR;
    fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("① 最旧文件超龄 → 整目录删 + 同 assignmentId 的 DB 行同步删；新鲜目录原样保留", async () => {
    // A：8 天前的旧文件 + 刚刚的新文件（最旧者决定整目录命运 → 删整目录）
    writeMedia(A, "old.png", 8);
    writeMedia(A, "fresh.png", 0);
    // B：全部新鲜（在途指派的证据）→ 必须留下
    writeMedia(B, "new.png", 1);

    const removed = await service.cleanupExpiredMedia(new Date());

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(root, A))).toBe(false); // 整目录，不是删单文件
    expect(fs.existsSync(path.join(root, B))).toBe(true);
    expect(mediaRepo.delete).toHaveBeenCalledTimes(1);
    expect(mediaRepo.delete).toHaveBeenCalledWith({ assignmentId: A });
    expect(mediaRepo.delete).not.toHaveBeenCalledWith({ assignmentId: B });
  });

  it("② 保留期边界是严格小于：恰好等于 cutoff 的目录保留，早 1 秒才删", async () => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 7 * DAY);
    // C：目录自身 mtime 恰好 == cutoff（空目录走目录 mtime 分支）→ 不多删
    const dirC = makeDir(C, 7);
    fs.utimesSync(dirC, cutoff, cutoff);
    // B：早 1 秒 → 越界，删
    const dirB = makeDir(B, 7);
    fs.utimesSync(dirB, new Date(cutoff.getTime() - 1000), new Date(cutoff.getTime() - 1000));

    const removed = await service.cleanupExpiredMedia(now);

    expect(removed).toBe(1);
    expect(fs.existsSync(dirC)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(false);
    expect(mediaRepo.delete).toHaveBeenCalledWith({ assignmentId: B });
    expect(mediaRepo.delete).not.toHaveBeenCalledWith({ assignmentId: C });
  });

  it("③ 空目录按目录自身 mtime 判定（无文件可看时不以「无 mtime」漏删）", async () => {
    makeDir(A, 30); // 空且 30 天前
    makeDir(B, 0); // 空且刚刚

    const removed = await service.cleanupExpiredMedia(new Date());

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(root, A))).toBe(false);
    expect(fs.existsSync(path.join(root, B))).toBe(true);
  });

  it("③ 根下的游离文件（非目录）被跳过：不删、也不触发 DB 删除", async () => {
    const stray = path.join(root, "stray.log");
    fs.writeFileSync(stray, "x");
    fs.utimesSync(stray, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));

    const removed = await service.cleanupExpiredMedia(new Date());

    expect(removed).toBe(0);
    expect(fs.existsSync(stray)).toBe(true);
    expect(mediaRepo.delete).not.toHaveBeenCalled();
  });

  it("保留天数取自配置：retention=1 时 2 天前的目录被删（默认 7 天语义下会保留）", async () => {
    writeMedia(A, "two-days.png", 2);

    // 默认 7 天：保留
    expect(await service.cleanupExpiredMedia(new Date())).toBe(0);
    expect(fs.existsSync(path.join(root, A))).toBe(true);

    // 配置收紧到 1 天：同一目录过期
    retentionDays = 1;
    service = build();
    expect(await service.cleanupExpiredMedia(new Date())).toBe(1);
    expect(fs.existsSync(path.join(root, A))).toBe(false);
    expect(mediaRepo.delete).toHaveBeenCalledWith({ assignmentId: A });
  });

  it("根目录不存在 → 返回 0 且不触碰 DB（首次部署/未落盘）", async () => {
    process.env.AGENT_MEDIA_DIR = path.join(root, "does-not-exist");

    await expect(service.cleanupExpiredMedia(new Date())).resolves.toBe(0);
    expect(mediaRepo.delete).not.toHaveBeenCalled();
  });

  it("④ best-effort：单个目录的 DB 同步删失败不阻断其余目录，也不抛出", async () => {
    writeMedia(A, "old.png", 30);
    writeMedia(C, "old.png", 30);
    mediaRepo.delete.mockImplementation(async (where: { assignmentId: string }) => {
      if (where.assignmentId === A) throw new Error("db down");
      return { affected: 1 };
    });

    const removed = await service.cleanupExpiredMedia(new Date());

    // A 的失败被吞掉（不计入成功数），C 照常处理——循环不中断
    expect(removed).toBe(1);
    expect(mediaRepo.delete).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(root, C))).toBe(false);
    expect(fs.existsSync(path.join(root, A))).toBe(false);
  });

  it("Leader 门禁：非 leader 的 cron 直接返回，一个目录都不动（多实例不重复删）", async () => {
    writeMedia(A, "old.png", 30);
    const logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});

    await build({ isLeader: false }).handleDailyCleanup();

    expect(fs.existsSync(path.join(root, A))).toBe(true);
    expect(mediaRepo.delete).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("Leader cron：leader 执行清理并按删除目录数记一条 log", async () => {
    writeMedia(A, "old.png", 30);
    const logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});

    await build({ isLeader: true }).handleDailyCleanup();

    expect(fs.existsSync(path.join(root, A))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("清理 1 个过期指派媒体目录"),
    );
  });

  it("cron 兜底：配置读取抛错 → 只记 error 日志，handleDailyCleanup 不抛（等下一轮）", async () => {
    writeMedia(A, "old.png", 30);
    const errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    const broken = new AgentMediaRetentionService(
      { isLeader: true } as never,
      mediaRepo as never,
      {
        get: () => {
          throw new Error("config exploded");
        },
      } as never,
    );

    await expect(broken.handleDailyCleanup()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Agent media retention failed: config exploded"),
    );
    // 失败发生在扫描之前：目录原样保留，等下一轮 cron
    expect(fs.existsSync(path.join(root, A))).toBe(true);
  });

  it("根路径不可读（被误置成普通文件）→ warn 后返回 0，绝不抛", async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const fileAsRoot = path.join(root, "agent-media-is-a-file");
    fs.writeFileSync(fileAsRoot, "x");
    process.env.AGENT_MEDIA_DIR = fileAsRoot;

    await expect(service.cleanupExpiredMedia(new Date())).resolves.toBe(0);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("无法读取媒体根目录"),
    );
    expect(mediaRepo.delete).not.toHaveBeenCalled();
  });

  it("非 Error 抛出物照样被收敛（cron 兜底与 per-dir skip 都走 String(err) 分支）", async () => {
    writeMedia(A, "old.png", 30);
    writeMedia(C, "old.png", 30);
    const debugSpy = jest
      .spyOn(Logger.prototype, "debug")
      .mockImplementation(() => {});
    const errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    mediaRepo.delete.mockImplementation(async (where: { assignmentId: string }) => {
      if (where.assignmentId === A) throw "plain-string-db-error";
      return { affected: 1 };
    });

    expect(await service.cleanupExpiredMedia(new Date())).toBe(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("plain-string-db-error"),
    );

    const broken = new AgentMediaRetentionService(
      { isLeader: true } as never,
      mediaRepo as never,
      {
        get: () => {
          throw "plain-string-config-error";
        },
      } as never,
    );
    await expect(broken.handleDailyCleanup()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("plain-string-config-error"),
    );
  });

  it("删除是幂等的：连续两轮清理第二轮返回 0（无重复 DB 删）", async () => {
    writeMedia(A, "old.png", 30);

    expect(await service.cleanupExpiredMedia(new Date())).toBe(1);
    expect(await service.cleanupExpiredMedia(new Date())).toBe(0);
    expect(mediaRepo.delete).toHaveBeenCalledTimes(1);
  });
});
