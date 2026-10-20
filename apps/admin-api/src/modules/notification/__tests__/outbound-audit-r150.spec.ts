/**
 * R150-A1（notification 出站面系统审计）：三轴缺陷的**证明 + 回归钉子**。
 *
 * 本文件每条 `it` 在修复前都是红灯（缺陷存在），修复后转绿；判定为「已正确」
 * 的轴同样在此给出可执行证据（不是只写注释）。
 *
 * 轴 1（出站安全/SSRF/凭据）：闸门面由 safe-http.util 与
 * `channels/__tests__/channels.spec.ts`（DNS pinning / maxRedirects:0 钉子）
 * 覆盖，本文件只补「日志脱敏」这一环的纯函数证据（含 userinfo）。
 * 轴 2（失败语义/可观测）：未知渠道路由 = 静默丢弃（缺陷 A）。
 * 轴 3（配置面）：静默 channelType 白名单漏 feishu（缺陷 B）；读面 URL 凭据
 * 漏 `?key=`（缺陷 C）。
 */
import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";

import { AlertChannel, NotificationService } from "../notification.service";
import { WecomChannel } from "../channels/wecom.channel";
import { DingtalkChannel } from "../channels/dingtalk.channel";
import { EmailChannel } from "../channels/email.channel";
import { SlackChannel } from "../channels/slack.channel";
import { WebhookChannel } from "../channels/webhook.channel";
import { FeishuChannel } from "../channels/feishu.channel";
import { AuditService } from "../../audit/audit.service";
import { ChannelConfigStore } from "../channel-config.store";
import { NotificationConfigService } from "../notification-config.service";
import { NotificationSilenceService } from "../notification-silence.service";
import { NotificationSilence } from "../entities/notification-silence.entity";
import { redactUrlForLog } from "../channels/log-safe-url.util";
import { classifyDeliveryFailure } from "../channels/base.channel";
import axios from "axios";
import * as nodemailer from "nodemailer";

// 轴 2 的失败分类要在一个真实渠道的 catch 分支上验证：只 mock axios，
// 用 IP 字面量 URL（93.184.216.34）绕过 DNS，不触网。
jest.mock("axios");
jest.mock("nodemailer");

/** 空 env 的 ConfigService 替身（渠道的 env 兜底层） */
const makeConfig = (values: Record<string, unknown> = {}): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const mockChannel = () => ({ send: jest.fn() });

const joinLogs = (spy: jest.SpyInstance): string =>
  spy.mock.calls.map((c) => c.map((a) => String(a)).join(" ")).join("\n");

