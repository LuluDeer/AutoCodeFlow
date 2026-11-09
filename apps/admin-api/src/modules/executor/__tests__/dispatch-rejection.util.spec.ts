import {
  annotateDispatchRejection,
  classifyDispatchStatus,
  POLICY_REJECTION_HTTP_STATUS,
  readDispatchRejection,
  TRANSIENT_REJECTION_HTTP_STATUSES,
} from "../dispatch-rejection.util";

/**
 * R3-ADMIN-WIRE · A3 的独立单测（**不走 DI 装配**，直接调用纯函数）。
 *
 * ## 钉住的是契约分档，不是实现细节
 *
 * 唯一事实源是 `packages/executor-protocol/protocol.json` 的 `errorStatusCodes`：
 *
 * | 状态码 | 契约段 | 可重试 |
 * |---|---|---|
 * | 400 | `rejectedRequest` / `protocolViolation` / `policyRejection` | **否** |
 * | 429 | `capacityRejection`（`retryable: true`） | 是 |
 * | 503 | `shuttingDownRejection`（`retryable: true`） | 是 |
 *
 * 若将来契约把这些档位改号（例如 policyRejection 改成 422），本文件是**第一个
 * 该红的地方**——这正是把判据从「散落在 if 里的字面量」抽成单一事实源的目的。
 */

describe("classifyDispatchStatus — 契约 errorStatusCodes 分档", () => {
  it("400 ⇒ policy / 不可重试（三段契约同为 400）", () => {
    const v = classifyDispatchStatus(400);
    expect(v.class).toBe("policy");
    expect(v.retryable).toBe(false);
    expect(v.status).toBe(400);
  });

  it("429（容量已满）⇒ transient / 可重试", () => {
    const v = classifyDispatchStatus(429);
    expect(v.class).toBe("transient");
    expect(v.retryable).toBe(true);
  });

  it("503（停机 drain）⇒ transient / 可重试", () => {
    const v = classifyDispatchStatus(503);
    expect(v.class).toBe("transient");
    expect(v.retryable).toBe(true);
  });

  it("**契约未登记的档位不改变既有行为**（401/403/404/500 均 retryable）", () => {
    for (const status of [401, 403, 404, 409, 422, 500, 502]) {
      const v = classifyDispatchStatus(status);
      expect(v.class).toBe("unknown");
      // 「不改变既有行为」= 仍走 BullMQ 重试链
      expect(v.retryable).toBe(true);
    }
  });

  it("常量与契约分档一致（改契约时这里先红）", () => {
    expect(POLICY_REJECTION_HTTP_STATUS).toBe(400);
    expect(TRANSIENT_REJECTION_HTTP_STATUSES).toEqual([429, 503]);
  });

  it("**400 不在瞬时集合里**（否则两个分档会互相覆盖）", () => {
    expect(TRANSIENT_REJECTION_HTTP_STATUSES).not.toContain(400);
  });
});

describe("annotateDispatchRejection / readDispatchRejection — 判定随错误传递", () => {
  it("标注后可读回同一判定", () => {
    const err = new Error("Request failed with status code 400");
    annotateDispatchRejection(err, 400);
    const v = readDispatchRejection(err);
    expect(v?.status).toBe(400);
    expect(v?.retryable).toBe(false);
  });

  it("未标注过的错误 ⇒ null（语义：本次失败与 HTTP 状态码无关）", () => {
    expect(readDispatchRejection(new Error("socket hang up"))).toBeNull();
  });

  it("**标注不会进 JSON.stringify**（不污染既有日志/回调载荷）", () => {
    const err = Object.assign(new Error("boom"), { isAxiosError: true });
    annotateDispatchRejection(err, 400);
    const serialized = JSON.stringify(err);
    // 判定键是 Symbol + non-enumerable ⇒ 不出现在序列化结果里
    expect(serialized).not.toContain("dispatchRejection");
    expect(serialized).not.toContain("policy");
    // 既有可枚举字段（isAxiosError）仍然保留 —— 标注没有改动错误自身的形状
    expect(serialized).toContain("isAxiosError");
    // message 是 Error 的**非枚举**属性，本来就不进 JSON —— 与标注无关，
    // 但标注后仍在错误对象上可读（既有日志读的是 err.message，不受影响）。
    expect(err.message).toBe("boom");
  });

  it("**不改变错误类型**（既有按异常类断言的 spec 零影响）", () => {
    class CustomError extends Error {}
    const err = new CustomError("boom");
    err.name = "CustomError";
    const returned = annotateDispatchRejection(err, 429);
    expect(returned).toBe(err);
    expect(returned).toBeInstanceOf(CustomError);
  });

  it("非对象输入静默跳过（不能因标注失败影响主链）", () => {
    expect(annotateDispatchRejection(null as never, 400)).toBeNull();
    expect(annotateDispatchRejection("str" as never, 400)).toBe("str");
    expect(readDispatchRejection(null)).toBeNull();
    expect(readDispatchRejection("str")).toBeNull();
  });

  it("冻结对象上标注失败也不抛（降级为「无判定」）", () => {
    const frozen = Object.freeze(new Error("frozen"));
    expect(() => annotateDispatchRejection(frozen, 400)).not.toThrow();
    expect(readDispatchRejection(frozen)).toBeNull();
  });

  it("两次标注后者覆盖前者（同一错误被重试路径复用时不留脏判定）", () => {
    const err = new Error("boom");
    annotateDispatchRejection(err, 400);
    annotateDispatchRejection(err, 429);
    expect(readDispatchRejection(err)?.status).toBe(429);
    expect(readDispatchRejection(err)?.retryable).toBe(true);
  });
});
