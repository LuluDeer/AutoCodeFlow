/**
 * AUTH-04: OidcService 单测——ID Token RS256 验签矩阵（node:crypto 真签真验）、
 * iss/aud/exp/nonce 校验、无状态 state cookie（HMAC 签名/时效/防篡改）、
 * 身份定位三级（sub → username 绑定 → JIT 建号）与 completeLogin 集成链。
 */
import { createSign, createHmac, generateKeyPairSync } from "node:crypto";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { OidcService, OIDC_STATE_COOKIE } from "../oidc.service";

jest.mock("axios");
// issuer 用 127.0.0.1 IP 字面量 + allowPrivateNetwork=true：assertSafeHttpUrl
// 真跑分类器（IP 直判放行），不依赖 DNS。
const mockedAxios = jest.requireMock("axios") as {
  get: jest.Mock;
  post: jest.Mock;
};

const ISSUER = "http://127.0.0.1:18440";
const CLIENT_ID = "autoflow-admin";
const CLIENT_SECRET = "oidc-client-secret-0123456789";
const REDIRECT_URI = "http://127.0.0.1:3105/api/auth/oidc/callback";

/** 测试内生成 RSA 密钥对并构造 JWK（模拟 IdP JWKS）。 */
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwkPublic = {
  ...(
    publicKey as unknown as { export: (o: object) => Record<string, string> }
  ).export({ format: "jwk" }),
  kid: "test-key-1",
  alg: "RS256",
  use: "sig",
} as {
  kty: string;
  kid: string;
  alg: string;
  use: string;
  n: string;
  e: string;
};

function makeConfigService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    "oidc.enabled": true,
    "oidc.issuer": ISSUER,
    "oidc.clientId": CLIENT_ID,
    "oidc.clientSecret": CLIENT_SECRET,
    "oidc.redirectUri": REDIRECT_URI,
    "oidc.scopes": "openid profile email",
    "oidc.usernameClaim": "preferred_username",
    "oidc.autoProvision": false,
    "oidc.webRedirectUrl": "http://127.0.0.1:5173/auth/sso/complete",
    "oidc.allowPrivateNetwork": true,
    "jwt.refreshSecret": "test-refresh-secret-32chars-longxx",
    ...overrides,
  };
  return { get: (k: string) => values[k] };
}

function makeService(overrides: Record<string, unknown> = {}) {
  const usersRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x) => ({ id: 42, isActive: true, ...x })),
    save: jest.fn(async (x) => x),
  };
  const authService = {
    issueTokensForOidcUser: jest
      .fn()
      .mockResolvedValue({ accessToken: "at", refreshToken: "rt" }),
  };
  const service = new OidcService(
    makeConfigService(overrides) as never,
    authService as never,
    usersRepo as never,
  );
  return { service, usersRepo, authService };
}