// ============================================================================
// 轴 2：未知渠道路由 —— 告警静默消失（缺陷 A）
//
// 现场：`Task.alarmChannels` 是**自由字符串数组**（create-task.dto 只挂
// @IsArray，没有 @IsIn(Object.values(AlertChannel))），而 notification.service
// 把它原样 `as AlertChannel[]` 强转后扇出。一个人写错的名字（拼写/历史值/
// 尾随空格）会让 six-if 全部不命中：entries 为空 → 零投递、零日志、零指标；
// 「全部失败落审计」的兜底判据是 `entries.length > 0 && 全部 failed`，空扇出
// 恰好绕过它 → 该任务的每一次失败告警**不留任何痕迹**地消失。
//
// 期望：一个都没匹配上时必须有 warn（点名被忽略的名字）+ 一条
// NOTIFICATION_FAILED 审计（resource=notification_fanout），这是排障唯一入口。
// ============================================================================
describe("R150-A1 轴2: 未注册渠道名不得静默吞掉告警", () => {
  const buildService = async (audit: { log: jest.Mock }) => {
    const module = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: WecomChannel, useFactory: mockChannel },
        { provide: DingtalkChannel, useFactory: mockChannel },
        { provide: EmailChannel, useFactory: mockChannel },
        { provide: SlackChannel, useFactory: mockChannel },
        { provide: WebhookChannel, useFactory: mockChannel },
        { provide: FeishuChannel, useFactory: mockChannel },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    return {
      svc: module.get(NotificationService),
      channels: {
        email: module.get(EmailChannel) as { send: jest.Mock },
        slack: module.get(SlackChannel) as { send: jest.Mock },
        wecom: module.get(WecomChannel) as { send: jest.Mock },
        dingtalk: module.get(DingtalkChannel) as { send: jest.Mock },
        webhook: module.get(WebhookChannel) as { send: jest.Mock },
        feishu: module.get(FeishuChannel) as { send: jest.Mock },
      },
    };
  };

  it("任务配了全部未注册的渠道名 → 零投递，但必须留 warn + NOTIFICATION_FAILED 审计", async () => {
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const { svc, channels } = await buildService({ log: auditLog });
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    const results = await svc.notifyFailureWithConfig(
      "task-1",
      "exec-1",
      "boom",
      "",
      undefined,
      ["slack-ops", "smtp"],
    );

    // 零投递是事实（不是缺陷本身），缺陷是「零痕迹」
    expect(results).toEqual({});
    for (const ch of Object.values(channels)) {
      expect(ch.send).not.toHaveBeenCalled();
    }

    // ① 运维能在日志里看到被忽略的名字
    const logged = joinLogs(warnSpy);
    expect(logged).toContain("slack-ops");
    expect(logged).toContain("smtp");

    // ② 审计面留证（与「全部渠道失败」同一 resource，便于同一查询面检索）
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "NOTIFICATION_FAILED",
        resource: "notification_fanout",
        detail: expect.objectContaining({
          requestedChannels: ["slack-ops", "smtp"],
          unknownChannels: ["slack-ops", "smtp"],
        }),
      }),
    );
    warnSpy.mockRestore();
  });

  it("部分名字无效 + 有渠道真的投递成功 → 只 warn，不落审计（不放大审计噪声）", async () => {
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const { svc, channels } = await buildService({ log: auditLog });
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    channels.email.send.mockResolvedValue("sent");

    const results = await svc.notifyFailureWithConfig(
      "task-1",
      "exec-1",
      "boom",
      "",
      undefined,
      ["email", "slack-ops"],
    );

    expect(results).toEqual({ email: "sent" });
    expect(joinLogs(warnSpy)).toContain("slack-ops");
    expect(auditLog).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("渠道名大小写/前后空格不再改变语义（notifyTimeout 的 toLowerCase 归一化仍有效）", async () => {
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const { svc, channels } = await buildService({ log: auditLog });
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    channels.email.send.mockResolvedValue("sent");

    // notifyTimeout 内部已 toLowerCase；这里钉住"大写 EMAIL 仍可路由"
    await svc.notifyTimeout("task-1", "exec-1", 60, "t-1", undefined, [
      "EMAIL",
    ]);
    expect(channels.email.send).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// ============================================================================
// 轴 3-B：静默 channelType 白名单漏 feishu（缺陷 B）
//
// NF-05 把 feishu 加进了 AlertChannel / 渠道清单 / admin-web，但
// NotificationSilenceService 的白名单是**手写第四份**，仍是五值：
// POST /notification/silences {channelType:"feishu"} 直接 400
// NOTIFICATION_SILENCE_CHANNEL_TYPE_INVALID —— 一个已注册渠道无法被静默。
// ============================================================================
describe("R150-A1 轴3: 静默 channelType 白名单必须覆盖全部已注册渠道", () => {
  const makeRepo = () => ({
    create: jest.fn((d: unknown) => ({ ...(d as object), id: "sil-1" })),
    save: jest.fn((e: unknown) => Promise.resolve({ ...(e as object), id: "sil-1" })),
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  });

  const buildService = async () => {
    const module = await Test.createTestingModule({
      providers: [
        NotificationSilenceService,
        { provide: getRepositoryToken(NotificationSilence), useValue: makeRepo() },
      ],
    }).compile();
    return module.get(NotificationSilenceService);
  };

  it("每个已注册渠道（含 feishu）都能作为 channelType 建静默", async () => {
    const service = await buildService();
    for (const channel of Object.values(AlertChannel)) {
      await expect(
        service.create({ scope: "global", channelType: channel }),
      ).resolves.toBeDefined();
    }
  });

  it("仍未注册的名字照样被拒（白名单没有被放宽成任意字符串）", async () => {
    const service = await buildService();
    await expect(
      service.create({ scope: "global", channelType: "pagerduty" }),
    ).rejects.toThrow();
    await expect(
      service.create({ scope: "global", channelType: "feishu " }),
    ).rejects.toThrow();
  });
});

// ============================================================================
// 轴 3-C：渠道 URL 里的凭据在读面（GET/PATCH /notification/channels）明文回显
//
// WeCom 群机器人 URL 的形态是 `.../webhook/send?key=<凭据>`——`key` 就是全部
// 认证材料。同一模块的**日志**脱敏 regex（log-safe-url.util 的
// SECRET_QUERY_PARAM_RE）明确把 key/sign 当机密，但读面 regex
// （URL_SECRET_QUERY_RE）只认 pass/secret/token → 同一个值在日志里是 `***`、
// 在 ADMIN 接口响应里是明文。
// ============================================================================
describe("R150-A1 轴3: 读面 URL 凭据掩码覆盖 WeCom ?key=", () => {
  const WECOM_URL =
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=11111111-2222-3333-4444-555555555555";

  const buildService = async () => {
    const env: Record<string, unknown> = {};
    const store = new ChannelConfigStore();
    const module = await Test.createTestingModule({
      providers: [
        NotificationConfigService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((k: string) => env[k]) },
        },
        { provide: NotificationService, useValue: { sendAll: jest.fn() } },
        { provide: ChannelConfigStore, useValue: store },
      ],
    }).compile();
    return { svc: module.get(NotificationConfigService), store };
  };

  it("GET/PATCH 读面把 ?key= 掩成 ***，且不含原值", async () => {
    const { svc } = await buildService();
    const patched = svc.updateChannel("wecom", {
      config: { webhookUrl: WECOM_URL },
    });
    expect(patched.config.webhookUrl).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***",
    );
    const read = svc.getChannel("wecom")!.config.webhookUrl;
    expect(read).not.toContain("11111111-2222-3333-4444-555555555555");
    expect(read).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***",
    );
  });

  it("store 与发送路径仍是原值（掩码只在读面）", async () => {
    const { svc, store } = await buildService();
    svc.updateChannel("wecom", { config: { webhookUrl: WECOM_URL } });
    expect(store.get("wecom")).toEqual({ webhookUrl: WECOM_URL });
  });

  it("掩码回显（?key=***）回传不覆盖真实凭据", async () => {
    const { svc, store } = await buildService();
    svc.updateChannel("wecom", { config: { webhookUrl: WECOM_URL } });
    svc.updateChannel("wecom", {
      config: {
        webhookUrl:
          "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***",
      },
    });
    expect(store.get("wecom")).toEqual({ webhookUrl: WECOM_URL });
  });

  it("非机密 query 参数（format/x）照旧原样保留（不过度掩码）", async () => {
    const { svc } = await buildService();
    svc.updateChannel("webhook", {
      config: { url: "https://example.com/hook?format=json&x=1" },
    });
    expect(svc.getChannel("webhook")!.config.url).toBe(
      "https://example.com/hook?format=json&x=1",
    );
  });
});

