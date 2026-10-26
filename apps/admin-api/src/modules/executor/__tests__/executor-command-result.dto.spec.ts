/**
 * P2-4（2026-10-26 第三轮审计）：POST /executors/command-result 的请求体
 * class DTO 必须真的参与全局 ValidationPipe。
 *
 * 此前端点是内联类型（metatype = Object，whitelist/forbidNonWhitelisted 对其
 * 不生效）：body.error 未限长进 acf:cmdres 并整体插值进 statusMessage text 列、
 * commandId 无形态校验（Redis 键写放大面）。换 class DTO 后按生产 pipe 配置
 * 逐项钉住：合法体通过、未知字段被拒、error 长度闸、commandId UUID 形态闸。
 * （本 spec 的回归模式照搬 sop-collab.dto.validation.spec——控制器单测直接调
 * 方法、绕过了 pipe，所以必须在这里按 pipe 配置验证。）
 */
import { ValidationPipe } from "@nestjs/common";
import { ExecutorCommandResultDto } from "../dto/executor-command-result.dto";

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const validateBody = (value: Record<string, unknown>) =>
  pipe.transform(value, {
    type: "body",
    metatype: ExecutorCommandResultDto,
  });

const UUID = "550e8400-e29b-41d4-a716-446655440000";

// executor-node 的实际上报体（ControlCommandResult + address + deviceFingerprint）
// ——白名单字段集合必须完整覆盖它，否则升级即断（forbidNonWhitelisted 400）。
const validBody = {
  commandId: UUID,
  address: "office-pc-07:8002",
  type: "deploy",
  ok: false,
  status: 500,
  error: "git clone failed: remote hung up",
  durationMs: 1234,
  deviceFingerprint: "f".repeat(64),
};

describe("ExecutorCommandResultDto validation (production pipe)", () => {
  it("合法体（executor-node 实际上报形态，全部字段）通过且白名单外键被剥除", async () => {
    const out = await validateBody({ ...validBody });
    expect(out).toMatchObject({
      commandId: UUID,
      address: "office-pc-07:8002",
      type: "deploy",
      ok: false,
      error: "git clone failed: remote hung up",
    });
  });

  it("未知字段被拒（forbidNonWhitelisted 生效——内联类型的旧缺口不复存在）", async () => {
    await expect(
      validateBody({ ...validBody, tokenHash: "backdoor" }),
    ).rejects.toBeTruthy();
  });

  it("P2-4：error 恰好 2000 合法通过（闸在 2001）", async () => {
    await expect(
      validateBody({ ...validBody, error: "y".repeat(2000) }),
    ).resolves.toBeTruthy();
    await expect(
      validateBody({ ...validBody, error: "y".repeat(1999) }),
    ).resolves.toBeTruthy();
  });

  it("P2-4：error 超 2000 → 400（对齐执行器侧自截 1000 的双倍余量）", async () => {
    await expect(
      validateBody({ ...validBody, error: "x".repeat(2001) }),
    ).rejects.toBeTruthy();
  });

  it("P2-4：畸形 commandId（非 UUID）→ 400（Redis 键写放大面收敛）", async () => {
    await expect(
      validateBody({ ...validBody, commandId: "not-a-uuid" }),
    ).rejects.toBeTruthy();
    await expect(
      validateBody({ ...validBody, commandId: `${"z".repeat(300)}` }),
    ).rejects.toBeTruthy();
  });

  it("P2-4：缺失必填字段（commandId/type/ok/address）→ 400", async () => {
    for (const key of ["commandId", "type", "ok", "address"]) {
      const body = { ...validBody } as Record<string, unknown>;
      delete body[key];
      await expect(validateBody(body)).rejects.toBeTruthy();
    }
  });

  it("P2-4：可选字段缺省（旧执行器只发 commandId/address/type/ok）通过", async () => {
    await expect(
      validateBody({
        commandId: UUID,
        address: "office-pc-07:8002",
        type: "kill-execution",
        ok: true,
      }),
    ).resolves.toBeTruthy();
  });
});
