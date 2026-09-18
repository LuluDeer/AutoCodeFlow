import { ArgumentsHost, BadRequestException, HttpStatus } from "@nestjs/common";
import { HttpExceptionFilter } from "../http-exception.filter";

/**
 * 体验审查（本轮）：**字段级校验原因必须能到达用户眼前**。
 *
 * 背景：main.ts 开了 `whitelist + forbidNonWhitelisted`，任何多余/非法字段都
 * 400，而 admin-web 的两个消费点——`utils/error.ts` 的 getErrMsg 与
 * `api/client.ts` 的 axios 拦截器——**都只读响应体的 `message`**，从不读
 * `data`。原实现把 Nest ValidationPipe 的字段数组降级进 `data`，同时把
 * `message` 写成一句固定的 "Validation failed"：
 *
 *     if (Array.isArray(resp["message"])) {
 *       errors = resp["message"] as string[];
 *       message = "Validation failed";     // ← 字段名与原因在这里丢失
 *     }
 *
 * 于是用户在任务表单/配置编辑里填错一个字段，屏幕上只有裸英文
 * "Validation failed"——没有字段名、没有原因、无从下手。
 *
 * 这些用例把「原因必须出现在 message 里」钉死；`data` 仍保留原始数组以兼容
 * 既有按数组消费的调用方（两者是并存关系，不是替换）。
 */
describe("HttpExceptionFilter — 校验错误可达性（体验审查）", () => {
  /** 造一个最小的 ArgumentsHost，捕获 filter 写出的响应体。 */
  function makeHost() {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: "/api/tasks" }),
      }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  /** 取出 filter 实际写出的响应体。 */
  function runFilter(exception: unknown) {
    const { host, status, json } = makeHost();
    new HttpExceptionFilter().catch(exception, host);
    expect(status).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledTimes(1);
    return {
      status: status.mock.calls[0][0] as number,
      body: json.mock.calls[0][0] as {
        code: number;
        message: string;
        data: unknown;
      },
    };
  }

  it("ValidationPipe 的字段数组必须拼进 message（否则前端只显示裸 'Validation failed'）", () => {
    // Nest 的 ValidationPipe 抛出的形状：message 是 string[]，每个元素是一条
    // 字段级原因（形如 "name must be a string"）。
    const exception = new BadRequestException({
      statusCode: 400,
      error: "Bad Request",
      message: [
        "property foo should not exist",
        "maxConcurrentTasks must not be less than 1",
      ],
    });

    const { status, body } = runFilter(exception);

    expect(status).toBe(HttpStatus.BAD_REQUEST);
    // 核心断言：字段级原因必须出现在 message 里。
    expect(body.message).toContain("property foo should not exist");
    expect(body.message).toContain(
      "maxConcurrentTasks must not be less than 1",
    );
    // 且不能退化成只有那句固定英文。
    expect(body.message).not.toBe("Validation failed");
    // data 仍保留原始数组（兼容既有按数组消费的调用方）。
    expect(body.data).toEqual([
      "property foo should not exist",
      "maxConcurrentTasks must not be less than 1",
    ]);
  });

  it("多条原因用 '; ' 分隔，保持单行可读（toast 是一行）", () => {
    const { body } = runFilter(
      new BadRequestException({
        message: ["a must be a string", "b must be a number"],
      }),
    );

    expect(body.message).toBe(
      "Validation failed: a must be a string; b must be a number",
    );
    // 不能把数组直接 JSON 化塞进 message（会渲染成 ["a",...] 的噪声）。
    expect(body.message).not.toContain('["');
  });

  it("空数组退化为原来的固定文案（不产生悬空的冒号）", () => {
    const { body } = runFilter(new BadRequestException({ message: [] }));

    expect(body.message).toBe("Validation failed");
  });

  it("字符串 message 不受影响（非校验类 400 走原路径）", () => {
    const { body } = runFilter(new BadRequestException("Executor is offline"));

    expect(body.message).toBe("Executor is offline");
    expect(body.data).toBeNull();
  });

  it("回归：改回 'Validation failed' 常量会让字段原因重新丢失（反证）", () => {
    // 这条用例的作用是让「修法被回退」这件事显式可见：它断言 message 里
    // **确实包含**具体字段名——若有人把实现改回常量，上面第一条会红，而
    // 这里额外钉住「包含字段名」这一语义，避免用 toContain("Validation")
    // 之类的弱断言凑绿。
    const { body } = runFilter(
      new BadRequestException({ message: ["email must be an email"] }),
    );

    expect(body.message).toContain("email must be an email");
    expect(body.message.startsWith("Validation failed")).toBe(true);
  });
});
