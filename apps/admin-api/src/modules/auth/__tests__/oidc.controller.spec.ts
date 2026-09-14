/**
 * AUTH-04: OidcController 单测——status/302/错误码面/fragment 携带。
 * Response 用最小 mock（redirect/setHeader/status/json），断言不依赖 express。
 */
import { Logger } from "@nestjs/common";
import { OidcController } from "../oidc.controller";

function makeResInner(reqCookie?: string) {
  const state = {
    headers: {} as Record<string, string | string[]>,
    statusCode: 0,
    redirectedTo: "",
    body: undefined as unknown,
  };
  const res = {
    get req() {
      return {
        headers: { ...(reqCookie ? { cookie: reqCookie } : {}) } as Record<
          string,
          string | undefined
        >,
        ip: "127.0.0.1",
      };
    },
    setHeader: (k: string, v: string | string[]) => {
      state.headers[k] = v;
    },
    redirect: (code: number, url: string) => {
      state.statusCode = code;
      state.redirectedTo = url;
    },
    status: (code: number) => {
      state.statusCode = code;
      return {
        json: (b: unknown) => {
          state.body = b;
        },
      };
    },
    json: (b: unknown) => {
      state.body = b;
    },
  };
  return Object.assign(res, { _state: state });
}

function makeController(overrides: Record<string, unknown> = {}) {
  const oidc = {
    enabled: true,
    getWebRedirectUrl: () => "http://127.0.0.1:5173/auth/sso/complete",
    createStateCookieValue: () => ({
      value: "cGF5bG9hZA.c2ln",
      state: "payload-state",
    }),
    buildAuthorizeUrl: jest
      .fn()
      .mockResolvedValue("http://127.0.0.1:18440/authorize?client_id=x"),
    completeLogin: jest.fn().mockResolvedValue({
      accessToken: "at-123",
      refreshToken: "rt-456",
      username: "alice",
    }),
    ...overrides,
  };
  return { controller: new OidcController(oidc as never), oidc };
}

describe("OidcController（AUTH-04）", () => {
  it("status 返回 enabled 开关", () => {
    const { controller } = makeController({ enabled: false });
    expect(controller.status()).toEqual({ enabled: false });
  });

  it("login：enabled → 302 IdP + state cookie（HttpOnly/SameSite=Lax/Path 收窄）", async () => {
    const { controller } = makeController();
    const res = makeResInner();
    await controller.login(res as never);
    expect(res._state.statusCode).toBe(302);
    expect(res._state.redirectedTo).toContain("/authorize");
    const cookie = String(res._state.headers["set-cookie"]);
    expect(cookie).toContain("acf_oidc_state=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/auth/oidc/callback");
  });

  it("login：disabled → 404", async () => {
    const { controller } = makeController({ enabled: false });
    const res = makeResInner();
    await controller.login(res as never);
    expect(res._state.statusCode).toBe(404);
  });

  it("callback：IdP 错误 → 302 落地页带 error 码并清 cookie", async () => {
    const { controller } = makeController();
    const res = makeResInner("acf_oidc_state=cGF5bG9hZA.c2ln");
    await controller.callback(undefined, "s", "access_denied", res as never);
    expect(res._state.statusCode).toBe(302);
    expect(res._state.redirectedTo).toContain(
      "#error=idp_error%3Aaccess_denied",
    );
    expect(String(res._state.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("callback：缺 code/state/cookie → 302 missing_code_or_state", async () => {
    const { controller } = makeController();
    const res = makeResInner();
    await controller.callback("code", "state", undefined, res as never);
    expect(res._state.redirectedTo).toContain("#error=missing_code_or_state");
  });

  it("callback：成功 → 302 fragment 携带 token（不落 query）", async () => {
    const { controller, oidc } = makeController();
    const res = makeResInner("acf_oidc_state=cGF5bG9hZA.c2ln");
    await controller.callback(
      "the-code",
      "payload-state",
      undefined,
      res as never,
    );
    expect(oidc.completeLogin).toHaveBeenCalledWith(
      "the-code",
      "cGF5bG9hZA.c2ln",
      expect.objectContaining({ expectedState: "payload-state" }),
    );
    expect(res._state.statusCode).toBe(302);
    expect(res._state.redirectedTo).toContain("#access_token=at-123");
    expect(res._state.redirectedTo).toContain("refresh_token=rt-456");
    expect(res._state.redirectedTo).toContain("username=alice");
    // fragment 语义：redirect URL 的 ? 不承载 token
    expect(res._state.redirectedTo.split("?")[1] ?? "").not.toContain(
      "access_token",
    );
  });

  it("callback：service 抛错 → 稳定错误码（不泄露内部消息）", async () => {
    const { controller } = makeController({
      completeLogin: jest
        .fn()
        .mockRejectedValue(new Error("OIDC id_token nonce mismatch")),
    });
    const res = makeResInner("acf_oidc_state=cGF5bG9hZA.c2ln");
    await controller.callback(
      "the-code",
      "payload-state",
      undefined,
      res as never,
    );
    expect(res._state.redirectedTo).toContain("#error=nonce_invalid");
    expect(res._state.redirectedTo).not.toContain("nonce%20mismatch");
  });

  // R-23（DEEP_REVIEW 0ef3bbe）: 错误路径经 Nest Logger 收口，不再裸 console.warn
  // ——console.warn 游离于统一日志管道与 trace 上下文之外。
  describe("R-23: 错误日志经 Nest Logger 收口", () => {
    it("login 失败 → Logger.warn 记录且不触碰 console.warn", async () => {
      const { controller } = makeController({
        buildAuthorizeUrl: jest.fn().mockRejectedValue(new Error("idp down")),
      });
      const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      const consoleSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      try {
        const res = makeResInner();
        await controller.login(res as never);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[OIDC] login failed"),
        );
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        consoleSpy.mockRestore();
      }
    });

    it("callback 失败 → Logger.warn 记录且不触碰 console.warn", async () => {
      const { controller } = makeController({
        completeLogin: jest.fn().mockRejectedValue(new Error("state mismatch")),
      });
      const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      const consoleSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      try {
        const res = makeResInner("acf_oidc_state=cGF5bG9hZA.c2ln");
        await controller.callback("c", "s", undefined, res as never);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[OIDC] callback failed"),
        );
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        consoleSpy.mockRestore();
      }
    });
  });
});
