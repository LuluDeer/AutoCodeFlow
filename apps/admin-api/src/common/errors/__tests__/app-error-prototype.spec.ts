import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { AppError } from "../app-error";
import { ERROR_CATALOG, ErrorCode } from "../error-codes";

/**
 * LANG-ERR-01：`AppError` 的**原型兼容性**契约。
 *
 * 这一组用例守的是"全量迁移不会打断既有按异常类断言的 spec"这条性质。
 * 本仓有 178 处 `.rejects.toThrow(UnauthorizedException)` 这类写法；若
 * `AppError` 不挂到对应内置类上，把一处 `throw new UnauthorizedException(...)`
 * 换成 `throw new AppError("INVALID_CREDENTIALS")` 就会让**行为没变而测试变红**，
 * 迁移者只能去改那 178 处断言——改动语义被稀释，且"翻译"看起来像在破坏契约。
 */
describe("LANG-ERR-01 · AppError 原型兼容性", () => {
  it("401 码在 instanceof UnauthorizedException 下为真（保住按类断言）", () => {
    const err = new AppError("INVALID_CREDENTIALS");
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(401);
  });

  it.each([
    ["ACCOUNT_DISABLED", ForbiddenException, 403],
    ["EXECUTOR_NOT_FOUND", NotFoundException, 404],
    ["TASK_NAME_EXISTS", ConflictException, 409],
  ] as const)("%s → %s（status %i）", (code, ctor, status) => {
    const err = new AppError(code);
    expect(err).toBeInstanceOf(ctor);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(status);
  });

  it("422 走 UnprocessableEntityException（与 filter 的 RELATED_RESOURCE_NOT_FOUND 一致）", () => {
    const err = new AppError("RELATED_RESOURCE_NOT_FOUND");
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getStatus()).toBe(422);
  });

  it("400 走 BadRequestException", () => {
    const err = new AppError("VALIDATION_FAILED", { detail: "x" });
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
  });

  it("载荷三件套原样可读（errorCode / message / params）", () => {
    const err = new AppError("TASK_NAME_EXISTS", { name: "每日报表" });
    expect(err.errorCode).toBe("TASK_NAME_EXISTS");
    expect(err.params).toEqual({ name: "每日报表" });
    // message 是中文兜底，且已插值——服务端自足（裸 API / CLI / 日志用）
    expect(err.message).toBe("任务名「每日报表」已存在");
    expect(err.getResponse()).toEqual({
      errorCode: "TASK_NAME_EXISTS",
      message: "任务名「每日报表」已存在",
      params: { name: "每日报表" },
    });
  });

  it("无参数时 params 为 null（与「传了空对象」区分开）", () => {
    expect(new AppError("EXECUTOR_NOT_FOUND").params).toBeNull();
    expect(new AppError("EXECUTOR_NOT_FOUND").getResponse()).toMatchObject({
      params: null,
    });
  });

  it("缺参时保留占位原文，而不是渲染出 undefined（运维能看出漏传参）", () => {
    const err = new AppError("TASK_NAME_EXISTS");
    expect(err.message).toContain("{{name}}");
    expect(err.message).not.toContain("undefined");
  });
});

/**
 * `ErrorCode` 的**值形态**契约。
 *
 * 这一组守的是一个真实踩过的坑：`ErrorCode` 是「类型 + 常量」同名并存
 * （声明合并）。首版只导出类型，`ErrorCode.X` 直接是编译错误；第二版写成
 * `export const ErrorCode = ERROR_CATALOG`，于是 `ErrorCode.X` 求值成
 * `{status, zh, en}` **定义对象**而不是码名字符串——**每一处**
 * `new AppError(ErrorCode.X)` 都报 TS2345（实测 228 处编译错误），比不导出
 * 还糟：它看起来"能用"。
 *
 * 正确形态是「码名 → 码名」映射，故这里把两条性质都钉死：
 *   ① 取值等于**键名本身**（不是定义对象）；
 *   ② 键集合与 `ERROR_CATALOG` **逐字一致**（新增码自动出现在这里，不存在
 *      手写第二份清单导致的漂移）。
 */
describe("LANG-ERR-01 · ErrorCode 值形态契约", () => {
  it("ErrorCode.X 是码名字符串，不是 {status,zh,en} 定义对象", () => {
    for (const code of Object.keys(ERROR_CATALOG)) {
      const v = (ErrorCode as Record<string, unknown>)[code];
      expect(typeof v).toBe("string");
      expect(v).toBe(code);
    }
  });

  it("键集合与 ERROR_CATALOG 逐字一致（不手写第二份清单）", () => {
    expect(Object.keys(ErrorCode).sort()).toEqual(
      Object.keys(ERROR_CATALOG).sort(),
    );
  });

  it("可直接作为 AppError 首参（迁移中的标准写法）", () => {
    // 这条是"编译期 + 运行期"双重断言：写错形态时 tsc 先红。
    const err = new AppError(ErrorCode.EXECUTOR_NOT_FOUND);
    expect(err.errorCode).toBe("EXECUTOR_NOT_FOUND");
    expect(err.getStatus()).toBe(404);
  });
});
