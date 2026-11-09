import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { QueryFailedError } from "typeorm";
import { AppError } from "../../errors/app-error";
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
      "SELECT * FROM tasks WHERE id = $1",
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
    const err = new QueryFailedError(
      "SELECT 1",
      [],
      Object.assign(new Error("relation missing"), { code: "42P01" }) as Error,
    );
    new HttpExceptionFilter().catch(err, host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    // 映射面不扩大：仍是 500（不是 INVALID_VALUE_FORMAT 那种请求方 4xx 映射），
    // R171 起 5xx 一律带兜底码——语义仍是「服务端内部错误」，不是给这个 PG
    // 错误现编了一个业务原因。
    expect(body["errorCode"]).toBe("INTERNAL_ERROR");
  });
});

/**
 * F-52 自查（UIAUDIT 后端轮，2026-10-25）：管道类 400 的兜底赋码。
 *
 * NestJS 内建管道（ParseIntPipe / ParseUUIDPipe / …）拒绝时抛字符串形态的
 * BadRequestException（"Validation failed (…)"），经 filter 透传时
 * errorCode 只能是 null——前端 i18n 失效回落裸英文。形态管道（F-41/F-52）
 * 覆盖了 UUID/int 主键主路，剩余约 7 个模块的原生管道路由（config /
 * api-keys / executor-package / event-subscriptions / mutex-group /
 * app-deployment / projects:userId）由此兜底统一为 INVALID_VALUE_FORMAT。
 * 按消息形态识别："Validation failed (" 是内建管道 exceptionFactory 的固定
 * 前缀（框架契约）；业务代码手工抛的普通字符串 400 不受影响（不为它编造码）。
 */
describe("HttpExceptionFilter — 管道类 400 兜底赋码（F-52 自查）", () => {
  it("ParseIntPipe 形态的 400 → INVALID_VALUE_FORMAT（中文目录文案）", () => {
    const { status, json } = (() => {
      const jsonFn = jest.fn();
      const statusFn = jest.fn().mockReturnValue({ json: jsonFn });
      const host = {
        switchToHttp: () => ({
          getResponse: () => ({ status: statusFn }),
          getRequest: () => ({ url: "/api/config/abc" }),
        }),
      } as unknown as ArgumentsHost;
      new HttpExceptionFilter().catch(
        new BadRequestException(
          "Validation failed (numeric string is expected)",
        ),
        host,
      );
      return { status: statusFn, json: jsonFn };
    })();

    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body["code"]).toBe(400);
    expect(body["errorCode"]).toBe("INVALID_VALUE_FORMAT");
    expect(body["message"]).toContain("格式非法");
  });

  it("业务代码手工抛的普通字符串 400 维持 errorCode:null（不为它编造码）", () => {
    const jsonFn = jest.fn();
    const statusFn = jest.fn().mockReturnValue({ json: jsonFn });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn }),
        getRequest: () => ({ url: "/api/x" }),
      }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(
      new BadRequestException("clock skew too large"),
      host,
    );

    expect(statusFn).toHaveBeenCalledWith(400);
    const body = jsonFn.mock.calls[0][0] as Record<string, unknown>;
    expect(body["errorCode"]).toBeNull();
    expect(body["message"]).toBe("clock skew too large");
  });

  it("同款管道消息但非 400（422）不赋码（兜底只钉管道族所在的 400）", () => {
    const jsonFn = jest.fn();
    const statusFn = jest.fn().mockReturnValue({ json: jsonFn });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn }),
        getRequest: () => ({ url: "/api/x" }),
      }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(
      // 真实 HttpException 子类（内建管道同款 object response 形态），
      // 只是状态码换成 422——兜底的 status===400 门必须拦住它。
      new UnprocessableEntityException(
        "Validation failed (numeric string is expected)",
      ),
      host,
    );

    expect(statusFn).toHaveBeenCalledWith(422);
    const body = jsonFn.mock.calls[0][0] as Record<string, unknown>;
    expect(body["errorCode"]).toBeNull();
    expect(body["message"]).toBe(
      "Validation failed (numeric string is expected)",
    );
  });
});

