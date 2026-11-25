import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { RollbackTaskDto } from "../dto/rollback-task.dto";
import { TASK_PARAMS_MAX_BYTES } from "../params-size.util";

/**
 * 回归：POST /api/tasks/:id/rollback 的 params 曾有且仅有 @IsOptional，
 * 字符串/数组/超大对象可穿过全局 ValidationPipe（whitelist+forbid）原样
 * 落到 TaskExecution.params(jsonb) 并入队执行——同一份 params 在 create /
 * trigger / webhook 面却有体积门与键名闸。本用例把 @IsObject + 64KB 体积门
 * + 键名折叠冲突闸钉死在 rollback DTO 边界（非法 → 400）。
 */
describe("RollbackTaskDto.params validation", () => {
  // 与 main.ts 全局 ValidationPipe 同配置
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const GIT_COMMIT = "abcd1234";

  const validateRollback = (value: object) =>
    pipe.transform(value, {
      type: "body",
      metatype: RollbackTaskDto,
    }) as Promise<RollbackTaskDto>;

  // 与 params-size.constraint.spec.ts 同构：每条目 ~1KB JSON 文本
  const bigObject = (bytes: number): Record<string, string> => {
    const entry = "x".repeat(1024);
    const count = Math.ceil(bytes / 1100);
    const out: Record<string, string> = {};
    for (let i = 0; i < count; i++) out[`k${i}`] = entry;
    return out;
  };

  const rejectionJson = async (value: object): Promise<string> => {
    const err = (await validateRollback(value).catch((e: unknown) => e)) as {
      getResponse?: () => unknown;
    };
    expect(err).toBeInstanceOf(BadRequestException);
    return JSON.stringify(err.getResponse ? err.getResponse() : err);
  };

  it("params=string → 400（类型混淆不得入队）", async () => {
    const body = await rejectionJson({
      gitCommit: GIT_COMMIT,
      params: "x".repeat(16),
    });
    expect(body).toContain("params");
  });

  it("params=array → 400（类型混淆不得入队）", async () => {
    const body = await rejectionJson({
      gitCommit: GIT_COMMIT,
      params: [1, 2, 3],
    });
    expect(body).toContain("params");
  });

  it("params 对象 >64KB → 400（无界载荷不得入库）", async () => {
    const body = await rejectionJson({
      gitCommit: GIT_COMMIT,
      params: bigObject(TASK_PARAMS_MAX_BYTES + 4096),
    });
    expect(body).toContain(String(TASK_PARAMS_MAX_BYTES));
  });

  it("params 键名大小写折叠冲突 → 400（与执行器同判据）", async () => {
    const body = await rejectionJson({
      gitCommit: GIT_COMMIT,
      params: { limit: 1, LIMIT: 2 },
    });
    expect(body).toContain("AUTOFLOW_LIMIT");
  });

  it("合法 params 对象放行", async () => {
    const dto = await validateRollback({
      gitCommit: GIT_COMMIT,
      params: { orderId: "A-1" },
    });
    expect(dto.params).toEqual({ orderId: "A-1" });
  });

  it("缺 params 放行（@IsOptional）", async () => {
    const dto = await validateRollback({ gitCommit: GIT_COMMIT });
    expect(dto.params).toBeUndefined();
  });
});
