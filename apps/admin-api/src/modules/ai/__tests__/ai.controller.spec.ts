import "reflect-metadata";
import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AiController } from "../ai.controller";
import { AiService } from "../ai.service";
import { SystemConfigService } from "../../config/config.service";
import { AppError } from "../../../common/errors/app-error";
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
    // P1（qwen provider）：getConfig 依赖它判定「是否已配密钥」——缺了会 TypeError
    hasApiKeyForProvider: jest.fn().mockResolvedValue(true),
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

    // R11: POST /ai/test performs a real outbound AI call with the saved
    // config — same posture as the config routes.
    it("testConfig is restricted to ADMIN", () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, AiController.prototype.testConfig),
      ).toEqual([UserRole.ADMIN]);
    });
  });

  describe("RolesGuard semantics", () => {
    const guard = new RolesGuard(new Reflector());
    const ctxWith = (
      handler: (...args: any[]) => unknown,
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

    it("R11: plain user is denied on POST /ai/test (403); admin passes", () => {
      expect(
        guard.canActivate(
          ctxWith(AiController.prototype.testConfig, UserRole.USER),
        ),
      ).toBe(false);
      expect(
        guard.canActivate(
          ctxWith(AiController.prototype.testConfig, UserRole.ADMIN),
        ),
      ).toBe(true);
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

      // P1（qwen provider）：密钥判定改走 hasApiKeyForProvider()——按当前
      // provider 选对应配置键（旧实现硬编码 ai.openaiApiKey，会让「选了
      // qwen 却显示未配置」）。仍然只回布尔，永不回传密钥值。
      expect(aiSvc.hasApiKeyForProvider).toHaveBeenCalledTimes(1);
      expect(result.hasApiKey).toBe(true);
      expect(JSON.stringify(result)).not.toContain("sk-super-secret");
    });
  });

  // P3-1（2026-10-26 审计）：AI 配置数值字段保存面校验——"abc" 此前能保存
  // 成功，运行时 parseInt 失败静默回退默认值，管理员被「保存成功」误导。
  describe("saveConfig numeric whitelist (P3-1)", () => {
    const baseDto = { provider: "qwen" } as const;

    const errOf = async (p: Promise<unknown>): Promise<AppError> =>
      p.then(
        () => {
          throw new Error("expected rejection");
        },
        (e) => e as AppError,
      );

    it("非整数数值字段（abc / 12abc / 1e3 / 越界）→ 400 AI_CONFIG_NUMBER_INVALID，不落库", async () => {
      for (const bad of ["abc", "12abc", "1e3", "0", "-5", "70000"]) {
        sysCfg.batchUpsert.mockClear();
        const err = await errOf(
          controller.saveConfig({ ...baseDto, qwenMaxTokens: bad }),
        );
        expect(err.errorCode).toBe("AI_CONFIG_NUMBER_INVALID");
        expect(err.getStatus()).toBe(400);
        expect(sysCfg.batchUpsert).not.toHaveBeenCalled();
      }
    });

    it("qwenTimeoutMs 同口径校验（非整数/越界 → 400）", async () => {
      for (const bad of ["abc", "0", "3600001"]) {
        const err = await errOf(
          controller.saveConfig({ ...baseDto, qwenTimeoutMs: bad }),
        );
        expect(err.errorCode).toBe("AI_CONFIG_NUMBER_INVALID");
      }
      expect(sysCfg.batchUpsert).not.toHaveBeenCalled();
    });

    it("合法整数与空串放行：值原样进 batchUpsert（空串 = 走默认回退语义）", async () => {
      sysCfg.batchUpsert.mockResolvedValue([]);

      await controller.saveConfig({
        ...baseDto,
        qwenMaxTokens: "8192",
        qwenTimeoutMs: "",
      });

      expect(sysCfg.batchUpsert).toHaveBeenCalledTimes(1);
      const items = sysCfg.batchUpsert.mock.calls[0][0] as Array<{
        key: string;
        value: string;
      }>;
      const maxTokens = items.find((i) => i.key === "ai.qwenMaxTokens");
      const timeout = items.find((i) => i.key === "ai.qwenTimeoutMs");
      expect(maxTokens?.value).toBe("8192");
      // 空串不是 nullish —— 原样落库（运行时 getAiConfig 把空值当未配置）。
      expect(timeout?.value).toBe("");
    });
  });
});
