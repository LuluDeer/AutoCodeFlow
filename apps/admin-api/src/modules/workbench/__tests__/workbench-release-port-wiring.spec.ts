/**
 * ADR-045 发布链 · **模块装配期**的端口解析时机钉子（单测级，假 ModuleRef）。
 *
 * ## 这个文件为什么存在
 *
 * `workbench.module.ts` 的 `RELEASE_APPROVALS_PORT` 原先是
 * `useFactory: (moduleRef) => moduleRef.get(AgentApprovalsService, {strict:false})`。
 * `useFactory` 在 **WorkbenchModule 实例化期**执行，那时 `moduleRef.get` 返回的是
 * 「构造器尚未执行」的空壳（真进程实测 `Object.keys(port) === []`、
 * `port.approvals === undefined`）。于是 `ReleaseApprovalService.requestRelease`
 * 第一步 `this.approvals.buildKey(...)` 就抛
 * `Cannot read properties of undefined (reading 'create')` —— 整条发布链 100% 不可用。
 * 同文件的 `RELEASE_SESSIONS_PORT` / `RELEASE_SOPS_PORT` 是**调用时才** get（惰性），
 * 所以那两个一直正常：差别只在「取真服务的时机」。
 *
 * ## 断言的是什么
 *
 * ① 工厂返回的代理在**模块实例化期不触发** `moduleRef.get`（假 ModuleRef 计数）；
 * ② 首次调用某个方法时才取真服务，之后每次调用都重新取（不缓存空壳）；
 * ③ 代理只暴露 `buildKey` / `request` / `consume` 三个方法，签名与返回语义逐字不变；
 * ④ 真服务在「实例化期还是空壳、调用时才有方法」这一时序下端到端可用
 *    （直接用真 `ReleaseApprovalService` 跑一次 `requestRelease`）。
 *
 * 全部替身：`ModuleRef` 是计数假件，`AgentApprovalsService` 是内存仓储上的真服务。
 * 不连 PG / 不启 Nest —— 真进程级验证由 e2e 覆盖。
 */
import { createHash } from "node:crypto";

import type { ModuleRef } from "@nestjs/core";

import {
  RELEASE_APPROVALS_PORT,
  RELEASE_SESSIONS_PORT,
  RELEASE_SOPS_PORT,
  ReleaseApprovalService,
  type ReleaseApprovalsPort,
} from "../release-approval.service";
import { WorkbenchModule } from "../workbench.module";
import {
  AgentApprovalsService,
  canonicalJson,
} from "../../agent/runtime/agent-approvals.service";
import { AgentSessionService } from "../../agent/runtime/agent-session.service";
import { SopService } from "../../sop/sop.service";
import { sopContentHash, type SopFrontMatter } from "../../sop/sop-frontmatter";

type Row = Record<string, any>;

/** 从模块元数据里取出某个 token 的 provider 定义（不实例化整个模块）。 */
function providerOf(token: symbol): {
  useFactory?: (...args: any[]) => unknown;
  inject?: unknown[];
} {
  const providers = (Reflect.getMetadata("providers", WorkbenchModule) ??
    []) as Array<{ provide?: unknown; useFactory?: (...a: any[]) => unknown }>;
  const found = providers.find((p) => p?.provide === token);
  if (!found) throw new Error(`provider not found: ${String(token)}`);
  return found as { useFactory?: (...args: any[]) => unknown };
}

/**
 * 计数假 ModuleRef：记录 `get()` 被调了几次、每次要的是什么 token。
 *
 * `services` 是「此刻容器里能解析出来的东西」——测试用它模拟
 * 「实例化期构造器还没跑（空壳）→ 调用时才有真方法」这一时序。
 */
function fakeModuleRef(services: Map<unknown, unknown>) {
  const calls: Array<{ token: unknown; strict: unknown }> = [];
  const ref = {
    get: jest.fn((token: unknown, options?: { strict?: boolean }) => {
      calls.push({ token, strict: options?.strict });
      return services.get(token) ?? {};
    }),
  };
  return { ref: ref as unknown as ModuleRef, calls, get: ref.get };
}

