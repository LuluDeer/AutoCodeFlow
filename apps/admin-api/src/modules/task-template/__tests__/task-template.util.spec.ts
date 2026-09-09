/**
 * CORE-03：模板 config 校验与展开的纯逻辑。
 * - assertValidTaskTemplateConfig：CreateTaskDto 子集语义（枚举/cron/范围/白名单外键）。
 * - assertValidCreateTaskPayload：完整载荷（name 必填）校验。
 * - expandTemplateConfigIntoTaskDto：模板作默认 + 显式覆盖 + name 语义。
 */
import { BadRequestException } from "@nestjs/common";
import {
  assertValidCreateTaskPayload,
  assertValidTaskTemplateConfig,
  expandTemplateConfigIntoTaskDto,
  suggestTemplateKey,
} from "../task-template.util";

describe("assertValidTaskTemplateConfig (CORE-03)", () => {
  it("接受官方模板级别的合法 config", async () => {
    await expect(
      assertValidTaskTemplateConfig({
        triggerType: "cron",
        cronExpression: "0 2 * * *",
        runtime: "shell",
        entrypoint: "backup.sh",
        timeoutSeconds: 3600,
        maxRetry: 3,
        retryDelay: 60,
        blockStrategy: "discard",
      }),
    ).resolves.toBeDefined();
  });

  it("拒绝白名单外的多余字段（forbidNonWhitelisted）", async () => {
    await expect(
      assertValidTaskTemplateConfig({
        triggerType: "manual",
        __evil__: true,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("拒绝非法枚举值（triggerType/runtime）", async () => {
    await expect(
      assertValidTaskTemplateConfig({ triggerType: "not_a_trigger" }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      assertValidTaskTemplateConfig({
        triggerType: "manual",
        runtime: "cobol",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("拒绝非法 cron 与越界数值", async () => {
    await expect(
      assertValidTaskTemplateConfig({
        triggerType: "cron",
        cronExpression: "not a cron",
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      assertValidTaskTemplateConfig({
        triggerType: "manual",
        maxRetry: 999,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("非对象 config（null / 数组）直接拒绝", async () => {
    await expect(assertValidTaskTemplateConfig(null)).rejects.toThrow(
      BadRequestException,
    );
    await expect(assertValidTaskTemplateConfig([1, 2])).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("assertValidCreateTaskPayload (CORE-03)", () => {
  it("要求 name 必填（从模板实例化时由 body 提供）", async () => {
    await expect(
      assertValidCreateTaskPayload({ triggerType: "manual" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("合法完整载荷返回可提交 DTO 实例", async () => {
    const dto = await assertValidCreateTaskPayload({
      name: "daily-job",
      triggerType: "cron",
      cronExpression: "30 3 * * *",
      runtime: "shell",
      entrypoint: "cleanup.sh",
      timeoutSeconds: 600,
      maxRetry: 1,
    });
    expect(dto.name).toBe("daily-job");
    expect(dto.triggerType).toBe("cron");
  });
});

describe("expandTemplateConfigIntoTaskDto (CORE-03)", () => {
  it("模板 config 作默认值", () => {
    const merged = expandTemplateConfigIntoTaskDto(
      { triggerType: "cron", cronExpression: "0 2 * * *", runtime: "shell" },
      { name: "backup-1" },
    );
    expect(merged).toMatchObject({
      name: "backup-1",
      triggerType: "cron",
      cronExpression: "0 2 * * *",
    });
  });

  it("显式字段覆盖模板值", () => {
    const merged = expandTemplateConfigIntoTaskDto(
      {
        triggerType: "cron",
        cronExpression: "0 2 * * *",
        timeoutSeconds: 3600,
      },
      { name: "x", cronExpression: "*/15 * * * *", timeoutSeconds: 60 },
    );
    expect(merged.cronExpression).toBe("*/15 * * * *");
    expect(merged.timeoutSeconds).toBe(60);
  });

  it("config 内混入 name 被剥离，仅取 overrides.name", () => {
    const merged = expandTemplateConfigIntoTaskDto(
      { name: "leaked-from-template", triggerType: "manual" },
      { name: "user-name" },
    );
    expect(merged.name).toBe("user-name");
  });

  it("无 overrides.name 时结果不含 name 键", () => {
    const merged = expandTemplateConfigIntoTaskDto(
      { triggerType: "manual" },
      {},
    );
    expect("name" in merged).toBe(false);
  });
});

describe("suggestTemplateKey (CORE-03)", () => {
  it("规整中文/特殊字符名并限长", () => {
    expect(suggestTemplateKey("Daily  Order Sync!")).toBe("daily-order-sync");
    expect(suggestTemplateKey("  spaced  ")).toBe("spaced");
    expect(suggestTemplateKey("".padEnd(100, "a")).length).toBeLessThanOrEqual(
      64,
    );
  });

  it("空名回退时间戳 key", () => {
    expect(suggestTemplateKey("")).toMatch(/^tpl-/);
  });
});
