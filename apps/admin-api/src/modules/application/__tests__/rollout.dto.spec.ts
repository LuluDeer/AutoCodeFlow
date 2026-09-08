import {
  canaryBatchSize,
  parseManifestHealthCheck,
  RolloutStrategyDto,
  UpgradeAllDto,
} from "../dto/rollout.dto";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

/** DEP-02/DEP-03: rollout DTO + 纯函数（分台/manifest healthCheck 解析）。 */
describe("rollout.dto（DEP-02/03）", () => {
  describe("canaryBatchSize", () => {
    it("1 台应用：任何百分比都取 1（至少 1 台）", () => {
      expect(canaryBatchSize(1, 10)).toBe(1);
      expect(canaryBatchSize(1, 50)).toBe(1);
      expect(canaryBatchSize(1, 99)).toBe(1);
    });

    it("N 台取整：ceil(N×pct%) —— 3 台 34% → 2 台；2 台 50% → 1 台", () => {
      expect(canaryBatchSize(3, 34)).toBe(2); // 1.02 → 2
      expect(canaryBatchSize(2, 50)).toBe(1);
      expect(canaryBatchSize(4, 25)).toBe(1);
      expect(canaryBatchSize(10, 50)).toBe(5);
    });

    it("钳位：pct≤0 → 1 台；pct≥100 → 全部；非法 pct（NaN）回退 50", () => {
      expect(canaryBatchSize(5, 0)).toBe(1);
      expect(canaryBatchSize(5, -20)).toBe(1);
      expect(canaryBatchSize(5, 150)).toBe(5);
      expect(canaryBatchSize(5, 100)).toBe(5);
      expect(canaryBatchSize(4, Number.NaN)).toBe(2); // 50%
    });

    it("0 台/负数：返回 0（无部署不批）", () => {
      expect(canaryBatchSize(0, 50)).toBe(0);
      expect(canaryBatchSize(-3, 50)).toBe(0);
    });
  });

  describe("parseManifestHealthCheck", () => {
    it("完整声明归一化：path/port/interval/failThreshold/timeoutMs 全透传", () => {
      const hc = parseManifestHealthCheck({
        healthCheck: {
          path: "/health",
          port: 8080,
          interval: 2000,
          failThreshold: 5,
          timeoutMs: 1500,
        },
      });
      expect(hc).toEqual({
        path: "/health",
        port: 8080,
        interval: 2000,
        failThreshold: 5,
        timeoutMs: 1500,
      });
    });

    it("缺省：port 缺省 null（回退执行器端口），interval/failThreshold/timeoutMs 取平台缺省", () => {
      const hc = parseManifestHealthCheck({
        healthCheck: { path: "/healthz" },
      });
      expect(hc).toEqual({
        path: "/healthz",
        port: null,
        interval: 5000,
        failThreshold: 3,
        timeoutMs: 3000,
      });
    });

    it("无 healthCheck 键 / manifest 为空 → null（=无健康检查，行为与现状一致）", () => {
      expect(parseManifestHealthCheck(undefined)).toBeNull();
      expect(parseManifestHealthCheck(null)).toBeNull();
      expect(parseManifestHealthCheck({})).toBeNull();
      expect(parseManifestHealthCheck({ healthCheck: null })).toBeNull();
      expect(parseManifestHealthCheck("manifest")).toBeNull();
    });

    it("非法声明 fail-safe 归 null（不 throw）：path 缺失/不以 / 开头/非字符串", () => {
      expect(parseManifestHealthCheck({ healthCheck: {} })).toBeNull();
      expect(
        parseManifestHealthCheck({ healthCheck: { path: "health" } }),
      ).toBeNull();
      expect(
        parseManifestHealthCheck({ healthCheck: { path: 123 } }),
      ).toBeNull();
      // 越界数值字段回退缺省而非拒绝整个声明
      expect(
        parseManifestHealthCheck({ healthCheck: { path: "/h", interval: 1 } })
          ?.interval,
      ).toBe(5000);
      expect(
        parseManifestHealthCheck({ healthCheck: { path: "/h", port: 99999 } })
          ?.port,
      ).toBeNull();
    });
  });

  describe("UpgradeAllDto（ValidationPipe whitelist+transform 全局管线语义）", () => {
    const validateDto = async (body: Record<string, unknown> | undefined) => {
      const dto = plainToInstance(UpgradeAllDto, body);
      const errors = await validate(dto as object, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      return { dto, errors };
    };

    it("无 body / 空对象：合法且 rollout 为 undefined（既有调用零破坏）", async () => {
      // class-transformer 对 undefined source 返回 undefined 实例——
      // 全局 ValidationPipe 实际以 {} 兜底（HTTP body 永远是对象），
      // 这里两条路径都验。
      const a = plainToInstance(UpgradeAllDto, undefined as any);
      expect(a ?? ({} as UpgradeAllDto)).toBeDefined();
      expect((a as any)?.rollout ?? undefined).toBeUndefined();
      const b = await validateDto({});
      expect(b.errors).toHaveLength(0);
      expect(b.dto.rollout).toBeUndefined();
    });

    it("canary 策略 + percentage 合法载荷透传（嵌套校验）", async () => {
      const { dto, errors } = await validateDto({
        rollout: { strategy: "canary", percentage: 34 },
      });
      expect(errors).toHaveLength(0);
      expect(dto.rollout?.strategy).toBe("canary");
      expect(dto.rollout?.percentage).toBe(34);
    });

    it("非白名单键被 forbidNonWhitelisted 拒绝（400 面）", async () => {
      const { errors } = await validateDto({ rollout: { foo: 1 } });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("RolloutStrategyDto 边界", () => {
    it("percentage 越界（0/101/非整数）被校验拒绝", async () => {
      for (const percentage of [0, 101, 3.5]) {
        const dto = plainToInstance(RolloutStrategyDto, {
          strategy: "canary",
          percentage,
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === "percentage")).toBe(true);
      }
    });

    it("strategy 枚举外取值被拒绝；all 合法", async () => {
      const bad = plainToInstance(RolloutStrategyDto, {
        strategy: "blue-green",
      });
      expect((await validate(bad)).some((e) => e.property === "strategy")).toBe(
        true,
      );
      const good = plainToInstance(RolloutStrategyDto, { strategy: "all" });
      expect(await validate(good)).toHaveLength(0);
    });
  });
});
