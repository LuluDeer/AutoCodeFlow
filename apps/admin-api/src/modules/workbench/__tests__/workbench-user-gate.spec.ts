import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { UserRole } from "../../users/entities/user.entity";
import { SopService } from "../../sop/sop.service";
import { QUOTA_HARD_LIMIT_GATE } from "../../capability-activation/quota-limit.gate";
import {
  CapabilityActivationRecorder,
  WorkbenchController,
} from "../workbench.controller";
import { PolicyGenerationService } from "../policy-generation.service";
import { PartProjectionService } from "../part-projection.service";
import { RewindRunner } from "../rewind-runner";
import { buildPreview, computePolicyGeneration } from "../preview-validator";

/**
 * GCO §5：role=user 可提交方案卡（preview/commit/part/project），
 * 但 rewind（作废在途写入）仍是 ADMIN 管理面。
 *
 * 验收口径：HTTP 层跑真实 Nest + 真 RolesGuard（JWT 仅用测试替身注入身份），
 * 并断言实际副作用（draft 的 createdBy / publish 与 sop_versions 零调用），
 * 不是只看 2xx。
 */
describe("Workbench 用户放行闸门（GCO §5）", () => {
  const GEN = computePolicyGeneration();
  const goal = "汇总昨日订单异常并推送日报";
  const cadence = "daily" as const;
  const previewed = buildPreview({ goal, cadence });
  const validCommit = {
    goal,
    cadence,
    expectedCardHash: previewed.cardHash,
    expectedPolicyGeneration: GEN,
  };

  // —— 装饰器元数据：类级全放开，逐端点显式声明 ——
  describe("角色声明", () => {
    it("类级 @Roles(ADMIN) 已移除，@UseGuards(JwtAuthGuard) 仍在", () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, WorkbenchController),
      ).toBeUndefined();
      expect(
        (Reflect.getMetadata(GUARDS_METADATA, WorkbenchController) ?? []).some(
          (g: unknown) => g === JwtAuthGuard,
        ),
      ).toBe(true);
    });

    it("preview/commit/projectPart 允许 ADMIN+USER；rewind 仅 ADMIN", () => {
      for (const method of ["preview", "commit", "projectPart"] as const) {
        expect(
          Reflect.getMetadata(ROLES_KEY, WorkbenchController.prototype[method]),
        ).toEqual([UserRole.ADMIN, UserRole.USER]);
      }
      expect(
        Reflect.getMetadata(ROLES_KEY, WorkbenchController.prototype.rewind),
      ).toEqual([UserRole.ADMIN]);
    });
  });

  describe("HTTP 行为 + 副作用", () => {
    let app: INestApplication;

    const draft = jest.fn(async (input: any) => ({ id: "sop-1", ...input }));
    const publish = jest.fn(async () => ({}));
    const versionInsert = jest.fn(async () => ({})); // sop_versions 写入替身
    const activationRecord = jest.fn(async () => ({ id: "act-1" }));
    const rewind = jest.fn(async () => ({
      resourceId: "res-1",
      allowedCount: 0,
      invalidatedCount: 0,
      executedWriteIds: [] as string[],
      generation: GEN,
    }));
    const projectById = jest.fn(async () => ({ partId: "p1", visible: true }));
    const evaluateHardLimit = jest.fn(async () => ({ blocked: false }));

    // 只替身认证；角色判定交给真实的全局 RolesGuard（与仓库 RBAC spec 同构）。
    const jwtGuard = {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const role = req.headers["x-test-role"];
        if (!role) throw new UnauthorizedException();
        req.user = {
          id: Number(req.headers["x-test-user-id"] ?? 42),
          username: req.headers["x-test-username"] ?? "alice",
          role,
        };
        return true;
      },
    };

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        controllers: [WorkbenchController],
        providers: [
          {
            provide: SopService,
            useValue: { draft, publish, versionInsert },
          },
          {
            provide: CapabilityActivationRecorder,
            useValue: { record: activationRecord },
          },
          {
            provide: PolicyGenerationService,
            useValue: { currentGeneration: async () => GEN },
          },
          { provide: QUOTA_HARD_LIMIT_GATE, useValue: { evaluateHardLimit } },
          { provide: RewindRunner, useValue: { rewind } },
          { provide: PartProjectionService, useValue: { projectById } },
          { provide: APP_GUARD, useValue: jwtGuard },
          { provide: APP_GUARD, useClass: RolesGuard },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue(jwtGuard)
        .compile();

      app = module.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => {
      jest.clearAllMocks();
      evaluateHardLimit.mockResolvedValue({ blocked: false } as any);
      projectById.mockResolvedValue({ partId: "p1", visible: true } as any);
    });

    const asUser = (req: request.Test) =>
      req
        .set("x-test-role", UserRole.USER)
        .set("x-test-user-id", "42")
        .set("x-test-username", "alice");

    it("preview 对 user 可达，且确定性闸门仍在（不落库）", async () => {
      const ok = await asUser(
        request(app.getHttpServer()).post("/workbench/preview").send({
          goal,
          cadence,
        }),
      ).expect(201);
      expect(ok.body.eligible).toBe(true);
      expect(ok.body.cardHash).toBe(previewed.cardHash);
      expect(ok.body.policyGeneration).toBe(GEN);
      expect(draft).not.toHaveBeenCalled();

      const bad = await asUser(
        request(app.getHttpServer())
          .post("/workbench/preview")
          .send({
            goal,
            cadence,
            params: { capabilityId: "not-in-whitelist" },
          }),
      ).expect(201);
      expect(bad.body.eligible).toBe(false);
      expect(
        bad.body.checks.some(
          (c: { field: string; status: string }) =>
            c.field === "capabilityId" && c.status === "fail",
        ),
      ).toBe(true);
      expect(draft).not.toHaveBeenCalled();
    });

    it("user 调 commit → 落 draft（createdBy=user:42），不 publish、sop_versions 零新增", async () => {
      const res = await asUser(
        request(app.getHttpServer())
          .post("/workbench/commit")
          // 请求体伪造 createdBy 也不得覆盖服务端 user:<id>
          .send({ ...validCommit, createdBy: "user:999" }),
      ).expect(201);

      expect(res.body.status).toBe("draft");
      expect(res.body.next).toBe("请在 SOP 页面审阅并发布");
      expect(res.body.policyGeneration).toBe(GEN);
      expect(draft).toHaveBeenCalledTimes(1);
      expect(draft).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: `workbench-${previewed.cardHash.slice(0, 8)}`,
          createdBy: "user:42",
          audit: { userId: 42, username: "alice", ip: expect.anything() },
        }),
      );
      expect(activationRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilityKey: "workbench.commit",
          userId: 42,
          username: "alice",
          result: "success",
        }),
      );
      // 发布/版本面零调用：commit 只落 draft。
      expect(publish).not.toHaveBeenCalled();
      expect(versionInsert).not.toHaveBeenCalled();
    });

    it("commit 五道闸对 user 仍生效（hash / eligible / generation / quota），全部零落库", async () => {
      // 第一闸：hash 不匹配
      await asUser(
        request(app.getHttpServer())
          .post("/workbench/commit")
          .send({ ...validCommit, expectedCardHash: "0000000000000000" }),
      ).expect(400);
      // 第二闸：eligible=false 的卡
      const badPreview = buildPreview({
        goal,
        cadence,
        params: { capabilityId: "not-in-whitelist" },
      });
      await asUser(
        request(app.getHttpServer())
          .post("/workbench/commit")
          .send({
            goal,
            cadence,
            params: { capabilityId: "not-in-whitelist" },
            expectedCardHash: badPreview.cardHash,
            expectedPolicyGeneration: GEN,
          }),
      ).expect(400);
      // 第三闸：代际不匹配
      await asUser(
        request(app.getHttpServer())
          .post("/workbench/commit")
          .send({
            ...validCommit,
            expectedPolicyGeneration: "0000000000000000",
          }),
      ).expect(400);
      // 第四闸：配额超限 → 429
      evaluateHardLimit.mockResolvedValueOnce({
        blocked: true,
        matched: {
          scope: "capability",
          target: "workbench.commit",
          usage: 1,
          hardLimit: 1,
          windowDays: 30,
        },
      } as any);
      await asUser(
        request(app.getHttpServer())
          .post("/workbench/commit")
          .send(validCommit),
      ).expect(429);

      expect(draft).not.toHaveBeenCalled();
      expect(activationRecord).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(versionInsert).not.toHaveBeenCalled();
    });

    it("rewind 对 user 返回 403 且零作废；admin 仍可用", async () => {
      await asUser(
        request(app.getHttpServer())
          .post("/workbench/rewind")
          .send({ sessionId: "s-1", partIds: ["p1"] }),
      ).expect(403);
      expect(rewind).not.toHaveBeenCalled();

      await request(app.getHttpServer())
        .post("/workbench/rewind")
        .set("x-test-role", UserRole.ADMIN)
        .send({ sessionId: "s-1", partIds: ["p1"] })
        .expect(201);
      expect(rewind).toHaveBeenCalledTimes(1);
    });

    it("projectPart 对 user 可达，viewer 原样交给服务端投影（isOwner 口径）", async () => {
      const res = await asUser(
        request(app.getHttpServer())
          .post("/workbench/part/project")
          .send({ partId: "p1" }),
      ).expect(201);
      expect(res.body.partId).toBe("p1");
      expect(projectById).toHaveBeenCalledWith(
        "p1",
        GEN,
        expect.objectContaining({ id: 42, username: "alice", role: "user" }),
      );
    });

    it("无身份仍 401（JwtAuthGuard 未被放宽）", async () => {
      await request(app.getHttpServer())
        .post("/workbench/commit")
        .send(validCommit)
        .expect(401);
      expect(draft).not.toHaveBeenCalled();
    });
  });
});