// ============================================================================
// 轴 1-D：日志脱敏纯函数证据（含 userinfo —— 读面掩码管不到的那一类）
// ============================================================================
describe("R150-A1 轴1: 出站日志 URL 脱敏", () => {
  it("userinfo 被抹掉（scheme/host/path 保留，凭据不留）", () => {
    const out = redactUrlForLog("https://user:pass@hooks.example.com/x?id=1");
    expect(out).toBe("https://[redacted]@hooks.example.com/x?id=1");
    expect(out).not.toContain("pass");
  });

  it("secret 类 query 参数（pass/secret/token/key/sign）全部掩码", () => {
    const out = redactUrlForLog(
      "https://h/x?access_token=t1&key=k1&secret=s1&password=p1&sign=z1&format=json",
    );
    expect(out).toContain("access_token=***");
    expect(out).toContain("key=***");
    expect(out).toContain("secret=***");
    expect(out).toContain("password=***");
    expect(out).toContain("sign=***");
    // 非机密参数不受影响
    expect(out).toContain("format=json");
    for (const leaked of ["t1", "k1", "s1", "p1", "z1"]) {
      expect(out).not.toMatch(new RegExp(`[=?&]${leaked}(&|$)`));
    }
  });

  it("空值不炸（null/undefined/空串 → 空串）", () => {
    expect(redactUrlForLog(null)).toBe("");
    expect(redactUrlForLog(undefined)).toBe("");
    expect(redactUrlForLog("")).toBe("");
  });
});

