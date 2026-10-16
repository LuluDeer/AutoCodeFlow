/**
 * LANG-ERR-01：**迁移后的端到端契约**——一条被迁移的 throw 必须同时满足
 * 「HTTP 状态不变」「响应体带码与参数」「服务端 message 是中文兜底且已插值」。
 *
 * 为什么这条必须由集成级用例守：单元层面 `AppError` 的形状有
 * `app-error-prototype.spec.ts` 钉着，但**迁移是否改坏了状态码**只有让异常真的
 * 走一遍全局 filter 才看得出来——迁移里最容易犯的错就是顺手把 404 写成 400
 * （原来由 `NotFoundException` 保证，改成码之后这个保证来自码表 `status`）。
 */
import { HttpException } from "@nestjs/common";
import { AppError } from "../app-error";
import { ErrorCode } from "../error-codes";

describe("LANG-ERR-01 · 迁移后的状态码契约", () => {
  /**
   * 抽样覆盖各状态码的**真实业务码**（不是临时造的），确保码表 `status`
   * 与迁移前异常类一致。这些是迁移 agent 实际落地的码。
   */
  const samples: Array<[string, number]> = [
    [ErrorCode.EXECUTOR_NOT_FOUND, 404],
    [ErrorCode.TASK_NAME_EXISTS, 409],
    [ErrorCode.ACCOUNT_DISABLED, 403],
    [ErrorCode.INVALID_CREDENTIALS, 401],
    [ErrorCode.SSRF_URL_INVALID, 400],
  ];

  it.each(samples)("%s 的状态码是 %i", (code, status) => {
    const err = new AppError(code as never);
    expect(err.getStatus()).toBe(status);
    expect(err).toBeInstanceOf(HttpException);
  });

  it("响应体自带 errorCode + params（前端据此翻译，不依赖 message）", () => {
    const err = new AppError(ErrorCode.TASK_NAME_EXISTS, { name: "日报" });
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.errorCode).toBe("TASK_NAME_EXISTS");
    expect(body.params).toEqual({ name: "日报" });
    // message 是给不翻译的消费者（CLI/日志/落库）的中文兜底，必须已插值
    expect(body.message).toBe("任务名「日报」已存在");
  });
});
