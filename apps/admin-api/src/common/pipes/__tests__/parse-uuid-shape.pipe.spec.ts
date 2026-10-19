import { BadRequestException } from "@nestjs/common";
import type { ArgumentMetadata } from "@nestjs/common";
import { ParseUuidShapePipe } from "../parse-uuid-shape.pipe";
import { DEFAULT_PROJECT_ID } from "../../../modules/project/project.entity";

/**
 * PROJECT-UUID-01（生产故障）：项目管理页点「成员」必现
 *
 *     Validation failed (uuid is expected)
 *
 * 根因是**路由参数**这条路径没有跟着 `is-uuid-shape.decorator.ts` 那一轮一起
 * 放宽——`ParseUUIDPipe` 只认 RFC 9562 的版本 1–8 + variant [89ab]（外加 nil /
 * max），而 `DEFAULT_PROJECT_ID` 的版本位是 `0`。`GET /projects` 无条件返回
 * 默认项目行，所以它是列表里**唯一**一个点进去必 400 的行。
 *
 * 本文件把两侧都钉住：
 *  ① 默认项目 id 必须通过（修复前此用例红）；
 *  ② 真正的非法串仍然 400（放宽不能变成放行面扩张）。
 */
const META: ArgumentMetadata = { type: "param", metatype: String, data: "id" };

const pipe = () => new ParseUuidShapePipe();

describe("ParseUuidShapePipe（路由参数 UUID 形状校验）", () => {
  it("默认项目 id 通过——这是生产故障的原始输入", async () => {
    expect(DEFAULT_PROJECT_ID).toBe("00000000-0000-0000-0000-000000000001");
    await expect(pipe().transform(DEFAULT_PROJECT_ID, META)).resolves.toBe(
      DEFAULT_PROJECT_ID,
    );
  });

  it("对照：NestJS 自带的 ParseUUIDPipe 会拒绝它（证明缺陷真实存在，不是臆测）", async () => {
    const { ParseUUIDPipe } = await import("@nestjs/common");
    await expect(
      new ParseUUIDPipe().transform(DEFAULT_PROJECT_ID, META),
    ).rejects.toThrow("Validation failed (uuid is expected)");
  });

  it.each([
    ["普通 v4", "aaaa0000-0000-4000-8000-000000000002"],
    ["nil uuid", "00000000-0000-0000-0000-000000000000"],
    ["max uuid", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ["variant 位非 89ab 的 v4", "aaaa0000-0000-4000-0000-000000000002"],
    ["v7", "aaaa0000-0000-7000-8000-000000000002"],
    ["大写形态", "AAAA0000-0000-4000-8000-000000000002"],
  ])("%s 通过", async (_label, value) => {
    await expect(pipe().transform(value, META)).resolves.toBe(value);
  });

  it.each([
    ["空串", ""],
    ["非 uuid 串", "abc"],
    ["urn:uuid: 前缀", `urn:uuid:${DEFAULT_PROJECT_ID}`],
    ["花括号包裹", `{${DEFAULT_PROJECT_ID}}`],
    ["SQL 注入串", "1' OR '1'='1"],
    ["路径穿越", "../../etc/passwd"],
    ["带空白的合法串", ` ${DEFAULT_PROJECT_ID}`],
    ["超长串", "a".repeat(200)],
    ["少一段", "00000000-0000-0000-0000-0000000000"],
    ["多一段", `${DEFAULT_PROJECT_ID}-01`],
    ["非十六进制字符", "zzzzzzzz-0000-0000-0000-000000000001"],
  ])("%s 仍然 400（放宽不得扩张语法面）", async (_label, value) => {
    await expect(pipe().transform(value, META)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("拒绝时的文案与 NestJS 逐字一致（前端/既有 spec 不感知实现变化）", async () => {
    await expect(pipe().transform("abc", META)).rejects.toThrow(
      "Validation failed (uuid is expected)",
    );
  });
});