describe("HttpExceptionFilter — 429 限流统一赋码（UIAUDIT4 P3-4）", () => {
  const run = (exception: unknown) => {
    const jsonFn = jest.fn();
    const statusFn = jest.fn().mockReturnValue({ json: jsonFn });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusFn }),
        getRequest: () => ({ url: "/api/auth/login" }),
      }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(exception, host);
    return { statusFn, jsonFn };
  };

  it("ThrottlerException 形态（字符串 body 的 429）→ RATE_LIMITED + 中文目录文案，不再透出英文异常类名", () => {
    // @nestjs/throttler 的 ThrottlerException 语义等价形态：429 + 字符串
    // response（不直接 import throttler，避免为一条映射引入包耦合）。
    const { statusFn, jsonFn } = run(
      new HttpException("ThrottlerException: Too Many Requests", 429),
    );
    expect(statusFn).toHaveBeenCalledWith(429);
    const body = jsonFn.mock.calls[0][0] as Record<string, unknown>;
    expect(body["errorCode"]).toBe("RATE_LIMITED");
    expect(body["message"]).toContain("操作过于频繁");
    expect(String(body["message"])).not.toContain("Throttler");
  });

  it("对象 body 的 429 同样赋码（任何 429 HttpException 同构处置）", () => {
    const { jsonFn } = run(
      new HttpException({ message: "Too Many Requests" }, 429),
    );
    const body = jsonFn.mock.calls[0][0] as Record<string, unknown>;
    expect(body["errorCode"]).toBe("RATE_LIMITED");
  });
});

/**
 * OBS3-04（P2 观测审计）：**5xx 出口日志必须带四个定位字段**。
 *
 * 缺陷原文：`AUTOFLOW_HTTP_5XX_RATE_HIGH` 的 description 让值班人第一步
 * 「按该 route 过滤 admin-api 结构化日志」，而旧实现只写
 * `Unhandled exception: <message>` + stack——没有 method、没有 path、没有
 * errorCode、没有 traceId，`context` 又恒为类名，runbook 第一步物理上做不到。
 *
 * 这里钉的是**格式契约**（运维侧 Loki 查询按它写），不是「日志里有几个词」：
 *   `Unhandled exception: <METHOD> <path> [<errorCode|NO_CODE>] trace=<traceId|->: <message>`
 *
 * 两个刻意为之的边界：
 *  · **path 去 query**——SSE 凭据走 `?ticket=…`，整条 url 进日志 = 泄漏一次性
 *    票据（本文件的 SSE 票据 path-binding 守卫防的是「票据被复用」，日志泄漏
 *    会把票据送到比请求侧宽得多的读取面）；
 *  · **归不到具体业务码就写兜底码 `INTERNAL_ERROR`**（R171 起；此前写
 *    `NO_CODE`），不编造具体原因——与响应体同一取值，故「有一批 5xx 还没归码」
 *    的 grep 度量从 `[NO_CODE]` 平移到 `[INTERNAL_ERROR]`，日志与响应体可对账。
 */
