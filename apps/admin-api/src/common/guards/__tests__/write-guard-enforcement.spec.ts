import {
  Controller,
  ForbiddenException,
  INestApplication,
  Logger,
  Post,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { WriteGuard } from "../../decorators/write-guard.decorator";
import {
  recordOwnershipAssertion,
  runOwnershipScope,
  snapshotOwnershipAssertions,
} from "../ownership-assertion.store";
import {
  REQUIRED_ASSERTION_KIND,
  WriteGuardEnforcementInterceptor,
} from "../write-guard-enforcement.interceptor";

/**
 * A2-B（DEEP_REVIEW 0ef3bbe §七）：写面授权**缺省拒绝**的行为 spec。
 *
 * 反向保证（本 spec 存在的理由）：A2 那一步只做到了「漏声明会红」，而
 * 「声明了 ownership 但 service 里没真校验」照样绿。本 spec 用合成控制器
 * 把四种形态钉死——落证通过、未落证 500、资源不符 500、种类不符 500；
 * 另钉两条容易踩空的时序语义：
 *   - **异步** handler 里落证也算（ALS 必须跨 await 传播，不能只在同步段有效）；
 *   - 校验本身抛 403 时**不被改写成 500**（错误路径不核对，真实拒绝原因要能
 *     透给前端，同时避免 400 参数校验被误判成授权缺口）。
 */

const REASON = "spec: 只做项目角色校验，属主收紧待 ADR-013 拍板";

@Controller("probe")
class ProbeController {
  @Post("owned-checked")
  @WriteGuard("task", { scope: "ownership" })
  ownedChecked() {
    recordOwnershipAssertion("task", "write");
    return { ok: true };
  }

  @Post("owned-async-checked")
  @WriteGuard("task", { scope: "ownership" })
  async ownedAsyncChecked() {
    await new Promise((r) => setTimeout(r, 1));
    recordOwnershipAssertion("task", "write");
    return { ok: true };
  }

  @Post("owned-unchecked")
  @WriteGuard("task", { scope: "ownership" })
  ownedUnchecked() {
    return { ok: true };
  }

  @Post("owned-wrong-resource")
  @WriteGuard("task", { scope: "ownership" })
  ownedWrongResource() {
    recordOwnershipAssertion("application", "write");
    return { ok: true };
  }

  @Post("owned-wrong-kind")
  @WriteGuard("task", { scope: "ownership" })
  ownedWrongKind() {
    // 只做了 project-role 级别的校验，不能冒充 ownership
    recordOwnershipAssertion("task", "operate");
    return { ok: true };
  }

  @Post("owned-forbidden")
  @WriteGuard("task", { scope: "ownership" })
  ownedForbidden(): never {
    recordOwnershipAssertion("task", "write");
    throw new ForbiddenException("You do not own this task");
  }

  @Post("owned-bad-request")
  @WriteGuard("task", { scope: "ownership" })
  ownedBadRequest(): never {
    throw new Error("boom");
  }

  @Post("role-checked")
  @WriteGuard("task", { scope: "project-role", reason: REASON })
  roleChecked() {
    recordOwnershipAssertion("task", "operate");
    return { ok: true };
  }

  @Post("role-unchecked")
  @WriteGuard("task", { scope: "project-role", reason: REASON })
  roleUnchecked() {
    return { ok: true };
  }

  @Post("auth-only")
  @WriteGuard("session", { scope: "authenticated" })
  authOnly() {
    return { ok: true };
  }

  @Post("no-declaration")
  noDeclaration() {
    return { ok: true };
  }
}

describe("A2-B 写面授权强制（WriteGuardEnforcementInterceptor）", () => {
  let app: INestApplication;
  let server: unknown;
  let errorSpy: jest.SpyInstance;

  beforeAll(async () => {
    errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        {
          provide: APP_INTERCEPTOR,
          useClass: WriteGuardEnforcementInterceptor,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    errorSpy.mockRestore();
  });

  const hit = (path: string) => request(server as never).post(`/probe/${path}`);

  it("声明 ownership 且确已落属主断言证据 → 放行", async () => {
    const res = await hit("owned-checked");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it("异步 handler 中落证同样有效（ALS 必须跨 await 传播）", async () => {
    const res = await hit("owned-async-checked");
    expect(res.status).toBe(201);
  });

  it("声明 ownership 但全程未落证 → 500 缺省拒绝（不静默放行）", async () => {
    const res = await hit("owned-unchecked");
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ProbeController.ownedUnchecked"),
    );
  });

  it("落证资源与声明 resource 不符 → 500（校验了别的东西不算数）", async () => {
    const res = await hit("owned-wrong-resource");
    expect(res.status).toBe(500);
  });

  it("只落 'operate' 证不能冒充 'ownership'（project-role ≠ ownership）", async () => {
    const res = await hit("owned-wrong-kind");
    expect(res.status).toBe(500);
  });

  it("属主校验本身抛 403 → 原样透出，不被改写成 500", async () => {
    const res = await hit("owned-forbidden");
    expect(res.status).toBe(403);
  });

  it("handler 抛非授权错误（如参数校验失败）→ 不被误判成授权缺口", async () => {
    const res = await hit("owned-bad-request");
    expect(res.status).toBe(500);
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("ProbeController.ownedBadRequest"),
    );
  });

  it("project-role 端点落 'operate' 证 → 放行", async () => {
    const res = await hit("role-checked");
    expect(res.status).toBe(201);
  });

  it("project-role 端点未落证 → 同样 500", async () => {
    const res = await hit("role-unchecked");
    expect(res.status).toBe(500);
  });

  it("authenticated / 无声明的写端点不受本拦截器约束", async () => {
    expect((await hit("auth-only")).status).toBe(201);
    expect((await hit("no-declaration")).status).toBe(201);
  });

  it("scope → 断言种类映射表钉死（改语义必须改这里）", () => {
    expect(REQUIRED_ASSERTION_KIND).toEqual({
      ownership: "write",
      "project-role": "operate",
    });
  });
});

describe("A2-B 断言证据通道（ownership-assertion.store）", () => {
  it("请求作用域外落证为 no-op，不抛错也不产生证据", () => {
    expect(() => recordOwnershipAssertion("task", "write")).not.toThrow();
    expect(snapshotOwnershipAssertions()).toEqual([]);
  });

  it("同一作用域内的多次落证可累积，作用域之间互不串扰", async () => {
    const seen = await Promise.all([
      runOwnershipScope(async () => {
        recordOwnershipAssertion("task", "write");
        await new Promise((r) => setTimeout(r, 5));
        recordOwnershipAssertion("application", "write");
        return snapshotOwnershipAssertions();
      }),
      runOwnershipScope(async () => {
        await new Promise((r) => setTimeout(r, 1));
        recordOwnershipAssertion("event-subscription", "write");
        return snapshotOwnershipAssertions();
      }),
    ]);
    expect(seen[0]).toEqual(["application:write", "task:write"]);
    expect(seen[1]).toEqual(["event-subscription:write"]);
  });
});
