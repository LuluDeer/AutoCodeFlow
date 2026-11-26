/**
 * N9 — 可达性探测接到 capability resolve/dump 的单测（内存替身 repo + 假 probe）。
 *
 * 断言实际副作用：响应体真的带 degradePath / degradationHint，探测口真的被调用；
 * 接口 200 本身不是结论。验收级别：单测 / 内存替身，非真实 PG / Nest DI / 真机 X11。
 */
import "reflect-metadata";

jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
}));

jest.mock("typeorm", () => {
  const deco =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return {
    Column: deco,
    CreateDateColumn: deco,
    Entity: deco,
    Index: deco,
    PrimaryGeneratedColumn: deco,
    UpdateDateColumn: deco,
  };
});

jest.mock("../../../common/errors/app-error", () => ({
  AppError: class AppError extends Error {
    errorCode: string;
    params: unknown;
    constructor(code: string, params?: unknown) {
      super(code);
      this.errorCode = code;
      this.params = params;
    }
  },
}));

jest.mock("../../audit/audit.service", () => ({
  AuditService: class AuditService {},
}));

jest.mock("../../users/entities/user.entity", () => ({
  UserRole: { ADMIN: "admin", USER: "user" },
}));

jest.mock("../dto/create-capability.dto", () => ({
  CAPABILITY_KINDS: ["skill", "mcp", "agent", "provider", "template"],
  CAPABILITY_VISIBILITIES: ["global", "project", "private"],
}));

import { CapabilityController } from "../capability.controller";
import { CapabilityService } from "../capability.service";
import { GHOST_CAPABILITY_ID } from "../reachability";
import {
  ReachabilityProbeService,
  type ProbeFn,
} from "../reachability-probe.service";
import type { ReachabilitySignalStatus } from "../reachability";

interface Row {
  id: string;
  key: string;
  kind: string;
  label: string;
  visibility: string;
  scope: { mode: string; guidance: string };
  source: { type: string; ref?: string };
  manifest: Record<string, unknown>;
  [k: string]: unknown;
}

function makeRepo(seed: Row[]) {
  const rows: Row[] = [...seed];
  return {
    rows,
    find: jest.fn(async () => [...rows]),
    findOne: jest.fn(async () => rows[0] ?? null),
    create: jest.fn((d: Partial<Row>) => ({ id: "cap-1", ...d }) as Row),
    save: jest.fn(async (e: Row) => e),
    remove: jest.fn(async (e: Row) => e),
  };
}

const base: Row = {
  id: "cap-browser",
  key: "browser",
  kind: "skill",
  label: "Browser",
  visibility: "private",
  scope: { mode: "managed", guidance: "L2" },
  source: { type: "builtin" },
  manifest: { name: "browser" },
};

const SEED: Row[] = [
  base,
  {
    ...base,
    id: "cap-filesystem",
    key: "filesystem",
    label: "Filesystem",
    manifest: { name: "filesystem" },
  },
  {
    ...base,
    id: "cap-gui",
    key: "gui",
    label: "GUI",
    manifest: { name: "gui", driver: "x11" },
  },
  {
    ...base,
    id: "cap-ghost",
    key: GHOST_CAPABILITY_ID,
    label: "Ghost ERP",
    manifest: { name: GHOST_CAPABILITY_ID },
  },
];

const dtoFor = (key: string) =>
  ({ key, layers: [{ name: "managed", config: {} }] }) as never;

function harnessFor(status: ReachabilitySignalStatus, ok?: boolean) {
  const probe: jest.Mock = jest.fn(async (_url: string) => ({ status, ok }));
  const probeSvc = new ReachabilityProbeService(probe as ProbeFn);
  const svc = new CapabilityService(
    makeRepo(SEED) as never,
    null,
    null,
    probeSvc,
  );
  const controller = new CapabilityController(svc);
  return { probe, probeSvc, svc, controller };
}

describe("N9 可达性分级接 capability resolve/dump（内存替身）", () => {
  it("(1) 幽灵能力 signal=ok 仍 degradePath=unknown（白名单过滤生效）", async () => {
    const { probe, svc } = harnessFor("ok", true);
    const res = await svc.resolveFor(dtoFor(GHOST_CAPABILITY_ID));
    expect(res.degradePath).toBe("unknown");
    expect(res.degradationHint).toBe("unknown:unknown");
    // ok 信号确实送出过一次，过滤发生在纯分级层，不是「没探测」造成的。
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("(2) 白名单 browser / filesystem unreachable → degradePath=unknown", async () => {
    for (const key of ["browser", "filesystem"]) {
      const { svc } = harnessFor("unreachable", false);
      const res = await svc.resolveFor(dtoFor(key));
      expect(res.degradePath).toBe("unknown");
      expect(res.degradationHint).toBe("unreachable:unknown");
    }
  });

  it("(3) gui + unreachable → x11+fromVideo 真实出现在 resolveFor 与 controller 响应体", async () => {
    const { svc, controller } = harnessFor("denied", false);
    const resolved = await svc.resolveFor(dtoFor("gui"));
    expect(resolved.degradePath).toBe("x11+fromVideo");
    expect(resolved.degradationHint).toContain("x11+fromVideo");

    const viaResolve = await controller.resolve(dtoFor("gui"));
    expect(viaResolve.degradePath).toBe("x11+fromVideo");
    expect(viaResolve.degradationHint).toContain("x11+fromVideo");

    const viaDump = await controller.dump("gui");
    expect(viaDump.degradePath).toBe("x11+fromVideo");
    expect(viaDump.degradationHint).toContain("x11+fromVideo");
  });

  it("(4) timeout / denied 各有一次真实探测调用且 resolve 不抛", async () => {
    for (const status of ["timeout", "denied"] as const) {
      const { probe, svc } = harnessFor(status);
      await expect(svc.resolveFor(dtoFor("gui"))).resolves.toMatchObject({
        key: "gui",
        degradePath: "x11+fromVideo",
      });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith(expect.stringContaining("gui"));
    }
  });

  it("探测口抛错也 fail-open：resolve 不抛，GUI 仍拿到降级标记", async () => {
    const probe = jest.fn(async () => {
      throw new Error("probe transport down");
    });
    const svc = new CapabilityService(
      makeRepo(SEED) as never,
      null,
      null,
      new ReachabilityProbeService(probe as ProbeFn),
    );
    const res = await svc.resolveFor(dtoFor("gui"));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(res.degradePath).toBe("x11+fromVideo");
    expect(res.degradationHint).toBe("unreachable:x11+fromVideo");
  });

  it("探测口缺席：旧响应形状逐字不变（无降级字段）", async () => {
    const svc = new CapabilityService(makeRepo(SEED) as never, null);
    const resolved = await svc.resolveFor(dtoFor("gui"));
    expect(resolved).not.toHaveProperty("degradePath");
    expect(resolved).not.toHaveProperty("degradationHint");
    const dumped = await svc.dumpFor("gui");
    expect(dumped).not.toHaveProperty("degradePath");
  });
});
