import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { EmailChannel } from "../email.channel";
import { ChannelConfigStore } from "../../channel-config.store";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
import * as nodemailer from "nodemailer";

function cfg(values: Record<string, unknown>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function store(email: Record<string, string>): ChannelConfigStore {
  const s = new ChannelConfigStore();
  s.set("email", email);
  return s;
}

const BASE = {
  host: "smtp.example.com",
  user: "sender@example.com",
  to: "dest@example.com",
  password: "secret-1",
  port: "587",
  secure: "false",
};

describe("EmailChannel · SMTP 连接池缓存", () => {
  const createTransport = nodemailer.createTransport as jest.Mock;
  let sendMail: jest.Mock;
  let close: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    sendMail = jest.fn().mockResolvedValue({ messageId: "1" });
    close = jest.fn();
    createTransport.mockReturnValue({ sendMail, close });
  });

  it("相同 SMTP 配置多次发送复用同一连接池（createTransport 仅一次）", async () => {
    const channel = new EmailChannel(cfg({}), store({ ...BASE }));
    await channel.send({ title: "a", content: "1" } as never);
    await channel.send({ title: "b", content: "2" } as never);
    await channel.send({ title: "c", content: "3" } as never);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: BASE.host,
        port: 587,
        secure: false,
        pool: true,
        auth: { user: BASE.user, pass: "secret-1" },
      }),
    );
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it("配置变更时按新 SHA256 指纹建池并关闭旧池", async () => {
    const channel = new EmailChannel(cfg({}), store({ ...BASE }));
    await channel.send({ title: "a", content: "1" } as never);
    expect(createTransport).toHaveBeenCalledTimes(1);

    // 同一 ChannelConfigStore 改配置（模拟管理台 PATCH 生效）
    channel["store"].set("email", { ...BASE, host: "smtp.changed.com" });
    await channel.send({ title: "b", content: "2" } as never);

    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[1][0].host).toBe("smtp.changed.com");
  });

  it("缓存 key 是连接配置的 SHA256（明文密码不出现在 key 中）", async () => {
    const channel = new EmailChannel(cfg({}), store({ ...BASE }));
    const key = channel["configFingerprint"]({
      host: BASE.host,
      port: 587,
      secure: false,
      user: BASE.user,
      pass: BASE.password,
    });
    expect(key).toBe(
      createHash("sha256")
        .update(JSON.stringify([BASE.host, 587, false, BASE.user, BASE.password]))
        .digest("hex"),
    );
    expect(key).not.toContain(BASE.password);
  });

  it("onModuleDestroy 关闭并清空所有缓存池", async () => {
    const channel = new EmailChannel(cfg({}), store({ ...BASE }));
    await channel.send({ title: "a", content: "1" } as never);
    channel.onModuleDestroy();
    expect(close).toHaveBeenCalledTimes(1);
    expect(channel["transporterCache"].size).toBe(0);
  });
});
