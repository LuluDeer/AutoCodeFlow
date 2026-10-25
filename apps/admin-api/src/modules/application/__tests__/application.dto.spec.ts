import { ValidationPipe, BadRequestException } from "@nestjs/common";
import {
  CreateApplicationDto,
  UpdateApplicationDto,
} from "../dto/application.dto";

/**
 * P3-2（2026-10-25 审计）：CreateApplicationDto 长度/体积闸。
 *
 * 此前除 name/description 外全裸（version/runtime/gitRepo/gitCommit/
 * entrypoint/packageUrl 无 MaxLength，manifest/env 无体积闸）——异常调用方可
 * 借 POST/PATCH /applications 塞任意大字符串与 jsonb 进列表读面与版本快照。
 * 本组用例与 main.ts 全局管道同配置，钉住闸位与口径：
 *   · version/runtime 对齐 UploadApplicationDto（50）；
 *   · entrypoint 对齐 CreateDeploymentDto.startCommand（2000）；
 *   · manifest 序列化 ≤64KB、env 与部署面 A-11 同口径（50 键/单值 4KB）。
 * PartialType 继承使 PATCH /applications/:id 走同一组闸，一并回归。
 */
describe("CreateApplicationDto / UpdateApplicationDto 长度与体积闸（P3-2）", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  const validateCreate = (value: object) =>
    pipe.transform(value, {
      type: "body",
      metatype: CreateApplicationDto,
    }) as Promise<CreateApplicationDto>;

  const validateUpdate = (value: object) =>
    pipe.transform(value, {
      type: "body",
      metatype: UpdateApplicationDto,
    }) as Promise<UpdateApplicationDto>;

  const base = { name: "my-app", version: "1.0.0", runtime: "node" };

  it("合法最小载荷通过", async () => {
    await expect(validateCreate(base)).resolves.toBeTruthy();
  });

  it.each([
    ["version", 51],
    ["runtime", 51],
    ["gitRepo", 2049],
    ["gitBranch", 256],
    ["gitCommit", 129],
    ["entrypoint", 2001],
    ["packageUrl", 2049],
  ])("%s 超长（%d 字符）→ 400", async (field, len) => {
    await expect(
      validateCreate({ ...base, [field]: "x".repeat(len) }),
    ).rejects.toThrow(BadRequestException);
  });

  it("manifest 超过 64KB → 400；未超通过", async () => {
    const big = { blob: "x".repeat(66_000) };
    await expect(validateCreate({ ...base, manifest: big })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      validateCreate({
        ...base,
        manifest: { healthCheck: { path: "/health" } },
      }),
    ).resolves.toBeTruthy();
  });

  it("env 超过 50 键 → 400（A-11 同口径）；单值超 4KB → 400", async () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`K${i}`, "v"]),
    );
    await expect(validateCreate({ ...base, env: tooManyKeys })).rejects.toThrow(
      BadRequestException,
    );

    const bigValue = { BIG: "x".repeat(4097) };
    await expect(validateCreate({ ...base, env: bigValue })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("PATCH 经 PartialType 继承同一组闸（长 version → 400）", async () => {
    await expect(validateUpdate({ version: "x".repeat(51) })).rejects.toThrow(
      BadRequestException,
    );
  });
});