function discoveryBody() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks.json`,
  };
}

const b64u = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

/** 用测试私钥签出 id_token（RS256）。 */
function signIdToken(
  claims: Record<string, unknown>,
  kid = "test-key-1",
): string {
  const header = { alg: "RS256", kid };
  const input = `${b64u(header)}.${b64u(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  const sig = signer.sign(privateKey, "base64url");
  return `${input}.${sig}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    sub: "sub-abc-123",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    nonce: "nonce-xyz",
    preferred_username: "alice",
    email: "alice@example.com",
    ...overrides,
  };
}

async function primeDiscovery(service: OidcService) {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith("/.well-known/openid-configuration")) {
      return { data: discoveryBody() };
    }
    if (url.endsWith("/jwks.json")) {
      return { data: { keys: [jwkPublic] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  await service.getDiscovery();
}

beforeEach(() => {
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
});

describe("OidcService — 无状态 state cookie（HMAC）", () => {
  it("create → verify 往返成功，state/nonce 齐备", () => {
    const { service } = makeService();
    const { value, state } = service.createStateCookieValue();
    const payload = service.verifyStateCookieValue(value);
    expect(payload.state).toBe(state);
    expect(payload.nonce).toBeTruthy();
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("篡改 payload / 换签名密钥 → 拒", () => {
    const { service } = makeService();
    const { value } = service.createStateCookieValue();
    const [body, sig] = value.split(".");
    const tampered = `${Buffer.from(
      JSON.stringify({
        state: "evil",
        nonce: "evil",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url")}.${sig}`;
    expect(() => service.verifyStateCookieValue(tampered)).toThrow(
      UnauthorizedException,
    );
    expect(() => service.verifyStateCookieValue(`${body}.${sig}x`)).toThrow(
      UnauthorizedException,
    );
  });

  it("过期 state → 拒", () => {
    const { service } = makeService();
    const body = Buffer.from(
      JSON.stringify({
        state: "s",
        nonce: "n",
        exp: Math.floor(Date.now() / 1000) - 10,
      }),
    ).toString("base64url");
    // 用与 service 相同密钥签出合法签名但已过期的载荷
    const good = `${body}.${createHmac(
      "sha256",
      "test-refresh-secret-32chars-longxx",
    )
      .update(body)
      .digest("base64url")}`;
    expect(() => service.verifyStateCookieValue(good)).toThrow(/expired/);
  });

  it("缺 cookie → 拒", () => {
    const { service } = makeService();
    expect(() => service.verifyStateCookieValue(undefined)).toThrow(
      UnauthorizedException,
    );
  });
});

describe("OidcService — discovery 与 authorize URL", () => {
  it("enabled 但缺必填配置 → 400", async () => {
    const { service } = makeService({ "oidc.issuer": "" });
    await expect(service.buildAuthorizeUrl("x.y")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("authorize URL 携带 client/redirect/scope/state/nonce；discovery 缓存生效", async () => {
    const { service } = makeService();
    await primeDiscovery(service);
    const { value } = service.createStateCookieValue();
    const url = new URL(await service.buildAuthorizeUrl(value));
    expect(url.toString()).toContain("/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
    // 第二次调用不再触发 discovery HTTP
    await service.buildAuthorizeUrl(service.createStateCookieValue().value);
    const discoveryCalls = mockedAxios.get.mock.calls.filter((c: unknown[]) =>
      String(c[0]).endsWith(".well-known/openid-configuration"),
    );
    expect(discoveryCalls).toHaveLength(1);
  });
});

describe("OidcService — ID Token 验签矩阵（真 RS256）", () => {
  it("正确签名 + 全声明匹配 → 通过并提取身份", async () => {
    const { service } = makeService();
    await primeDiscovery(service);
    const profile = await service.validateIdToken(
      signIdToken(validClaims()),
      "nonce-xyz",
    );
    expect(profile.sub).toBe("sub-abc-123");
    expect(profile.username).toBe("alice");
    expect(profile.email).toBe("alice@example.com");
  });

  it("错误签名（密钥不符）→ 拒", async () => {
    const { service } = makeService();
    await primeDiscovery(service);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const input = `${b64u({ alg: "RS256", kid: "test-key-1" })}.${b64u(validClaims())}`;
    const signer = createSign("RSA-SHA256");
    signer.update(input);
    const sig = signer.sign(other.privateKey, "base64url");
    await expect(
      service.validateIdToken(`${input}.${sig}`, "nonce-xyz"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("nonce / iss / aud 不匹配、过期、alg 非 RS256、kid 未知 → 全部拒", async () => {
    const { service } = makeService();
    await primeDiscovery(service);

    await expect(
      service.validateIdToken(
        signIdToken(validClaims({ nonce: "other" })),
        "nonce-xyz",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.validateIdToken(
        signIdToken(validClaims({ iss: "https://evil.example" })),
        "nonce-xyz",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.validateIdToken(
        signIdToken(validClaims({ aud: "other-client" })),
        "nonce-xyz",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.validateIdToken(
        signIdToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 120 })),
        "nonce-xyz",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const hsToken = `${b64u({ alg: "HS256" })}.${b64u(validClaims())}.fakesig`;
    await expect(
      service.validateIdToken(hsToken, "nonce-xyz"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.validateIdToken(
        signIdToken(validClaims(), "unknown-kid"),
        "nonce-xyz",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("OidcService — 身份定位与 JIT 建号", () => {
  const profile = {
    sub: "sub-abc-123",
    username: "alice",
    email: "alice@example.com",
    groups: [],
  };

  it("sub 精确命中 → 直接返回", async () => {
    const { service, usersRepo } = makeService();
    usersRepo.findOne.mockImplementation(async ({ where }) =>
      (where as { oidcSub?: string }).oidcSub === "sub-abc-123"
        ? { id: 7, username: "alice", isActive: true, oidcSub: "sub-abc-123" }
        : null,
    );
    const user = await service.resolveAndBindUser(profile);
    expect(user.id).toBe(7);
  });

  it("username 命中（未绑定）→ 绑定 sub 后返回", async () => {
    const { service, usersRepo } = makeService();
    usersRepo.findOne.mockResolvedValue(null);
    usersRepo.findOne
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({
        id: 8,
        username: "alice",
        isActive: true,
        oidcSub: null,
      }));
    const user = await service.resolveAndBindUser(profile);
    expect(user.id).toBe(8);
    expect(usersRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ oidcSub: "sub-abc-123" }),
    );
  });

  it("username 已绑定其他 sub → 拒（不静默换绑）", async () => {
    const { service, usersRepo } = makeService();
    usersRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 8,
      username: "alice",
      isActive: true,
      oidcSub: "other-sub",
    });
    await expect(service.resolveAndBindUser(profile)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("无匹配 + autoProvision=true → JIT 建号（占位密码、USER 角色、sub 落库）", async () => {
    const { service, usersRepo } = makeService({ "oidc.autoProvision": true });
    usersRepo.findOne.mockResolvedValue(null);
    const user = await service.resolveAndBindUser(profile);
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "alice",
        oidcSub: "sub-abc-123",
        role: "user",
      }),
    );
    expect((user as { password?: string }).password).toBeTruthy();
  });

  it("无匹配 + autoProvision=false → 拒", async () => {
    const { service, usersRepo } = makeService();
    usersRepo.findOne.mockResolvedValue(null);
    await expect(service.resolveAndBindUser(profile)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("命中账号但 isActive=false → 拒", async () => {
    const { service, usersRepo } = makeService();
    usersRepo.findOne.mockResolvedValue({
      id: 7,
      username: "alice",
      isActive: false,
      oidcSub: "sub-abc-123",
    });
    await expect(service.resolveAndBindUser(profile)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe("OidcService — 组→角色映射（R20，仅 JIT 建号时生效）", () => {
  const profile = (groups: string[]) => ({
    sub: "sub-new-1",
    username: "bob",
    email: null,
    groups,
  });

  it("OIDC_ADMIN_GROUPS 未配置（默认空）→ 建号恒 USER", async () => {
    const { service, usersRepo } = makeService({ "oidc.autoProvision": true });
    usersRepo.findOne.mockResolvedValue(null);
    await service.resolveAndBindUser(profile(["platform-admins"]));
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user" }),
    );
  });

  it("命中 OIDC_ADMIN_GROUPS 清单内组 → 建号即 ADMIN", async () => {
    const { service, usersRepo } = makeService({
      "oidc.autoProvision": true,
      "oidc.adminGroups": "platform-admins, sre",
    });
    usersRepo.findOne.mockResolvedValue(null);
    await service.resolveAndBindUser(profile(["sre"]));
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: "admin" }),
    );
  });

  it("组不在清单 → USER；组声明缺失 → USER", async () => {
    const { service, usersRepo } = makeService({
      "oidc.autoProvision": true,
      "oidc.adminGroups": "platform-admins",
    });
    usersRepo.findOne.mockResolvedValue(null);
    await service.resolveAndBindUser(profile(["devs"]));
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user" }),
    );
    await service.resolveAndBindUser(profile([]));
    expect(usersRepo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: "user" }),
    );
  });

  it("已绑定账号不在映射作用域：IdP 组变化不改写存量角色", async () => {
    const { service, usersRepo } = makeService({
      "oidc.adminGroups": "platform-admins",
    });
    // sub 命中的既有 USER 账号，即便其在 admin 组也不被提权/降级
    usersRepo.findOne.mockResolvedValue({
      id: 9,
      username: "carol",
      role: "user",
      isActive: true,
      oidcSub: "sub-new-1",
    });
    const user = await service.resolveAndBindUser(profile(["platform-admins"]));
    expect(user.role).toBe("user");
    expect(usersRepo.save).not.toHaveBeenCalled();
  });
});

describe("OidcService — completeLogin 集成链", () => {
  it("state 双向比对失败 → 拒；成功链 → 令牌签发且 username 回传", async () => {
    const { service, authService, usersRepo } = makeService();
    const { value } = service.createStateCookieValue();
    // ① cookie state 与 query state 不一致
    await expect(
      service.completeLogin("the-code", value, { expectedState: "mismatched" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // ② 正常链（IdP 交互 mock 到 handler 级）
    await primeDiscovery(service);
    usersRepo.findOne.mockResolvedValue(null);
    usersRepo.findOne.mockImplementationOnce(async () => null);
    // exchangeCode → token endpoint
    const nonce = service.verifyStateCookieValue(value).nonce;
    mockedAxios.post.mockResolvedValue({
      data: { id_token: signIdToken(validClaims({ nonce })) },
    });
    // resolveAndBindUser：sub 未命中，username 命中并绑定
    usersRepo.findOne.mockReset();
    usersRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 8,
      username: "alice",
      isActive: true,
      oidcSub: null,
    });

    const result = await service.completeLogin("the-code", value, {
      expectedState: service.verifyStateCookieValue(value).state,
    });
    expect(result.username).toBe("alice");
    expect(result.accessToken).toBe("at");
    expect(authService.issueTokensForOidcUser).toHaveBeenCalled();
    // token endpoint 收到 code + 客户端凭据（client_secret_post）
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${ISSUER}/token`,
      expect.stringContaining(encodeURIComponent(CLIENT_SECRET)),
      expect.anything(),
    );
  });
});

describe("OidcService — 常量", () => {
  it("state cookie 名固定（前端/运维可识别）", () => {
    expect(OIDC_STATE_COOKIE).toBe("acf_oidc_state");
  });
});