function memoryApprovalsRepo(seed: Row[] = []) {
  const rows: Row[] = seed.map((r) => ({ ...r }));
  return {
    create: jest.fn((x: Row) => ({ ...x })),
    save: jest.fn(async (x: Row) => {
      const row: Row = { id: `a-${rows.length + 1}`, ...x };
      rows.push(row);
      return row;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Row }) =>
        rows.find((r) => r.approvalKey === where.approvalKey) ?? null,
    ),
    find: jest.fn(async () => rows),
    update: jest.fn(async () => ({ affected: 1 })),
    rows,
  };
}

const FRONT_MATTER = { title: "装配期钉子", capabilities: ["http"] };
const BODY = "## 步骤\n1. 读取\n2. 产出";
const CONTENT_HASH = sopContentHash(
  FRONT_MATTER as unknown as SopFrontMatter,
  BODY,
);

describe("ADR-045 · RELEASE_APPROVALS_PORT 必须惰性解析", () => {
  it("① 工厂返回代理：模块实例化期零次 moduleRef.get", () => {
    const { ref, calls } = fakeModuleRef(new Map());
    const factory = providerOf(RELEASE_APPROVALS_PORT).useFactory;
    expect(factory).toBeDefined();

    factory!(ref);

    // 这一句是整个缺陷的核心反证：eager 版本在这里已经 get 过一次。
    expect(calls).toHaveLength(0);
    expect(ref.get).not.toHaveBeenCalled();
  });

  it("② 代理只暴露 buildKey / request / consume 三个方法（端口形状不变）", () => {
    const { ref } = fakeModuleRef(new Map());
    const port = providerOf(RELEASE_APPROVALS_PORT).useFactory!(ref) as Record<
      string,
      unknown
    >;

    expect(Object.keys(port).sort()).toEqual([
      "buildKey",
      "consume",
      "request",
    ]);
    for (const k of ["buildKey", "request", "consume"]) {
      expect(typeof port[k]).toBe("function");
    }
    // 端口里不该混入真服务的其它方法（形状漂移会让消费侧的 @Optional 判定失真）。
    expect(port.approvals).toBeUndefined();
  });

  it("③ 首次调用才 get，且每次调用都重新取（不缓存实例化期的空壳）", async () => {
    const repo = memoryApprovalsRepo();
    const real = new AgentApprovalsService(repo as never);
    const services = new Map<unknown, unknown>([[AgentApprovalsService, real]]);
    const { ref, calls } = fakeModuleRef(services);
    const port = providerOf(RELEASE_APPROVALS_PORT).useFactory!(
      ref,
    ) as ReleaseApprovalsPort;

    // 实例化期没取过。
    expect(calls).toHaveLength(0);

    const key = port.buildKey("s-1", "sop_publish", { a: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe(AgentApprovalsService);
    expect(calls[0].strict).toBe(false);
    // buildKey 的返回语义逐字不变：`apr-<sessionId>-<sha256(tool|args)[:16]>`。
    expect(key).toBe(real.buildKey("s-1", "sop_publish", { a: 1 }));

    await port.request({
      approvalKey: key,
      sessionId: "s-1",
      toolName: "sop_publish",
      reason: "r",
      argsDigest: "d",
      preview: null,
      policyFingerprint: "fp",
    });
    // 每次调用现场解析：不是「第一次取到就一直用同一个引用」。
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(repo.rows).toHaveLength(1);
  });

  it("④ 真时序端到端：实例化期真服务是空壳，调用时才有方法 ⇒ requestRelease 成功", async () => {
    const repo = memoryApprovalsRepo();
    const real = new AgentApprovalsService(repo as never);
    // 关键：实例化期容器里放的是**空壳**（模拟构造器尚未执行）。
    const services = new Map<unknown, unknown>([
      [AgentApprovalsService, {} as unknown],
    ]);
    const { ref } = fakeModuleRef(services);
    const port = providerOf(RELEASE_APPROVALS_PORT).useFactory!(
      ref,
    ) as ReleaseApprovalsPort;

    const sessions = {
      create: jest.fn(async () => ({ id: "s-live-1" })),
    };
    const sops = {
      findDraft: jest.fn(async () => ({
        frontMatterJson: FRONT_MATTER as Row,
        bodyMarkdown: BODY,
      })),
      publish: jest.fn(async () => ({})),
    };
    const svc = new ReleaseApprovalService(
      port,
      sessions as never,
      sops as never,
      { currentFingerprint: () => "fp" },
    );

    // 调用那一刻容器里才有真服务（构造器已执行）。
    services.set(AgentApprovalsService, real);

    const out = await svc.requestRelease({
      sopId: "sop-1",
      cardHash: "0123456789abcdef",
      contentHash: CONTENT_HASH,
      username: "alice",
    });

    expect(out.sessionId).toBe("s-live-1");
    expect(out.approvalKey).toBe(
      real.buildKey("s-live-1", "sop_publish", {
        sopId: "sop-1",
        cardHash: "0123456789abcdef",
        contentHash: CONTENT_HASH,
      }),
    );
    // 真落库副作用：一张 pending / once 的单。
    expect(repo.rows[0]).toMatchObject({
      approvalKey: out.approvalKey,
      toolName: "sop_publish",
      scope: "once",
      status: "pending",
    });
    // 反证：没有 `Cannot read properties of undefined (reading 'create')`。
    expect(repo.create).toHaveBeenCalled();
  });

  it("⑤ 对照：sessions / sops 两个端口同样是调用时才 get（回归锚点）", async () => {
    const sessions = { create: jest.fn(async () => ({ id: "s-9" })) };
    const sopSvc = {
      getSop: jest.fn(async () => ({
        frontMatterJson: FRONT_MATTER as Row,
        bodyMarkdown: BODY,
      })),
      publish: jest.fn(async () => ({})),
    };

    const sRef = fakeModuleRef(new Map([[AgentSessionService, sessions]]));
    const sessionsPort = providerOf(RELEASE_SESSIONS_PORT).useFactory!(
      sRef.ref,
    ) as { create: (i: unknown) => Promise<{ id: string }> };
    expect(sRef.calls).toHaveLength(0);
    await sessionsPort.create({ kind: "sop_review", triggerSource: "t" });
    expect(sRef.calls).toHaveLength(1);
    expect(sRef.calls[0].token).toBe(AgentSessionService);

    const pRef = fakeModuleRef(new Map([[SopService, sopSvc]]));
    const sopsPort = providerOf(RELEASE_SOPS_PORT).useFactory!(pRef.ref) as {
      findDraft: (id: string) => Promise<unknown>;
      publish: (i: unknown) => Promise<unknown>;
    };
    expect(pRef.calls).toHaveLength(0);
    await sopsPort.findDraft("sop-1");
    expect(pRef.calls).toHaveLength(1);
    expect(pRef.calls[0].token).toBe(SopService);
  });

  it("⑥ buildKey 与真服务逐字一致（同一份 canonicalJson，不是第二套）", () => {
    const repo = memoryApprovalsRepo();
    const real = new AgentApprovalsService(repo as never);
    const { ref } = fakeModuleRef(new Map([[AgentApprovalsService, real]]));
    const port = providerOf(RELEASE_APPROVALS_PORT).useFactory!(
      ref,
    ) as ReleaseApprovalsPort;

    const args = {
      sopId: "s",
      cardHash: "c",
      contentHash: "h",
      bump: "patch" as const,
    };
    const viaPort = port.buildKey("sess", "sop_publish", args);
    expect(viaPort).toBe(real.buildKey("sess", "sop_publish", args));
    // 键形状：`apr-<sessionId>-<sha256(tool|canonicalJson(args))[:16]>`。
    const digest = createHash("sha256")
      .update(`sop_publish|${canonicalJson(args)}`)
      .digest("hex")
      .slice(0, 16);
    expect(viaPort).toBe(`apr-sess-${digest}`);
  });
});
