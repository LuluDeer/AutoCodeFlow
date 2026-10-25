import { BadRequestException } from "@nestjs/common";
import { ChannelConfigOverridePipe } from "../channel-config-override.pipe";

/**
 * F-53（UIAUDIT 后端轮 P2-2）：testChannel 覆盖体形状管道的单测。
 *
 * 该面是动态键的 Record<string,string>（键集随渠道类型变化），不能 class DTO
 * 化（见管道头注），校验职责全部在本管道——这里钉住接受面与拒绝面。
 */
const pipe = () => new ChannelConfigOverridePipe();

describe("ChannelConfigOverridePipe（testChannel 覆盖体形状）", () => {
  it("缺省/空 body → 空覆盖（端点向后兼容：不带 body 也能测默认配置）", () => {
    expect(pipe().transform(undefined)).toEqual({});
    expect(pipe().transform(null)).toEqual({});
    expect(pipe().transform({})).toEqual({});
  });

  it("合法 string→string 映射原样放行", () => {
    expect(
      pipe().transform({
        host: "smtp.example.com",
        port: "587",
        password: "***",
      }),
    ).toEqual({ host: "smtp.example.com", port: "587", password: "***" });
  });

  it.each([
    ["数组", ["url"]],
    ["字符串标量", "url"],
    ["数字标量", 42],
  ])("%s 形状 → 400", (_label, value) => {
    expect(() => pipe().transform(value)).toThrow(BadRequestException);
  });

  it("非字符串值 → 400（拒绝而非静默转换）", () => {
    expect(() => pipe().transform({ url: "https://ok", port: 587 })).toThrow(
      BadRequestException,
    );
  });

  it("键数量 / 键长 / 值长护栏 → 400", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 33; i++) many[`k${i}`] = "v";
    expect(() => pipe().transform(many)).toThrow(BadRequestException);
    const longKey: Record<string, string> = {};
    longKey["k".repeat(65)] = "v";
    expect(() => pipe().transform(longKey)).toThrow(BadRequestException);
    expect(() => pipe().transform({ url: "v".repeat(4097) })).toThrow(
      BadRequestException,
    );
  });

  it("错误形态是 message 数组的 BadRequestException（filter 落 VALIDATION_FAILED detail）", () => {
    let err: BadRequestException | undefined;
    try {
      pipe().transform({ port: 587 });
    } catch (e) {
      err = e as BadRequestException;
    }
    const resp = err?.getResponse() as { message?: string[] };
    expect(Array.isArray(resp?.message)).toBe(true);
  });
});
