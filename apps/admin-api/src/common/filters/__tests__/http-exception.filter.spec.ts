import { ArgumentsHost, BadRequestException, HttpStatus } from "@nestjs/common";
import { QueryFailedError } from "typeorm";
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
        // LANG-ERR-01：业务码与插值参数是**新增**字段（`code` 仍是数字 HTTP
        // 状态码，消费方契约不变）。
        errorCode: string | null;
        params: Record<string, unknown> | null;
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
    // 且不能退化成只有那句固定兜底文案（LANG-ERR-01 起该兜底为中文）。
    expect(body.message).not.toBe("参数校验失败");
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

    // LANG-ERR-01：前缀改为中文兜底（英文界面下由前端按 errorCode 渲染
    // "Validation failed: …"，服务端这一份只服务不翻译的消费者）。
    expect(body.message).toBe(
      "参数校验失败：a must be a string; b must be a number",
    );
    // 不能把数组直接 JSON 化塞进 message（会渲染成 ["a",...] 的噪声）。
    expect(body.message).not.toContain('["');
  });

  it("空数组退化为无明细文案（不产生悬空的冒号）", () => {
    const { body } = runFilter(new BadRequestException({ message: [] }));

    expect(body.message).toBe("参数校验失败");
    // LANG-ERR-01：空明细走单列的错误码，前端据此取「无冒号」的本地化文案。
    expect(body.errorCode).toBe("VALIDATION_FAILED_NO_DETAIL");
  });

  it("字符串 message 不受影响（非校验类 400 走原路径）", () => {
    const { body } = runFilter(new BadRequestException("Executor is offline"));

    expect(body.message).toBe("Executor is offline");
    expect(body.data).toBeNull();
  });

  it("回归：改回固定常量会让字段原因重新丢失（反证）", () => {
    // 这条用例的作用是让「修法被回退」这件事显式可见：它断言 message 里
    // **确实包含**具体字段名——若有人把实现改回常量，上面第一条会红，而
    // 这里额外钉住「包含字段名」这一语义，避免用 toContain("校验")
    // 之类的弱断言凑绿。
    const { body } = runFilter(
      new BadRequestException({ message: ["email must be an email"] }),
    );

    expect(body.message).toContain("email must be an email");
    // LANG-ERR-01：前缀是中文兜底「参数校验失败：」——同样钉住"前缀存在"，
    // 否则实现回退成无前缀常量时这条会假绿。
    expect(body.message.startsWith("参数校验失败：")).toBe(true);
  });
});

// F-41（UIUX 审计 P1-2）：PG 22P02（值形态与列类型不匹配——主流场景是 UUID
// 主键列收到非 UUID 深链值）必须映射为 400 INVALID_VALUE_FORMAT，不得冒泡 500。
describe("HttpExceptionFilter — PG 22P02 兜底映射（F-41）", () => {
  function makeHost() {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: "/api/tasks/999999" }),
      }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  function pg22P02(value: string): QueryFailedError {
    return new QueryFailedError(
      'SELECT * FROM tasks WHERE id = $1',
      [value],
      Object.assign(
        new Error(`invalid input syntax for type uuid: "${value}"`),
        { code: "22P02" },
      ) as Error,
    );
  }

  it("22P02 → 400 INVALID_VALUE_FORMAT（请求方输入错误，非服务器故障）", () => {
    const { host, status, json } = makeHost();
    new HttpExceptionFilter().catch(pg22P02("999999"), host);

    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body["code"]).toBe(400);
    expect(body["errorCode"]).toBe("INVALID_VALUE_FORMAT");
    expect(body["message"]).toContain("格式非法");
  });

  it("非 22P02 的其它 DB 错误仍保持 500 兜底（不扩大映射面）", () => {
    const { host, status, json } = makeHost();
    const err = new QueryFailedError("SELECT 1", [], Object.assign(new Error("relation missing"), { code: "42P01" }) as Error);
    new HttpExceptionFilter().catch(err, host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body["errorCode"]).toBeNull();
  });
});
