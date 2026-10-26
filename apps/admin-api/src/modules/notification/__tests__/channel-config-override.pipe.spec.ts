import { ChannelConfigOverridePipe } from "../channel-config-override.pipe";

/**
 * F-53（UIAUDIT 后端轮 P2-2）：testChannel 覆盖体形状管道的单测。
 *
 * 该面是动态键的 Record<string,string>（键集随渠道类型变化），不能 class DTO
 * 化（见管道头注），校验职责全部在本管道——这里钉住接受面与拒绝面。
 *
 * LANG-ERR-01（2026-10-26）：错误形态由裸 `BadRequestException`（无 errorCode，
 * 前端只能渲染服务端中文兜底）改为 `AppError('NOTIFICATION_CONFIG_OVERRIDE_INVALID')`。
 * 下方断言随之改为钉**码 + reason 参数**——比原先只钉异常类更有牙：类不变而
 * 码退化成别的域，这里会红。
 */
const pipe = () => new ChannelConfigOverridePipe();

/**
 * 取出错误码与 params。
 *
 * **刻意不用 `instanceof AppError`**：AppError 构造器末尾会
 * `Object.setPrototypeOf(this, STATUS_TO_EXCEPTION[status].prototype)`
 * （见 app-error.ts，目的是让 178 处既有 `toThrow(BadRequestException)`
 * 断言继续生效），所以实例的 `instanceof AppError` 恒为 false。这里按
 * `errorCode` 字段判形态——那正是响应体真正透出的东西。
 */
function asAppError(fn: () => unknown): {
  code: string;
  params?: Record<string, unknown>;
} | null {
  try {
    fn();
  } catch (e) {
    const code = (e as { errorCode?: unknown }).errorCode;
    if (typeof code !== "string") return null;
    return { code, params: (e as { params?: Record<string, unknown> }).params };
  }
  return null;
}

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
    const err = asAppError(() => pipe().transform(value));
    expect(err?.code).toBe("NOTIFICATION_CONFIG_OVERRIDE_INVALID");
    expect(err?.params?.reason).toContain("must be an object");
  });

  it("非字符串值 → 400（拒绝而非静默转换）", () => {
    const err = asAppError(() =>
      pipe().transform({ url: "https://ok", port: 587 }),
    );
    expect(err?.code).toBe("NOTIFICATION_CONFIG_OVERRIDE_INVALID");
    expect(String(err?.params?.reason)).toContain("must be a string");
  });

  it("键数量 / 键长 / 值长护栏 → 400（reason 逐条区分约束）", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 33; i++) many[`k${i}`] = "v";
    expect(asAppError(() => pipe().transform(many))?.params?.reason).toContain(
      "at most 32 keys",
    );

    const longKey: Record<string, string> = {};
    longKey["k".repeat(65)] = "v";
    expect(
      asAppError(() => pipe().transform(longKey))?.params?.reason,
    ).toContain("key too long");

    expect(
      asAppError(() => pipe().transform({ url: "v".repeat(4097) }))?.params
        ?.reason,
    ).toContain("too long");
  });

  it("errorCode 是专用码而非通用 VALIDATION_FAILED（前端可给针对性文案）", () => {
    const err = asAppError(() => pipe().transform({ port: 587 }));
    expect(err?.code).toBe("NOTIFICATION_CONFIG_OVERRIDE_INVALID");
    expect(err?.code).not.toBe("VALIDATION_FAILED");
  });
});