// ============================================================================
// 轴 2：投递失败的原因可区分（缺陷 D ——"一律 failed"的日志面）
//
// 契约面 ChannelDeliveryStatus 保持 4 值（sent/blocked/failed/skipped）不变是
// 对的：DTO、指标标签、admin-web 都按它写的。但**日志**此前把
// "4xx（配置错）/5xx（对端故障）/timeout/network（链路）" 全部打成同一个
// "send failed after retries: <message>"，运维要先读异常文本才能判断该改配置
// 还是该等对端。修复：日志带分类（classifyDeliveryFailure），状态不变。
// ============================================================================
describe("R150-A1 轴2: 失败原因分类（只进日志，不改状态契约）", () => {
  it("HTTP 状态码 → 3xx/4xx/5xx", () => {
    expect(classifyDeliveryFailure({ response: { status: 302 } })).toBe(
      "http_3xx_redirect",
    );
    expect(classifyDeliveryFailure({ response: { status: 404 } })).toBe(
      "http_4xx",
    );
    expect(classifyDeliveryFailure({ response: { status: 503 } })).toBe(
      "http_5xx",
    );
  });

  it("超时与网络故障分开（axios timeout / ECONNREFUSED / DNS）", () => {
    // axios 的 timeout 没有 code，只有 message
    expect(
      classifyDeliveryFailure(new Error("timeout of 10000ms exceeded")),
    ).toBe("timeout");
    expect(classifyDeliveryFailure({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyDeliveryFailure({ code: "ECONNREFUSED" })).toBe("network");
    expect(classifyDeliveryFailure({ code: "ENOTFOUND" })).toBe("network");
    expect(classifyDeliveryFailure(new Error("socket hang up"))).toBe(
      "network",
    );
  });

  it("无法识别的错误回 unknown（不猜）", () => {
    expect(classifyDeliveryFailure(new Error("smtp 550 bad mailbox"))).toBe(
      "unknown",
    );
    expect(classifyDeliveryFailure(undefined)).toBe("unknown");
    expect(classifyDeliveryFailure(null)).toBe("unknown");
  });

  it("真实渠道的 catch 日志里带分类（WebhookChannel + 超时）", async () => {
    const store = new ChannelConfigStore();
    const channel = new WebhookChannel(store);
    const timeoutErr = Object.assign(new Error("timeout of 10000ms exceeded"), {
      code: "ECONNABORTED",
    });
    (axios.post as jest.Mock) = jest.fn().mockRejectedValue(timeoutErr);
    const errSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});

    // IP 字面量目标：公开地址，assertAndPinHttpUrl 判为 public，无需 DNS
    await expect(
      channel.send({ title: "t", content: "c" }, "http://93.184.216.34/hook"),
    ).resolves.toBe("failed");

    const logged = joinLogs(errSpy);
    expect(logged).toContain("send failed after retries");
    expect(logged).toContain("(timeout)");
    errSpy.mockRestore();
  });
});

