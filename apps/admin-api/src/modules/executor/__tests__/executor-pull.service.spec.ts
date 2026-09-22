import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ExecutorPullService } from "../executor-pull.service";

/**
 * ARCH-32（ADR-015）: pull 派发队列单元行为——ioredis 打桩（不真连），
 * 断言入队形态 / FIFO 出队 / 过期载荷丢弃 / 畸形载荷丢弃 / 卫生清理。
 */

jest.mock("ioredis", () => ({
  __esModule: true,
  default: class MockRedis {
    constructor() {
      // 桩客户端：rpop 默认空队列，用例内 mockResolvedValueOnce 覆盖。
      // ARCH-33: 队列有两条（acf:pull: 任务 / acf:cmd: 命令），默认空即可——
      // 需要区分队列的用例用 mockImplementation 按 key 分派。
      return {
        lpush: jest.fn().mockResolvedValue(1),
        rpop: jest.fn().mockResolvedValue(null),
        // NETOPT-G P1-8：enqueue / pullWork 的可观测性探测会读 LLEN
        llen: jest.fn().mockResolvedValue(0),
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue("OK"),
        del: jest.fn().mockResolvedValue(1),
        on: jest.fn(),
        quit: jest.fn().mockResolvedValue("OK"),
      };
    }
  },
}));

