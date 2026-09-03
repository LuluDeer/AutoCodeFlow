import "reflect-metadata";
import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AiController } from "../ai.controller";
import { AiService } from "../ai.service";
import { SystemConfigService } from "../../config/config.service";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";

/**
 * N11: /ai/config read exposes internal baseUrl/host topology and the write
 * can redirect outbound calls (API key exfiltration) — both ADMIN-only.
 */
describe("AiController (N11)", () => {
  const mockAiService = () => ({
    getEffectiveConfig: jest.fn(),
    analyzeFailure: jest.fn(),
  });
  const mockSystemConfig = () => ({
    findOne: jest.fn(),
    batchUpsert: jest.fn(),
  });

  let controller: AiController;
  let aiSvc: ReturnType<typeof mockAiService>;
  let sysCfg: ReturnType<typeof mockSystemConfig>;

  beforeEach(() => {
    aiSvc = mockAiService();
    sysCfg = mockSystemConfig();
    controller = new AiController(
      aiSvc as unknown as AiService,
      sysCfg as unknown as SystemConfigService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe("RBAC metadata", () => {
    it("getConfig is restricted to ADMIN", () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, AiController.prototype.getConfig),
      ).toEqual([UserRole.ADMIN]);
    });

    it("saveConfig is restricted to ADMIN", () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, AiController.prototype.saveConfig),
      ).toEqual([UserRole.ADMIN]);
    });
  });

  describe("RolesGuard semantics", () => {
    const guard = new RolesGuard(new Reflector());
    const ctxWith = (
      handler: (...args: unknown[]) => unknown,
      role: UserRole,
    ): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => AiController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as unknown as ExecutionContext;

    it("plain user is denied on GET/POST /ai/config (403)", () => {
      expect(
        guard.canActivate(
          ctxWith(AiController.prototype.getConfig, UserRole.USER),
        ),
      ).toBe(false);
      expect(
        guard.canActivate(
          ctxWith(AiController.prototype.saveConfig, UserRole.USER),
        ),
      ).toBe(false);
    });

    it("admin passes on GET/POST /ai/config (200 path)", () => {
      expect(
        guard.canActivate(
          ctxWith(AiController.prototype.getConfig, UserRole.ADMIN),
        ),
      ).toBe(true);
      expect(
        guard.canActivate(
          ctxWith(AiController.prototype.saveConfig, UserRole.ADMIN),
        ),
      ).toBe(true);
    });
  });

  describe("getConfig", () => {
    it("reports hasApiKey without ever returning the key value", async () => {
      aiSvc.getEffectiveConfig.mockResolvedValue({
        provider: "openai",
        openaiModel: "gpt-4o-mini",
        openaiBaseUrl: "https://api.openai.com/v1",
        ollamaHost: "",
        ollamaModel: "",
      });
      sysCfg.findOne.mockResolvedValue({ value: "sk-super-secret" });

      const result = await controller.getConfig();

      expect(result.hasApiKey).toBe(true);
      expect(JSON.stringify(result)).not.toContain("sk-super-secret");
      expect(sysCfg.findOne).toHaveBeenCalledWith("ai.openaiApiKey");
    });
  });
});
