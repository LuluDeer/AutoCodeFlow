/**
 * N6：IM webhook adapter 单测（纯函数，零 HTTP / DB / 加解密 I/O）。
 *
 * 反证用例以 [反证] 标注：若实现退化成「空 echostr 被回显」或「跨平台字段
 * 混读」，对应用例立即转红；[控制组] 紧跟其后，证明 fail-closed 不是把一切
 * 都判 null 的假绿。验签由调用方先跑 verifyWebhookSignature，本层只做判定
 * 与提取，不在本文件重写任何 HMAC 逻辑。
 */
import {
  IM_ADAPTER_SENDER_ID_MAX,
  IM_ADAPTER_TEXT_MAX,
  IM_CHALLENGE_MAX,
  buildChallengeResponse,
  extractImMessage,
  isChallengeRequest,
} from "../im-webhook.adapter";

const wecomBody = () => ({
  FromUserName: "zhangsan",
  content: "每月5号导出销售报表",
  ChatId: "chat-001",
  MsgId: "msg-001",
});

const feishuBody = () => ({
  schema: "2.0",
  event: {
    sender: { sender_id: { user_id: "u-123", open_id: "ou-456" } },
    message: {
      content: "每月5号导出销售报表",
      chat_id: "oc-789",
      message_id: "om-abc",
    },
  },
});

describe("isChallengeRequest", () => {
  it("企微 echostr → true", () => {
    expect(isChallengeRequest({ echostr: "verify-token-wecom" })).toBe(true);
  });

  it("飞书 challenge → true", () => {
    expect(isChallengeRequest({ challenge: "verify-token-feishu" })).toBe(true);
  });

  it("[反证] 空 echostr 仍判为 challenge 请求（不得分流到消息提取）", () => {
    expect(isChallengeRequest({ echostr: "" })).toBe(true);
    expect(isChallengeRequest({ challenge: "" })).toBe(true);
  });

  it("无 challenge 键 / 空 query → false", () => {
    expect(isChallengeRequest({})).toBe(false);
    expect(isChallengeRequest(null)).toBe(false);
    expect(isChallengeRequest(undefined)).toBe(false);
    expect(isChallengeRequest({ imSenderId: "zhangsan" })).toBe(false);
  });

  it("[反证] 非字符串值（重复参数数组 / 对象 / 数字）→ false", () => {
    expect(isChallengeRequest({ echostr: ["a", "b"] })).toBe(false);
    expect(isChallengeRequest({ challenge: { value: "x" } })).toBe(false);
    expect(isChallengeRequest({ echostr: 42 })).toBe(false);
  });

  it("[反证] 两平台 challenge 键共存 → false（歧义 fail-closed）", () => {
    expect(
      isChallengeRequest({ echostr: "wecom-token", challenge: "feishu-token" }),
    ).toBe(false);
  });
});

describe("buildChallengeResponse", () => {
  it("[控制组] 企微 echostr 逐字节回显", () => {
    const token = "W3cOmE-echo-0123456789";
    expect(buildChallengeResponse({ echostr: token })).toBe(token);
  });

  it("[控制组] 飞书 challenge 逐字节回显", () => {
    const token = "Fe1ShU-challenge-0123456789";
    expect(buildChallengeResponse({ challenge: token })).toBe(token);
  });

  it("[反证] 空 echostr 回显 ⇒ 本例转红", () => {
    expect(buildChallengeResponse({ echostr: "" })).toBeNull();
  });

  it("[反证] 纯空白 challenge 回显 ⇒ 本例转红", () => {
    expect(buildChallengeResponse({ challenge: "   \t\n" })).toBeNull();
  });

  it(`[反证] 超长回显串（>${IM_CHALLENGE_MAX}）⇒ null`, () => {
    expect(
      buildChallengeResponse({ echostr: "a".repeat(IM_CHALLENGE_MAX + 1) }),
    ).toBeNull();
    expect(
      buildChallengeResponse({ challenge: "a".repeat(IM_CHALLENGE_MAX + 1) }),
    ).toBeNull();
  });

  it(`[控制组] 长度恰为 ${IM_CHALLENGE_MAX} 的回显串正常回显`, () => {
    const token = "a".repeat(IM_CHALLENGE_MAX);
    expect(buildChallengeResponse({ echostr: token })).toBe(token);
  });

  it("[反证] 非字符串 / 缺失 / 双键共存 ⇒ null", () => {
    expect(buildChallengeResponse({ echostr: 42 })).toBeNull();
    expect(buildChallengeResponse({ echostr: ["a"] })).toBeNull();
    expect(buildChallengeResponse({})).toBeNull();
    expect(buildChallengeResponse(null)).toBeNull();
    expect(
      buildChallengeResponse({ echostr: "wecom", challenge: "feishu" }),
    ).toBeNull();
  });
});

