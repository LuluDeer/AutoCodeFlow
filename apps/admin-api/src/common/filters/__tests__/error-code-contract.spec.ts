import { ArgumentsHost, BadRequestException, HttpStatus } from "@nestjs/common";
import { AppError } from "../../errors/app-error";
import { renderZh } from "../../errors/error-codes";
import { HttpExceptionFilter } from "../http-exception.filter";

/**
 * LANG-ERR-01：错误响应体的**线上契约**与「后端抛码」机制。
 *
 * 这组断言钉的是三件容易被后续改动静默破坏的事：
 *
 *   ① **`code` 是数字 HTTP 状态码、`errorCode` 才是业务码**。两者被混用/合并
 *      会打断 `mcp-server` / `acf-cli`（`check-consumer-routes.mjs` 守约）——
 *      而且是**静默**打断：HTTP 层看状态码仍对，只有精确判断业务原因的调用方
 *      会开始走错分支。
 *   ② `message` 必须是**自足的中文兜底**（裸 API / CLI / 日志 / 落库字段都读它），
 *      不能因为"前端会翻译"就留空或塞裸码。
 *   ③ **非本机制抛出的异常不得被编造错误码**——编造会让前端拿错误的词条去渲染，
 *      比回落服务端文案更糟（用户读到一句"读得通但与事实无关"的话）。
 */
function makeHost(): {
  host: ArgumentsHost;
  body: () => Record<string, unknown>;
} {
  let captured: Record<string, unknown> = {};
  const res = {
    status: () => res,
    json: (b: Record<string, unknown>) => {
      captured = b;
      return res;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ url: "/api/x" }),
    }),
  } as unknown as ArgumentsHost;
  return { host, body: () => captured };
}

describe("LANG-ERR-01 错误码响应契约", () => {
  const filter = new HttpExceptionFilter();

  it("AppError → code 仍是数字 HTTP 状态，errorCode 是业务码", () => {
    const { host, body } = makeHost();
    filter.catch(new AppError("EXECUTOR_NOT_FOUND"), host);
    const b = body();
    // ① 数字 HTTP 状态码（消费方契约）
    expect(b.code).toBe(HttpStatus.NOT_FOUND);
    expect(typeof b.code).toBe("number");
    // ② 业务码走新增字段
    expect(b.errorCode).toBe("EXECUTOR_NOT_FOUND");
    // ③ 中文兜底自足
    expect(b.message).toBe("执行器不存在");
    expect(b.params).toBeNull();
  });

  it("参数化码：message 用 params 插值，params 原样透出给前端翻译", () => {
    const { host, body } = makeHost();
    filter.catch(new AppError("TASK_NAME_EXISTS", { name: "每日报表" }), host);
    const b = body();
    expect(b.code).toBe(HttpStatus.CONFLICT);
    expect(b.errorCode).toBe("TASK_NAME_EXISTS");
    expect(b.message).toBe("任务名「每日报表」已存在");
    // 前端要用同一份 params 在**自己的**语言里插值，故必须原样透出
    expect(b.params).toEqual({ name: "每日报表" });
  });

  it("缺参数时保留占位而不是渲染成 undefined/空串（漏参会显形，不被当成正常文案）", () => {
    expect(renderZh("TASK_NAME_EXISTS")).toBe("任务名「{{name}}」已存在");
    expect(renderZh("TASK_NAME_EXISTS", {})).toBe("任务名「{{name}}」已存在");
    // 值为 null/undefined 同样保留占位
    expect(renderZh("TASK_NAME_EXISTS", { name: null })).toBe(
      "任务名「{{name}}」已存在",
    );
  });

  it("参数值含 $& 等替换模式特殊串时不污染文案（函数式 replace）", () => {
    expect(renderZh("TASK_NAME_EXISTS", { name: "$&$'" })).toBe(
      "任务名「$&$'」已存在",
    );
  });

  it("非本机制异常 → errorCode 为 null（不编造码）", () => {
    const { host, body } = makeHost();
    filter.catch(new Error("boom"), host);
    const b = body();
    expect(b.code).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(b.errorCode).toBeNull();
    // 内部错误细节不得泄漏给客户端
    expect(b.message).toBe("服务器内部错误");
    expect(JSON.stringify(b)).not.toContain("boom");
  });

  it("字段级校验错误 → 同时给出可翻译的 VALIDATION_FAILED 码与明细", () => {
    const { host, body } = makeHost();
    // 模拟 class-validator 经管道包装后的形态（BadRequestException + message 数组）
    filter.catch(
      new BadRequestException({ message: ["name must be a string"] }),
      host,
    );
    const b = body();
    expect(b.code).toBe(HttpStatus.BAD_REQUEST);
    expect(b.errorCode).toBe("VALIDATION_FAILED");
    expect(b.params).toEqual({ detail: "name must be a string" });
    // 明细仍进 message（既有消费方只读 message），且 data 保留原始数组
    expect(String(b.message)).toContain("name must be a string");
    expect(b.data).toEqual(["name must be a string"]);
  });

  it("空校验数组 → 单列无明细码，不产生悬空冒号", () => {
    const { host, body } = makeHost();
    filter.catch(new BadRequestException({ message: [] }), host);
    const b = body();
    expect(b.code).toBe(HttpStatus.BAD_REQUEST);
    expect(b.errorCode).toBe("VALIDATION_FAILED_NO_DETAIL");
    expect(b.message).toBe("参数校验失败");
    // 反证：复用带 detail 的模板会渲染出「参数校验失败：」
    expect(String(b.message)).not.toContain("：");
    expect(b.params).toBeNull();
  });
});
