/**
 * N6 · IM webhook 接入层单测（controller 直调 / 内存替身级）。
 *
 * 验证的是接入纪律而不是 service 语义：
 *   ① 验签失败时 adapter / intake 零调用（entry 不可绕过）；
 *   ② challenge 只回显、不调 intake（且回显也在验签之后）；
 *   ③ 正常消息调 intake，senderId / platform 来自 adapter 而非 body 自报。
 * 注入扫描 / 身份绑定 / ProjectRole 全在 ImIntakeService 内部，本层不重写、
 * 也不覆盖——验收级别止于单测 / 内存替身，不代表真 HTTP 入站或 Nest DI 集成。
 */
jest.mock("@nestjs/common", () => ({
  Body: () => () => undefined,
  Controller: () => () => undefined,
  Get: () => () => undefined,
  Headers: () => () => undefined,
  HttpCode: () => () => undefined,
  // AppError extends HttpException：给真实错误码目录留一个最小基类。
  HttpException: class HttpException extends Error {},
  Logger: class {
    warn() {}
    log() {}
    error() {}
  },
  Optional: () => () => undefined,
  Param: () => () => undefined,
  Post: () => () => undefined,
  Query: () => () => undefined,
  Req: () => () => undefined,
  SetMetadata: () => () => undefined,
  createParamDecorator: () => () => () => undefined,
}));

jest.mock("@nestjs/swagger", () => ({
  ApiBearerAuth: () => () => undefined,
  ApiBody: () => () => undefined,
  ApiOkResponse: () => () => undefined,
  ApiOperation: () => () => undefined,
  ApiParam: () => () => undefined,
  ApiProperty: () => () => undefined,
  ApiPropertyOptional: () => () => undefined,
  ApiTags: () => () => undefined,
}));

jest.mock("../../users/entities/user.entity", () => ({
  UserRole: { ADMIN: "admin" },
}));
jest.mock("../entities/im-identity.entity", () => ({
  IM_PLATFORMS: ["wecom", "feishu"],
  ImIdentity: class {},
}));
jest.mock("../im-identity.service", () => ({ ImIdentityService: class {} }));
jest.mock("../im-intake.service", () => ({ ImIntakeService: class {} }));

// adapter 保留真实纯函数语义，仅包一层计数 spy，用于反证「验签失败零调用」。
jest.mock("../im-webhook.adapter", () => {
  const actual = jest.requireActual("../im-webhook.adapter");
  return {
    ...actual,
    isChallengeRequest: jest.fn(actual.isChallengeRequest),
    buildChallengeResponse: jest.fn(actual.buildChallengeResponse),
    extractImMessage: jest.fn(actual.extractImMessage),
  };
});

import { createHmac } from "node:crypto";

import type { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import * as adapter from "../im-webhook.adapter";
import type { ImIntakeDto } from "../dto/im-intake.dto";
import { ImIdentityController } from "../im-identity.controller";
import type { ImIdentityService } from "../im-identity.service";
import type { ImIntakeService } from "../im-intake.service";

const SECRET = "n6-im-webhook-signing-secret";
// 验签窗口是真实的 ±5min（util 内部读 Date.now），哨针必须取当下时刻。
const NOW = Date.now();
const WETEXT = "每月5号导出销售报表";

const wecomBody = () => ({
  FromUserName: "zhangsan",
  content: WETEXT,
  ChatId: "chat-001",
  MsgId: "msg-001",
});

const feishuBody = () => ({
  schema: "2.0",
  event: {
    sender: { sender_id: { user_id: "u-123", open_id: "ou-456" } },
    message: { content: WETEXT, chat_id: "oc-789", message_id: "om-abc" },
  },
});

function sign(
  raw: string,
  timestamp: string | number,
  secret = SECRET,
): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(Buffer.from(raw, "utf8"))
      .digest("hex")
  );
}

function rawOf(body: unknown): string {
  return JSON.stringify(body);
}

function reqOf(raw: string): Request & { rawBody: Buffer } {
  return { rawBody: Buffer.from(raw, "utf8") } as Request & {
    rawBody: Buffer;
  };
}

function makeController(secret = SECRET) {
  const intake = jest.fn().mockResolvedValue({ eligible: true });
  const get = jest.fn().mockReturnValue(secret);
  const controller = new ImIdentityController(
    {} as ImIdentityService,
    { intake } as unknown as ImIntakeService,
    { get } as unknown as ConfigService,
  );
  return { controller, intake, get };
}

const spies = () => ({
  challenge: adapter.isChallengeRequest as jest.Mock,
  echo: adapter.buildChallengeResponse as jest.Mock,
  extract: adapter.extractImMessage as jest.Mock,
});

/** webhook 是同步方法（返回 string | Promise）；失败要按抛错而非 rejected promise 断言。 */
function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err: unknown) {
    caught = err;
  }
  expect(caught).toMatchObject({ errorCode: code });
}