describe("extractImMessage — 平台隔离与 fail-closed", () => {
  it("企微 payload 提取 senderId + 文本 + 可选溯源字段", () => {
    expect(extractImMessage("wecom", wecomBody())).toEqual({
      platform: "wecom",
      senderId: "zhangsan",
      text: "每月5号导出销售报表",
      chatId: "chat-001",
      messageId: "msg-001",
    });
  });

  it("飞书 payload（v2）提取 senderId + 文本", () => {
    expect(extractImMessage("feishu", feishuBody())).toEqual({
      platform: "feishu",
      senderId: "u-123",
      text: "每月5号导出销售报表",
      chatId: "oc-789",
      messageId: "om-abc",
    });
  });

  it("飞书 v2 content 为 JSON 串 ⇒ 解出内层 text", () => {
    const body = feishuBody();
    body.event.message.content = JSON.stringify({ text: "帮我看下这份报表" });
    expect(extractImMessage("feishu", body)?.text).toBe("帮我看下这份报表");
  });

  it("飞书 senderId 回退 open_id", () => {
    expect(
      extractImMessage("feishu", {
        event: {
          sender: { sender_id: { open_id: "ou-only" } },
          message: { content: "hi" },
        },
      })?.senderId,
    ).toBe("ou-only");
  });

  it("飞书 v1 senderId 回退 message.sender_id", () => {
    expect(
      extractImMessage("feishu", {
        event: { message: { content: "hi", sender_id: "ou-v1" } },
      })?.senderId,
    ).toBe("ou-v1");
  });

  it("[反证] 企微缺 FromUserName 或 content ⇒ null", () => {
    expect(extractImMessage("wecom", { content: "hi" })).toBeNull();
    expect(extractImMessage("wecom", { FromUserName: "zhangsan" })).toBeNull();
    expect(
      extractImMessage("wecom", { FromUserName: "  ", content: "hi" }),
    ).toBeNull();
  });

  it("[反证] 飞书缺 event / message / content / sender ⇒ null", () => {
    expect(extractImMessage("feishu", {})).toBeNull();
    expect(
      extractImMessage("feishu", { event: { message: { content: "hi" } } }),
    ).toBeNull();
    expect(
      extractImMessage("feishu", {
        event: { sender: { sender_id: { user_id: "u-1" } } },
      }),
    ).toBeNull();
  });

  it("[反证] 跨平台字段误读：企微平台收到飞书 payload ⇒ null", () => {
    expect(extractImMessage("wecom", feishuBody())).toBeNull();
  });

  it("[反证] 跨平台字段误读：飞书平台收到企微 payload ⇒ null", () => {
    expect(extractImMessage("feishu", wecomBody())).toBeNull();
  });

  it("[控制组] 同一 payload 换回正确平台即正常提取", () => {
    expect(extractImMessage("wecom", wecomBody())?.senderId).toBe("zhangsan");
    expect(extractImMessage("feishu", feishuBody())?.senderId).toBe("u-123");
  });

  it("[反证] 未知平台 / body 非对象 ⇒ null", () => {
    expect(extractImMessage("telegram", wecomBody())).toBeNull();
    expect(extractImMessage("", feishuBody())).toBeNull();
    for (const bad of [null, undefined, [], "text", 42]) {
      expect(extractImMessage("wecom", bad)).toBeNull();
      expect(extractImMessage("feishu", bad)).toBeNull();
    }
  });

  it("[反证] 超长 senderId / text ⇒ null", () => {
    expect(
      extractImMessage("wecom", {
        FromUserName: "a".repeat(IM_ADAPTER_SENDER_ID_MAX + 1),
        content: "hi",
      }),
    ).toBeNull();
    expect(
      extractImMessage("wecom", {
        FromUserName: "zhangsan",
        content: "a".repeat(IM_ADAPTER_TEXT_MAX + 1),
      }),
    ).toBeNull();
  });

  it(`[反证] 飞书 JSON content 解包后超长（>${IM_ADAPTER_TEXT_MAX}）⇒ null`, () => {
    const body = feishuBody();
    body.event.message.content = JSON.stringify({
      text: "a".repeat(IM_ADAPTER_TEXT_MAX + 1),
    });
    expect(extractImMessage("feishu", body)).toBeNull();
  });

  it("[反证] 畸形 JSON content 按纯文本处理，不抛异常", () => {
    const body = feishuBody();
    body.event.message.content = "{not-json";
    expect(extractImMessage("feishu", body)?.text).toBe("{not-json");
  });
});
