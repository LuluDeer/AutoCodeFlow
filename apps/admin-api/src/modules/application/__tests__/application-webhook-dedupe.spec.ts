import { createHmac } from "crypto";
import { ConfigService } from "@nestjs/config";
import { ApplicationController } from "../application.controller";

/** 与 webhook-hmac.util 同源：sha256=HMAC(secret, `${timestamp}.${rawBody}`)。 */
function sign(secret: string, timestamp: string, body: Buffer): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest("hex")
  );
}

const stubConfig = { get: () => undefined } as unknown as ConfigService;

/**
 * R28 漏网回归：旧键 createHash(signature) 随 timestamp 变化，CI 换时间戳重签
 * 即可绕过去重，重复 updateVersion + 对全部 RUNNING 部署滚动升级。
 */
describe("ApplicationController webhook · 重放去重漏网（R28 / SEC-R3-4）", () => {
  afterEach(() => jest.restoreAllMocks());

  it("同 rawBody 换 timestamp 重签 ⇒ 第二封 deduplicated 且零副作用；异 rawBody 不误杀", async () => {
    const fixedNow = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockReturnValue(fixedNow);
    const seen = new Set<string>();
    const guard = {
      setIfAbsent: jest.fn(async (key: string, ttl: number) => {
        expect(ttl).toBe(10 * 60_000);
        expect(key.startsWith("webhook:app:app-1:")).toBe(true);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
    const svc = {
      findByNameWithSecret: jest.fn().mockResolvedValue({
        id: "app-1",
        name: "my-app",
        webhookSecret: "secret",
      }),
      update: jest.fn().mockResolvedValue({ id: "app-1", version: "1.2.0" }),
      recordUploadVersion: jest.fn(),
    };
    const deploymentSvc = {
      findRunningByApp: jest.fn().mockResolvedValue([{ id: "dep-1" }]),
      upgrade: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new ApplicationController(
      svc as never,
      deploymentSvc as never,
      stubConfig as never,
      guard as never,
    );

    const dto = { appName: "my-app", version: "1.2.0", triggerDeploy: true };
    const rawBody = Buffer.from(JSON.stringify(dto));
    const ts1 = String(fixedNow);
    const ts2 = String(fixedNow + 60_000);

    // 第一封：正常发布，版本写一次、对所有 RUNNING 部署滚动升级一轮
    const first = (await controller.webhook(
      dto,
      sign("secret", ts1, rawBody),
      ts1,
      { rawBody } as never,
    )) as unknown as { ok?: boolean };
    expect(first.ok).toBe(true);
    expect(svc.update).toHaveBeenCalledTimes(1);
    expect(deploymentSvc.upgrade).toHaveBeenCalledTimes(1);

    // 第二封：同 rawBody、新 timestamp 且验签通过 ⇒ 必须命中同键被去重
    const second = (await controller.webhook(
      dto,
      sign("secret", ts2, rawBody),
      ts2,
      { rawBody } as never,
    )) as unknown as { deduplicated?: boolean };
    expect(second).toEqual({ deduplicated: true });
    expect(svc.update).toHaveBeenCalledTimes(1);
    expect(deploymentSvc.upgrade).toHaveBeenCalledTimes(1);
    expect(deploymentSvc.findRunningByApp).toHaveBeenCalledTimes(1);

    // 第三封：异 rawBody（同样验签通过）不能被误杀
    const otherBody = Buffer.from(JSON.stringify({ ...dto, nonce: "other" }));
    const ts3 = String(fixedNow + 120_000);
    const third = (await controller.webhook(
      dto,
      sign("secret", ts3, otherBody),
      ts3,
      { rawBody: otherBody } as never,
    )) as unknown as { ok?: boolean };
    expect(third.ok).toBe(true);
    expect(svc.update).toHaveBeenCalledTimes(2);
    expect(deploymentSvc.upgrade).toHaveBeenCalledTimes(2);
    expect(guard.setIfAbsent).toHaveBeenCalledTimes(3);
    const [k1, k2, k3] = guard.setIfAbsent.mock.calls.map((c) => c[0]);
    expect(k2).toBe(k1);
    expect(k3).not.toBe(k1);
  });
});
