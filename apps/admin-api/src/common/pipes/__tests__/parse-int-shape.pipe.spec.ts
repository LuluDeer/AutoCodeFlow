import { BadRequestException } from "@nestjs/common";
import type { ArgumentMetadata } from "@nestjs/common";
import { ParseIntShapePipe } from "../parse-int-shape.pipe";

/**
 * F-52（UIAUDIT 后端轮 P2-1）：整数主键路由的 ID 形态契约。
 *
 * 与 parse-uuid-shape.pipe.spec 同构，把两侧都钉住：
 *  ① 合法整数串通过并转 number；
 *  ② 非法形态 400，且封套统一为 INVALID_VALUE_FORMAT（此前原生 ParseIntPipe
 *     抛 "Validation failed (numeric string is expected)" 经 filter 时
 *     errorCode:null + 裸英文，与 UUID 侧三方漂移）。
 */
const META: ArgumentMetadata = { type: "param", metatype: String, data: "id" };

const pipe = () => new ParseIntShapePipe();

describe("ParseIntShapePipe（路由参数整数形态校验）", () => {
  it.each([
    ["普通整数", "42", 42],
    ["0", "0", 0],
    ["负整数", "-7", -7],
    ["前导零", "007", 7],
  ])("%s 通过并转 number", async (_label, value, expected) => {
    await expect(pipe().transform(value, META)).resolves.toBe(expected);
  });

  it.each([
    ["空串", ""],
    ["非数字串", "abc"],
    ["数字带尾巴（parseInt 宽松语义的缺口）", "12abc"],
    ["小数", "12.5"],
    ["带空白", " 12"],
    ["科学计数法", "1e3"],
    ["十六进制前缀", "0x10"],
    ["SQL 注入串", "1 OR 1=1"],
    ["加号前缀", "+12"],
  ])("%s 仍然 400（形态校验委托 ParseIntPipe 的严格正则）", async (_label, value) => {
    await expect(pipe().transform(value, META)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("拒绝封套：INVALID_VALUE_FORMAT（F-52 全站统一码，中文目录文案）", async () => {
    const err = await pipe().transform("abc", META).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as { errorCode?: string }).errorCode).toBe(
      "INVALID_VALUE_FORMAT",
    );
    expect((err as { message?: string }).message).toContain("格式非法");
  });
});
