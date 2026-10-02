import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  CreateDeploymentDto,
  DeploymentHeartbeatDto,
  DEPLOYMENT_ENV_MAX_KEYS,
  DEPLOYMENT_ENV_VALUE_MAX_BYTES,
  DeploymentEnvSizeConstraint,
} from "../dto/app-deployment.dto";

/**
 * A-11: 部署域 DTO 尺寸闸。
 *
 * env 是执行器自由形状的 jsonb 载荷、startCommand / 心跳 message 随部署行落库
 * 并进列表读面——此前三者均无体积上限，异常/被污染的调用方可以借它们无限写
 * jsonb 与 statusMessage（text 列），且每个 GET 列表都要反序列化一遍。
 */
describe("app-deployment.dto（A-11 尺寸闸）", () => {
  const buildCreate = (input: Record<string, unknown>) =>
    plainToInstance(CreateDeploymentDto, input as object);

  describe("env 体积闸（键数 ≤50 + 单值 ≤4KB）", () => {
    it("常规 env 通过", async () => {
      const dto = buildCreate({
        env: { NODE_ENV: "production", LOG_LEVEL: "debug" },
      });
      const errors = await validate(dto, {
        skipMissingProperties: true,
      });
      expect(errors).toHaveLength(0);
    });

    it(`超过 ${DEPLOYMENT_ENV_MAX_KEYS} 个键 → 拒绝`, async () => {
      const env: Record<string, string> = {};
      for (let i = 0; i <= DEPLOYMENT_ENV_MAX_KEYS; i++) {
        env[`K${i}`] = "v";
      }
      const dto = buildCreate({ env });
      const errors = await validate(dto, { skipMissingProperties: true });
      const envError = errors.find((e) => e.property === "env");
      expect(envError).toBeDefined();
      expect(envError!.constraints).toHaveProperty("deploymentEnvSize");
    });

    it(`恰好 ${DEPLOYMENT_ENV_MAX_KEYS} 个键 → 通过（边界）`, async () => {
      const env: Record<string, string> = {};
      for (let i = 0; i < DEPLOYMENT_ENV_MAX_KEYS; i++) {
        env[`K${i}`] = "v";
      }
      const dto = buildCreate({ env });
      const errors = await validate(dto, { skipMissingProperties: true });
      expect(errors.find((e) => e.property === "env")).toBeUndefined();
    });

    it(`单值超过 ${DEPLOYMENT_ENV_VALUE_MAX_BYTES} 字节 → 拒绝`, async () => {
      const dto = buildCreate({
        env: { BIG: "x".repeat(DEPLOYMENT_ENV_VALUE_MAX_BYTES + 1) },
      });
      const errors = await validate(dto, { skipMissingProperties: true });
      expect(errors.find((e) => e.property === "env")).toBeDefined();
    });

    it("单值恰好在 4KB 边界 → 通过；非字符串值 → 拒绝", async () => {
      const ok = buildCreate({
        env: { EDGE: "x".repeat(DEPLOYMENT_ENV_VALUE_MAX_BYTES) },
      });
      expect(
        (await validate(ok, { skipMissingProperties: true })).find(
          (e) => e.property === "env",
        ),
      ).toBeUndefined();

      // 类型面是 Record<string, string>——非字符串值一并拦下
      const bad = buildCreate({ env: { NESTED: { a: 1 } } });
      expect(
        (await validate(bad, { skipMissingProperties: true })).find(
          (e) => e.property === "env",
        ),
      ).toBeDefined();
    });

    it("约束类独立可测：非对象形态放行（由 @IsObject 把关）", () => {
      const constraint = new DeploymentEnvSizeConstraint();
      expect(constraint.validate(null)).toBe(true);
      expect(constraint.validate(undefined)).toBe(true);
      expect(constraint.validate([["K", "v"]])).toBe(true);
      expect(constraint.validate({ K: "v" })).toBe(true);
    });
  });

  describe("startCommand MaxLength(2000)", () => {
    it("超长 startCommand → 拒绝", async () => {
      const dto = buildCreate({ startCommand: "x".repeat(2001) });
      const errors = await validate(dto, { skipMissingProperties: true });
      const sc = errors.find((e) => e.property === "startCommand");
      expect(sc).toBeDefined();
      expect(Object.values(sc!.constraints ?? {}).join(" ")).toContain("2000");
    });

    it("2000 字符边界 → 通过", async () => {
      const dto = buildCreate({ startCommand: "x".repeat(2000) });
      expect(
        (await validate(dto, { skipMissingProperties: true })).find(
          (e) => e.property === "startCommand",
        ),
      ).toBeUndefined();
    });
  });

  describe("心跳 message MaxLength(2000)", () => {
    it("异常执行器灌大 message → 拒绝（不再无限写 statusMessage text 列）", async () => {
      const dto = plainToInstance(DeploymentHeartbeatDto, {
        deploymentId: "0e8d3f0e-1111-4222-8333-444455556666",
        status: "running",
        message: "x".repeat(2001),
      });
      const errors = await validate(dto);
      const msg = errors.find((e) => e.property === "message");
      expect(msg).toBeDefined();
      expect(Object.values(msg!.constraints ?? {}).join(" ")).toContain("2000");
    });

    it("2000 字符边界 → 通过", async () => {
      const dto = plainToInstance(DeploymentHeartbeatDto, {
        deploymentId: "0e8d3f0e-1111-4222-8333-444455556666",
        status: "running",
        message: "x".repeat(2000),
      });
      expect(
        (await validate(dto)).find((e) => e.property === "message"),
      ).toBeUndefined();
    });
  });
});