describe("HttpExceptionFilter — 5xx 出口日志四字段（OBS3-04）", () => {
  const TRACE_ID = "9f2c1b7a0d4e4c1a9d3f5e6a7b8c9d0e";

  /**
   * 跑一次 filter 并收走两路日志。
   *
   * 用 `Logger.prototype` 上挂 spy（与 outbox-dispatcher.spec / config.audit.spec
   * 同一写法）：filter 的 logger 是实例字段，挂在原型上才能在不改实现的前提下
   * 观测；`finally` 里必还原，避免污染同进程的其它用例。
   */
  function run(
    exception: unknown,
    req: Record<string, unknown>,
  ): { status: jest.Mock; json: jest.Mock; errors: string[]; warns: string[] } {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => req,
      }),
    } as unknown as ArgumentsHost;

    const errors: string[] = [];
    const warns: string[] = [];
    const errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation((message: unknown) => {
        errors.push(String(message));
      });
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation((message: unknown) => {
        warns.push(String(message));
      });
    try {
      new HttpExceptionFilter().catch(exception, host);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
    return { status, json, errors, warns };
  }

  it("未捕获 Error：method / 去 query 的 path / 兜底码 / traceId 四字段齐全", () => {
    const { errors } = run(new Error("boom"), {
      method: "POST",
      // 真实形态：SSE 票据走 query，绝不能进日志
      url: "/api/tasks?ticket=sse-ticket-abc123&page=2",
      traceId: TRACE_ID,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(
      `Unhandled exception: POST /api/tasks [INTERNAL_ERROR] trace=${TRACE_ID}: boom`,
    );
    // 逐字段再钉一遍（防止实现只拼了其中一两个也可能"包含"通过）
    expect(errors[0]).toContain("POST");
    expect(errors[0]).toContain("/api/tasks");
    expect(errors[0]).toContain("[INTERNAL_ERROR]");
    expect(errors[0]).toContain(`trace=${TRACE_ID}`);
    // 反证面：query（含一次性票据）与问号一律不得出现
    expect(errors[0]).not.toContain("ticket");
    expect(errors[0]).not.toContain("?");
    expect(errors[0]).not.toContain("page=2");
  });

  it("AppError 的 5xx：稳定码进日志（不退化成兜底码），状态码不变", () => {
    // 503 是真实存在的目录码（notification 告警 webhook 未配置）
    const { status, errors } = run(
      new AppError("NOTIFICATION_ALERT_WEBHOOK_NOT_CONFIGURED"),
      {
        method: "POST",
        url: "/api/notifications/alert-webhook",
        traceId: TRACE_ID,
      },
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "Unhandled exception: POST /api/notifications/alert-webhook [NOTIFICATION_ALERT_WEBHOOK_NOT_CONFIGURED]",
    );
    expect(errors[0]).toContain(`trace=${TRACE_ID}`);
  });

  it("未映射的 PG 错误（42P01 → 500）：同一行格式，PG 码不丢", () => {
    const err = new QueryFailedError(
      "SELECT 1",
      [],
      Object.assign(new Error("relation missing"), { code: "42P01" }) as Error,
    );
    const { errors } = run(err, {
      method: "GET",
      url: "/api/tasks?ticket=leak-me",
      traceId: TRACE_ID,
    });

    expect(errors).toHaveLength(1);
    // 仍是「一个 grep 前缀 + 四个字段」，PG 码作为 detail 前缀保留（排障第一现场）
    expect(errors[0]).toContain(
      "Unhandled exception: GET /api/tasks [INTERNAL_ERROR]",
    );
    expect(errors[0]).toContain("DB query failed [42P01]");
    expect(errors[0]).not.toContain("leak-me");
  });

  it("traceId 缺失时写 '-'（占位符保证整行格式仍可被一条正则匹配）", () => {
    const { errors } = run(new Error("boom"), {
      method: "GET",
      url: "/api/x",
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[INTERNAL_ERROR] trace=-:");
  });

  it("4xx 不进 error 级日志（调用方错误不是故障，不制造噪声）", () => {
    const { status, errors, warns } = run(new AppError("EXECUTOR_NOT_FOUND"), {
      method: "GET",
      url: "/api/executors/nope",
      traceId: TRACE_ID,
    });

    expect(status).toHaveBeenCalledWith(404);
    expect(errors).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it("22P02 的 400 仍是 warn，但同样带 method/path/trace（同一链路可对照）", () => {
    const err = new QueryFailedError(
      "SELECT * FROM tasks WHERE id = $1",
      ["999999"],
      Object.assign(new Error('invalid input syntax for type uuid: "999999"'), {
        code: "22P02",
      }) as Error,
    );
    const { status, errors, warns } = run(err, {
      method: "GET",
      url: "/api/tasks/999999?ticket=leak-me",
      traceId: TRACE_ID,
    });

    expect(status).toHaveBeenCalledWith(400);
    // 4xx 不写 error（不污染 5xx 的告警口径）
    expect(errors).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("DB query failed [22P02]");
    expect(warns[0]).toContain("GET /api/tasks/999999");
    expect(warns[0]).toContain(`trace=${TRACE_ID}`);
    expect(warns[0]).not.toContain("ticket");
  });

  it("回归：退回旧格式（只有 message）必须红", () => {
    // 这条刻意写成"旧格式不等"+"新格式正则"两半：只断言 not.toBe(旧串) 会被
    // 「随便加个前缀」蒙混过去，故再用整行正则钉住五段结构。
    const { errors } = run(new Error("boom"), {
      method: "PATCH",
      url: "/api/x?ticket=t",
      traceId: TRACE_ID,
    });

    expect(errors[0]).not.toBe("Unhandled exception: boom");
    expect(errors[0]).toMatch(
      /^Unhandled exception: [A-Z]+ \S+ \[[A-Z0-9_]+\] trace=\S+: boom$/,
    );
  });
});

/**
 * R171：**未捕获 5xx 的兜底 `errorCode`**。
 *
 * 缺陷（R169 只读审计）：filter 只给「本机制」认识的异常赋码，**未捕获的
 * 5xx**（非 `HttpException` 的 `Error`、非 `Error` 的抛出值、未映射的
 * `QueryFailedError`、直接抛出的 5xx `HttpException`）一律 `errorCode: null`。
 * 而 admin-web 的本地化链路是「**按 `errorCode` 查词条**」
 * （`apps/admin-web/src/utils/error.ts` 的 `translateByErrorCode`）：为 null
 * 时只能回落服务端 `message`，那是 filter 写死的中文兜底 ⇒ **英文界面必然
 * 显示中文**。MCP / CLI 侧同样只能读 `message` 文本，拿不到可编程的码。
 *
 * 这组用例钉的是：
 *   ① 兜底码**存在**且**稳定**（`INTERNAL_ERROR`，目录里已有的那个码，
 *      不新造同义码）；
 *   ② HTTP 状态**不变**（仍 500 / 503…，协议面纯增量）；
 *   ③ 4xx 无码的既有语义**一个都没动**（下面最后一例与 F-52 组共同守着）；
 *   ④ 兜底分支**不泄漏内部细节**（`boom` / 驱动报错只进服务端日志）。
 */
describe("HttpExceptionFilter — 未捕获 5xx 的兜底 errorCode（R171）", () => {
  function run(exception: unknown, url = "/api/tasks") {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url, method: "GET" }),
      }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(exception, host);
    return {
      status: status.mock.calls[0][0] as number,
      body: json.mock.calls[0][0] as Record<string, unknown>,
    };
  }

  it("未捕获的普通 Error → 500 + errorCode=INTERNAL_ERROR（此前是 null）", () => {
    const { status, body } = run(new Error("boom"));

    // ① 状态码仍是 500（协议面纯增量，老调用方读 code/message 行为不变）
    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body["code"]).toBe(500);
    // ② 兜底码存在且稳定
    expect(body["errorCode"]).toBe("INTERNAL_ERROR");
    // ③ message 仍是中文兜底（不翻译的消费者：CLI / MCP / 日志 / 落库）
    expect(body["message"]).toBe("服务器内部错误");
    // ④ 兜底分支不把异常原文/栈塞进 message 或任何字段
    expect(typeof body["message"]).toBe("string");
    expect(JSON.stringify(body)).not.toContain("boom");
  });

  it("非 Error 的抛出值（字符串/undefined/普通对象）同样落兜底码，而不是 null", () => {
    for (const thrown of ["boom", undefined, { why: "boom" }]) {
      const { status, body } = run(thrown);
      expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body["errorCode"]).toBe("INTERNAL_ERROR");
      expect(body["message"]).toBe("服务器内部错误");
    }
  });

  it("未映射的 QueryFailedError（42P01）→ 500 + 兜底码，客户端仍看不到 PG 原文", () => {
    const err = new QueryFailedError(
      "SELECT 1",
      [],
      Object.assign(new Error("relation missing"), { code: "42P01" }) as Error,
    );

    const { status, body } = run(err);

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body["errorCode"]).toBe("INTERNAL_ERROR");
    // PG 码与报文只进服务端日志（这里是 5xx 出口日志的 detail 前缀）
    expect(JSON.stringify(body)).not.toContain("42P01");
    expect(JSON.stringify(body)).not.toContain("relation missing");
  });

  it("直接抛出的 5xx HttpException 也归兜底码（不是 429/管道 400 的那几条分支）", () => {
    const { status, body } = run(
      new HttpException("downstream is down", HttpStatus.BAD_GATEWAY),
    );

    expect(status).toBe(HttpStatus.BAD_GATEWAY);
    expect(body["errorCode"]).toBe("INTERNAL_ERROR");
    // message 沿用异常自带文案（既有语义不动）——前端按新的 errorCode 本地化
    expect(body["message"]).toBe("downstream is down");
  });

  it("已有业务码的 5xx 分支不被兜底覆盖（errorCode 非 null 直接跳过）", () => {
    const { status, body } = run(
      new AppError("NOTIFICATION_ALERT_WEBHOOK_NOT_CONFIGURED"),
    );

    expect(status).toBe(503);
    expect(body["errorCode"]).toBe("NOTIFICATION_ALERT_WEBHOOK_NOT_CONFIGURED");
  });

  it("4xx 无码语义保持不变：手工抛的字符串 400 仍是 errorCode:null", () => {
    const { status, body } = run(
      new BadRequestException("clock skew too large"),
    );

    expect(status).toBe(HttpStatus.BAD_REQUEST);
    expect(body["errorCode"]).toBeNull();
    expect(body["message"]).toBe("clock skew too large");
  });
});