describe("ExecutorPullService（ARCH-32）", () => {
  const makeService = async (pullTtlMs = "900000", cmdTtlMs = "1800000") => {
    const module = await Test.createTestingModule({
      providers: [
        ExecutorPullService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === "executor.cmdTtlMs" ? cmdTtlMs : pullTtlMs,
            ),
          },
        },
      ],
    }).compile();
    return module.get(ExecutorPullService);
  };

  const clientOf = (svc: ExecutorPullService) =>
    (
      svc as unknown as { ensureClient: () => Record<string, jest.Mock> }
    ).ensureClient();

  /**
   * ARCH-33: 按队列键分派 rpop 返回值——任务队列与命令队列各有独立序列。
   * 单条 rpop.mockResolvedValueOnce 会被「先清命令队列」的第一步吃掉，
   * 是引入命令通道后最容易写错的桩。
   */
  const routeRpop = (
    client: Record<string, jest.Mock>,
    queues: { task?: (string | null)[]; cmd?: (string | null)[] },
  ) => {
    const taskSeq = [...(queues.task ?? [])];
    const cmdSeq = [...(queues.cmd ?? [])];
    client.rpop.mockImplementation(async (key: string) =>
      key.startsWith("acf:cmd:")
        ? (cmdSeq.shift() ?? null)
        : (taskSeq.shift() ?? null),
    );
  };

  it("enqueue：LPUSH 到 acf:pull:{executorId}，载荷附 pushedAt", async () => {
    const svc = await makeService();
    const client = clientOf(svc);

    await svc.enqueue("exec-1", { executionId: "e1", params: {} });

    expect(client.lpush).toHaveBeenCalledTimes(1);
    const [key, body] = client.lpush.mock.calls[0] as [string, string];
    expect(key).toBe("acf:pull:exec-1");
    const parsed = JSON.parse(body);
    expect(parsed.executionId).toBe("e1");
    expect(typeof parsed.pushedAt).toBe("number");
    // PK-14: 派发载荷顶层附 schemaVersion（与 webhook 信封同源常量 EVENT_SCHEMA_VERSION）。
    expect(parsed.schemaVersion).toBe(1);
  });

  // ── NETOPT-G P1-8：入队/取件可观测性（本次事故排查的返工成本）──────────
  //
  // 背景：生产事故排查中"任务到底有没有进队列"反复消耗双方多轮往返——中台侧
  // 只能看到 nginx 的 124B 空响应，执行器侧看不到服务端 LPUSH 结果。以下断言
  // 锁住"入队后回读 LLEN 并记日志"与"wantTask=false 但队列非空时告警"两条
  // 观测路径，防止日后被当作冗余去掉。
  describe("P1-8 队列可观测性", () => {
    const loggerOf = (svc: ExecutorPullService) =>
      (svc as unknown as { logger: Record<string, jest.Mock> }).logger;

    it("enqueue 成功后回读 LLEN 并记录深度（入队确证）", async () => {
      const svc = await makeService();
      const client = clientOf(svc);
      client.llen.mockResolvedValueOnce(3);
      const log = jest.spyOn(loggerOf(svc), "log").mockImplementation(() => {});

      await svc.enqueue("exec-1", { executionId: "e1" });

      expect(client.llen).toHaveBeenCalledWith("acf:pull:exec-1");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("queueDepth=3"));
    });

    it("LLEN 探测失败只 WARN，绝不让已成功的入队失败", async () => {
      const svc = await makeService();
      const client = clientOf(svc);
      client.llen.mockRejectedValueOnce(new Error("redis down"));
      const warn = jest
        .spyOn(loggerOf(svc), "warn")
        .mockImplementation(() => {});

      // 关键：入队本身必须成功——探测是纯观测，不能回滚一次成功派发
      await expect(
        svc.enqueue("exec-1", { executionId: "e1" }),
      ).resolves.toBeUndefined();
      expect(client.lpush).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("depth probe failed"),
      );
    });

    it("wantTask=false（执行器满载）但队列非空时告警——容量/账本不一致信号", async () => {
      const svc = await makeService();
      const client = clientOf(svc);
      client.rpop.mockResolvedValue(null);
      client.llen.mockResolvedValue(5); // 队列里还有 5 条
      const warn = jest
        .spyOn(loggerOf(svc), "warn")
        .mockImplementation(() => {});

      const r = await svc.pullWork("exec-1", 0, { wantTask: false });

      expect(r.task).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("reports no free slots but queue has 5"),
      );
    });

    it("wantTask=false 且队列为空时不告警（正常满载，不是异常）", async () => {
      const svc = await makeService();
      const client = clientOf(svc);
      client.rpop.mockResolvedValue(null);
      client.llen.mockResolvedValue(0);
      const warn = jest
        .spyOn(loggerOf(svc), "warn")
        .mockImplementation(() => {});

      await svc.pullWork("exec-1", 0, { wantTask: false });

      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("reports no free slots"),
      );
    });

    it("wantTask=true 时不触发该探测（正常取件路径零额外 RTT）", async () => {
      const svc = await makeService();
      const client = clientOf(svc);
      routeRpop(client, {
        task: [JSON.stringify({ executionId: "e1", pushedAt: Date.now() })],
      });

      await svc.pullWork("exec-1", 0, { wantTask: true });

      expect(client.llen).not.toHaveBeenCalled();
    });
  });

  it("pull：取到载荷即返回（FIFO 出队 + JSON 解析）", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    routeRpop(client, {
      task: [JSON.stringify({ executionId: "e1", pushedAt: Date.now() })],
    });

    const payload = await svc.pull("exec-1", 0);
    expect(payload).toMatchObject({ executionId: "e1" });
    expect(client.rpop).toHaveBeenCalledWith("acf:pull:exec-1");
  });

  it("SEC-PULL-01：waitMs 为 NaN/Infinity 时必须立即返回，而非永久挂起", async () => {
    // 回归背景：deadline = Date.now() + NaN 后，`Date.now() >= NaN` 恒为 false，
    // 下方 while(true) 永不 break —— 请求被永久挂住（可远程触发的资源耗尽）。
    // 修复后服务层把非有限值收敛为 0（立即取一次即返回）。
    const svc = await makeService();
    const client = clientOf(svc);
    routeRpop(client, {});

    for (const bad of [NaN, Infinity, -Infinity]) {
      const payload = await svc.pull("exec-1", bad as number);
      expect(payload).toBeNull();
    }
    // 空队列 + 立即返回 = 恰好取件一次/轮。ARCH-33 后每轮还会先清一次命令
    // 队列，故按队列键分别断言（任务队列 3 次 = 3 轮，命令队列同为 3 次）。
    const taskCalls = client.rpop.mock.calls.filter(
      (c: unknown[]) => c[0] === "acf:pull:exec-1",
    );
    expect(taskCalls).toHaveLength(3);
  });

  it("SEC-PULL-01：负数 waitMs 同样收敛为立即返回", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    routeRpop(client, {});
    await expect(svc.pull("exec-1", -5000)).resolves.toBeNull();
  });

  it("pull：过期载荷（pushedAt 超 TTL）丢弃不投递", async () => {
    const svc = await makeService("1000");
    const client = clientOf(svc);
    routeRpop(client, {
      task: [
        JSON.stringify({ executionId: "stale", pushedAt: Date.now() - 60_000 }),
      ],
    });

    const payload = await svc.pull("exec-1", 0);
    expect(payload).toBeNull();
  });

  it("pull：畸形 JSON 丢弃不投递", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    routeRpop(client, { task: ["{not-json"] });

    const payload = await svc.pull("exec-1", 0);
    expect(payload).toBeNull();
  });

  it("clear：DEL 队列键（best-effort）", async () => {
    const svc = await makeService();
    const client = clientOf(svc);

    await svc.clear("exec-1");
    expect(client.del).toHaveBeenCalledWith("acf:pull:exec-1");
  });
});