// ============================================================================
// 轴 3：管理台「关闭渠道」必须真的停止投递（缺陷 E）
//
// 承诺写了两处、实现只落了一处：
//  · ChannelConfigStore 头注：「a disabled channel's config **must not take
//    effect**」；
//  · admin-web 用例「关闭邮件渠道开关 → PATCH {enabled:false} + 禁用 toast」。
// 实际：全模块只有 webhook.channel.ts 读过 isEnabled()，其余五个渠道无视开关
// 继续用已保存配置投递 —— 用户点关闭、界面报成功、告警照发。
//
// 边界（有意）：只闸**已保存配置**层。env 兜底（SLACK_WEBHOOK / WECOM_WEBHOOK
// …）是部署态配置而不是管理台开关；把整条解析链闸掉会让"只配 env"的部署在
// 启动瞬间静默失联（loadFromEnv 把各渠道 enabled 默认发布成 false）。
// 反向钉子：从未发布过开关的 store（fixture 直接 seed config）必须仍视为开启
// —— isEnabled 的 `?? true` 语义。
// ============================================================================
describe("R150-A1 轴3: enabled=false 的已保存配置不得生效", () => {
  const PUBLIC_URL = "http://93.184.216.34/hook";

  const httpChannels: Array<[string, any]> = [
    ["slack", SlackChannel],
    ["dingtalk", DingtalkChannel],
    ["wecom", WecomChannel],
    ["feishu", FeishuChannel],
  ];

  beforeEach(() => {
    (axios.post as unknown as jest.Mock) = jest
      .fn()
      .mockResolvedValue({ status: 200 });
  });

  for (const [key, ChannelClass] of httpChannels) {
    it(`${key}: 已保存配置 + enabled=false → skipped，零 HTTP 请求`, async () => {
      const store = new ChannelConfigStore();
      store.set(key, { webhookUrl: PUBLIC_URL }, false);
      const channel = new ChannelClass(makeConfig(), store);

      await expect(
        channel.send({ title: "t", content: "c" }),
      ).resolves.toBe("skipped");
      expect(axios.post).not.toHaveBeenCalled();
    });

    it(`${key}: 已保存配置 + enabled=true → 照常投递`, async () => {
      const store = new ChannelConfigStore();
      store.set(key, { webhookUrl: PUBLIC_URL }, true);
      const channel = new ChannelClass(makeConfig(), store);

      await expect(
        channel.send({ title: "t", content: "c" }),
      ).resolves.toBe("sent");
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it(`${key}: 从未发布开关（fixture 直接 seed 配置）→ 视为开启，既有语义不破`, async () => {
      const store = new ChannelConfigStore();
      store.set(key, { webhookUrl: PUBLIC_URL }); // 不传 enabled
      expect(store.isEnabled(key)).toBe(true);
      const channel = new ChannelClass(makeConfig(), store);

      await expect(
        channel.send({ title: "t", content: "c" }),
      ).resolves.toBe("sent");
    });
  }

  it("email: 已保存 SMTP 配置 + enabled=false → skipped，连 transporter 都不建", async () => {
    const store = new ChannelConfigStore();
    store.set(
      "email",
      { host: "smtp.example.com", user: "u", to: "to@example.com" },
      false,
    );
    const channel = new EmailChannel(makeConfig(), store);

    await expect(
      channel.send({ title: "t", content: "c" }),
    ).resolves.toBe("skipped");
    expect((nodemailer.createTransport as jest.Mock)).not.toHaveBeenCalled();
  });

  it("email: enabled=true → 正常走 SMTP", async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    (nodemailer.createTransport as jest.Mock) = jest
      .fn()
      .mockReturnValue({ sendMail });
    const store = new ChannelConfigStore();
    store.set(
      "email",
      { host: "smtp.example.com", user: "u", to: "to@example.com" },
      true,
    );
    const channel = new EmailChannel(makeConfig(), store);

    await expect(
      channel.send({ title: "t", content: "c" }),
    ).resolves.toBe("sent");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("关闭渠道后 env 兜底仍然生效（env 是部署态配置，不是管理台开关）", async () => {
    const store = new ChannelConfigStore();
    store.set("slack", { webhookUrl: PUBLIC_URL }, false);
    const channel = new SlackChannel(
      makeConfig({ "notification.slackWebhook": PUBLIC_URL }),
      store,
    );

    await expect(
      channel.send({ title: "t", content: "c" }),
    ).resolves.toBe("sent");
  });
});