describe("ImIdentityController.webhook — N6 接入层纪律（单测/内存替身）", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("[反证] 签名无效 ⇒ 统一 authFail，adapter/intake 零调用", async () => {
    const body = wecomBody();
    const raw = rawOf(body);
    const { controller, intake } = makeController();
    // 即便 query 带 challenge，验签失败也必须在其之前短路，不得回显。
    expectCode(
      () =>
        controller.webhook(
          "wecom",
          { echostr: "unverified-echo" },
          body,
          "sha256=" + "0".repeat(64),
          String(NOW),
          reqOf(raw),
        ),
      "APP_WEBHOOK_AUTH_FAILED",
    );

    expect(spies().challenge).not.toHaveBeenCalled();
    expect(spies().echo).not.toHaveBeenCalled();
    expect(spies().extract).not.toHaveBeenCalled();
    expect(intake).not.toHaveBeenCalled();
  });

  it("[反证] 时间戳超窗（±5min）⇒ authFail 且 adapter/intake 零调用", async () => {
    const body = wecomBody();
    const raw = rawOf(body);
    const stale = String(NOW - 10 * 60_000);
    const { controller, intake } = makeController();
    expectCode(
      () =>
        controller.webhook(
          "wecom",
          {},
          body,
          sign(raw, stale),
          stale,
          reqOf(raw),
        ),
      "APP_WEBHOOK_AUTH_FAILED",
    );

    expect(spies().challenge).not.toHaveBeenCalled();
    expect(spies().extract).not.toHaveBeenCalled();
    expect(intake).not.toHaveBeenCalled();
  });

  it("[反证] 签名密钥未配置 ⇒ fail-closed，adapter/intake 零调用", async () => {
    const body = wecomBody();
    const raw = rawOf(body);
    const { controller, intake } = makeController("");
    expectCode(
      () =>
        controller.webhook(
          "wecom",
          {},
          body,
          sign(raw, String(NOW), ""),
          String(NOW),
          reqOf(raw),
        ),
      "APP_WEBHOOK_AUTH_FAILED",
    );

    expect(spies().extract).not.toHaveBeenCalled();
    expect(intake).not.toHaveBeenCalled();
  });

  it("[控制组] 验签通过的 challenge 只回显、不调 intake", async () => {
    const body = wecomBody();
    const raw = rawOf(body);
    const { controller, intake } = makeController();
    const echo = "W3cOmE-echo-0123456789";
    const result = controller.webhook(
      "wecom",
      { echostr: echo },
      body,
      sign(raw, String(NOW)),
      String(NOW),
      reqOf(raw),
    );
    expect(result).toBe(echo);

    expect(spies().challenge).toHaveBeenCalledTimes(1);
    expect(spies().echo).toHaveBeenCalledTimes(1);
    expect(spies().extract).not.toHaveBeenCalled();
    expect(intake).not.toHaveBeenCalled();
  });

  it("[反证] 验签通过但 challenge 串空 ⇒ fail-closed，不调 intake", async () => {
    const body = wecomBody();
    const raw = rawOf(body);
    const { controller, intake } = makeController();
    expectCode(
      () =>
        controller.webhook(
          "wecom",
          { echostr: "" },
          body,
          sign(raw, String(NOW)),
          String(NOW),
          reqOf(raw),
        ),
      "VALIDATION_FAILED",
    );
    expect(intake).not.toHaveBeenCalled();
  });

  it("[控制组] 企微消息 ⇒ 调 intake，senderId 来自 adapter 而非 body 自报", async () => {
    const body = {
      ...wecomBody(),
      platform: "feishu",
      imSenderId: "body-attacker",
      message: "body-spoofed-text",
    };
    const raw = rawOf(body);
    const { controller, intake } = makeController();
    await controller.webhook(
      "wecom",
      {},
      body,
      sign(raw, String(NOW)),
      String(NOW),
      reqOf(raw),
    );

    expect(spies().extract).toHaveBeenCalledWith("wecom", body);
    expect(intake).toHaveBeenCalledTimes(1);
    const dto = intake.mock.calls[0][0] as ImIntakeDto;
    expect(dto).toEqual({
      platform: "wecom",
      imSenderId: "zhangsan",
      message: WETEXT,
      cadence: "monthly",
    });
  });

  it("[控制组] 飞书消息 ⇒ 平台严格隔离，取 event.sender.sender_id", async () => {
    const body = { ...feishuBody(), platform: "wecom", FromUserName: "spoof" };
    const raw = rawOf(body);
    const { controller, intake } = makeController();
    await controller.webhook(
      "feishu",
      {},
      body,
      sign(raw, String(NOW)),
      String(NOW),
      reqOf(raw),
    );

    expect(spies().extract).toHaveBeenCalledWith("feishu", body);
    const dto = intake.mock.calls[0][0] as ImIntakeDto;
    expect(dto).toEqual({
      platform: "feishu",
      imSenderId: "u-123",
      message: WETEXT,
      cadence: "monthly",
    });
  });

  it("[反证] 路径平台非法 ⇒ VALIDATION_FAILED 且 intake 零调用", async () => {
    const body = wecomBody();
    const raw = rawOf(body);
    const { controller, intake } = makeController();
    expectCode(
      () =>
        controller.webhook(
          "dingtalk",
          {},
          body,
          sign(raw, String(NOW)),
          String(NOW),
          reqOf(raw),
        ),
      "VALIDATION_FAILED",
    );
    expect(spies().extract).not.toHaveBeenCalled();
    expect(intake).not.toHaveBeenCalled();
  });

  it("[反证] payload 缺字段 ⇒ VALIDATION_FAILED 且 intake 零调用", async () => {
    const body = { FromUserName: "zhangsan" };
    const raw = rawOf(body);
    const { controller, intake } = makeController();
    expectCode(
      () =>
        controller.webhook(
          "wecom",
          {},
          body,
          sign(raw, String(NOW)),
          String(NOW),
          reqOf(raw),
        ),
      "VALIDATION_FAILED",
    );
    expect(intake).not.toHaveBeenCalled();
  });
});