/**
 * ARCH-33（ADR-016）：控制面命令队列。
 *
 * 与任务队列**物理分离**（acf:cmd:{id}）——这样任务派发这条已验收链路的
 * 入队/出队/TTL/单飞语义逐字节不变，命令的更长 TTL 与批量语义也不互相污染。
 */
describe("ExecutorPullService — 控制面命令（ARCH-33）", () => {
  const makeService = async (cmdTtlMs = "1800000", pullTtlMs = "900000") => {
    const module = await Test.createTestingModule({
      providers: [
        ExecutorPullService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === "executor.cmdTtlMs" ? cmdTtlMs : pullTtlMs,
            ),
          },
        },
      ],
    }).compile();
    return module.get(ExecutorPullService);
  };

  const clientOf = (svc: ExecutorPullService) =>
    (
      svc as unknown as { ensureClient: () => Record<string, jest.Mock> }
    ).ensureClient();

  const routeRpop = (
    client: Record<string, jest.Mock>,
    queues: { task?: (string | null)[]; cmd?: (string | null)[] },
  ) => {
    const taskSeq = [...(queues.task ?? [])];
    const cmdSeq = [...(queues.cmd ?? [])];
    client.rpop.mockImplementation(async (key: string) =>
      key.startsWith("acf:cmd:")
        ? (cmdSeq.shift() ?? null)
        : (taskSeq.shift() ?? null),
    );
  };

  it("enqueueCommand：LPUSH 到独立的 acf:cmd:{id}，载荷带 commandId/type/payload/issuedAt", async () => {
    const svc = await makeService();
    const client = clientOf(svc);

    const commandId = await svc.enqueueCommand("exec-1", "app-stop", {
      deploymentId: "d1",
    });

    expect(typeof commandId).toBe("string");
    expect(commandId.length).toBeGreaterThan(0);
    const [key, body] = client.lpush.mock.calls[0] as [string, string];
    // 关键：命令**不**进任务队列
    expect(key).toBe("acf:cmd:exec-1");
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({
      commandId,
      type: "app-stop",
      payload: { deploymentId: "d1" },
    });
    expect(typeof parsed.issuedAt).toBe("number");
    expect(parsed.schemaVersion).toBe(1);
  });

  it("enqueueCommand：两条命令拿到不同 commandId（结果上报的关联键必须唯一）", async () => {
    const svc = await makeService();
    const a = await svc.enqueueCommand("exec-1", "app-stop", {});
    const b = await svc.enqueueCommand("exec-1", "app-uninstall", {});
    expect(a).not.toBe(b);
  });

  it("pullWork：任务与命令同批返回，命令按 FIFO 出队", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    routeRpop(client, {
      task: [JSON.stringify({ executionId: "e1", pushedAt: Date.now() })],
      cmd: [
        JSON.stringify({
          commandId: "c1",
          type: "app-stop",
          payload: {},
          issuedAt: Date.now(),
        }),
        JSON.stringify({
          commandId: "c2",
          type: "app-uninstall",
          payload: {},
          issuedAt: Date.now(),
        }),
      ],
    });

    const { task, commands } = await svc.pullWork("exec-1", 0, {
      wantTask: true,
    });

    expect(task).toMatchObject({ executionId: "e1" });
    expect(commands.map((c) => c.commandId)).toEqual(["c1", "c2"]);
    expect(client.rpop).toHaveBeenCalledWith("acf:cmd:exec-1");
  });

  it("pullWork：wantTask=false 时**绝不碰**任务队列（满载只取命令）", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    routeRpop(client, {
      // 任务队列里有货——但本轮不该被取走（执行器满载，取走也没槽位跑）
      task: [
        JSON.stringify({ executionId: "must-not-take", pushedAt: Date.now() }),
      ],
      cmd: [
        JSON.stringify({
          commandId: "c1",
          type: "config-reload",
          payload: {},
          issuedAt: Date.now(),
        }),
      ],
    });

    const { task, commands } = await svc.pullWork("exec-1", 0, {
      wantTask: false,
    });

    expect(task).toBeNull();
    expect(commands.map((c) => c.commandId)).toEqual(["c1"]);
    // 任务队列**从未**被 rpop——出队即消耗，丢弃等于凭空吞掉一条派发
    const taskDequeues = client.rpop.mock.calls.filter(
      (c: unknown[]) => c[0] === "acf:pull:exec-1",
    );
    expect(taskDequeues).toHaveLength(0);
  });

  it("pullWork：过期命令（issuedAt 超 cmdTtl）丢弃不投递", async () => {
    const svc = await makeService("1000");
    const client = clientOf(svc);
    routeRpop(client, {
      cmd: [
        JSON.stringify({
          commandId: "old",
          type: "deploy",
          payload: {},
          issuedAt: Date.now() - 60_000,
        }),
        JSON.stringify({
          commandId: "fresh",
          type: "deploy",
          payload: {},
          issuedAt: Date.now(),
        }),
      ],
    });

    const { commands } = await svc.pullWork("exec-1", 0, { wantTask: false });
    expect(commands.map((c) => c.commandId)).toEqual(["fresh"]);
  });

  it("pullWork：缺 commandId/type 的畸形命令丢弃", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    routeRpop(client, {
      cmd: [
        JSON.stringify({ type: "deploy", payload: {} }), // 缺 commandId
        JSON.stringify({ commandId: "c1", payload: {} }), // 缺 type
        "{not-json",
        JSON.stringify({
          commandId: "ok",
          type: "deploy",
          payload: {},
          issuedAt: Date.now(),
        }),
      ],
    });

    const { commands } = await svc.pullWork("exec-1", 0, { wantTask: false });
    expect(commands.map((c) => c.commandId)).toEqual(["ok"]);
  });

  it("pullWork：命令数量按 MAX_COMMANDS_PER_PULL 截顶（防单轮响应体被撑爆）", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    const many = Array.from(
      { length: ExecutorPullService.MAX_COMMANDS_PER_PULL + 10 },
      (_, i) =>
        JSON.stringify({
          commandId: `c${i}`,
          type: "app-stop",
          payload: {},
          issuedAt: Date.now(),
        }),
    );
    routeRpop(client, { cmd: many });

    const { commands } = await svc.pullWork("exec-1", 0, { wantTask: false });
    expect(commands).toHaveLength(ExecutorPullService.MAX_COMMANDS_PER_PULL);
  });

  it("clear：任务队列与命令队列一并清理", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    await svc.clear("exec-1");
    expect(client.del).toHaveBeenCalledWith("acf:pull:exec-1");
    expect(client.del).toHaveBeenCalledWith("acf:cmd:exec-1");
  });

  it("recordCommandResult / getCommandResult：结果按 commandId 存取（带 TTL）", async () => {
    const svc = await makeService();
    const client = clientOf(svc);

    await svc.recordCommandResult("cmd-1", { ok: true, type: "deploy" });
    expect(client.set).toHaveBeenCalledWith(
      "acf:cmdres:cmd-1",
      expect.any(String),
      "EX",
      600,
    );

    client.get.mockResolvedValueOnce(
      JSON.stringify({ ok: true, type: "deploy" }),
    );
    await expect(svc.getCommandResult("cmd-1")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("recordCommandResult：写失败不抛出（排障读面，绝不拖累上报响应）", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    client.set.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      svc.recordCommandResult("cmd-1", { ok: true }),
    ).resolves.toBeUndefined();
  });
});
