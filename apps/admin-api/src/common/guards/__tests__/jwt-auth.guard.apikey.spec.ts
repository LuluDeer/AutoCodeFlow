import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
// passport 与 @nestjs/passport 的 AuthGuard 共享同一模块单例，这里注册的桩策略
// 只作用于本测试文件（jest 每文件独立模块注册表），不进产品装配。
import passport from "passport";
import { JwtAuthGuard } from "../jwt-auth.guard";

/**
 * AUTH-03: 全局 JwtAuthGuard 分流——acf_ 前缀凭证走 API-Key 分支，
 * 其余凭证维持 passport-jwt 原路径（含 SSE ?access_token= 查询串回退），
 * @Public 路由零变化。API_KEY_AUTH_FACADE 缺省（既有单测装配）时
 * acf_ 请求回落 JWT 路径并 401，不崩。
 *
 * ## 为什么本文件需要注册一个「恒失败」的 jwt 桩策略（本轮修假绿）
 * 原用例把三个 passport 路径写成 try/catch 且 catch 体为空，断言只有
 * 「facade 未被调用」。实测该 catch 吞掉的是
 *   TypeError: context.switchToHttp(...).getResponse is not a function
 * ——AuthGuard.canActivate 在进 passport **之前**必取 getResponse，而本文件的
 * 假 ExecutionContext 只有 getRequest；于是用例从没走到 passport、更没走到
 * handleRequest，只要守卫抛**任何**东西（含装配改动泄漏出的 500/TypeError）
 * 都判绿。现在把 context 补成真实形态 + 用桩策略把 passport 路径跑通到
 * handleRequest，断言具体到「UnauthorizedException / 401 /
 * Invalid or expired token」：装配退化（getResponse 丢失、策略名改错、
 * handleRequest 被绕过成 500）都会以类型不符转红，而不是被 catch 吞掉。
 */
const REFLECTOR = { getAllAndOverride: jest.fn().mockReturnValue(false) };

// 恒失败策略：passport 失败 → AuthGuard.handleRequest(null, false) →
// JwtAuthGuard.handleRequest 抛 UnauthorizedException。这是「无有效凭证」
// 在生产里的真实终点，用它替代原先「单测环境装配不全」的伪错误。
(passport as unknown as { use: (name: string, strategy: unknown) => void }).use(
  "jwt",
  {
    name: "jwt",
    authenticate(this: { fail: (challenge: unknown, status: number) => void }) {
      this.fail({ message: "No auth token" }, 401);
    },
  },
);

function makeContext(authHeader?: string) {
  const req: Record<string, any> = {
    method: "GET",
    path: "/api/tasks",
    headers: authHeader ? { authorization: authHeader } : {},
  };
  return {
    // getResponse 必须给：@nestjs/passport 的 AuthGuard.canActivate 无条件取它
    // （auth.guard.js:38）。缺了它守卫在 passport 之前就抛 TypeError——那正是
    // 旧用例掩盖掉的形态。
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/**
 * 断言「走 passport 路径 → 具体 401」。
 * 三种失败形态分开判：resolved（守卫静默放行 = 认证绕过）、类型不是
 * UnauthorizedException（装配错误泄漏成 TypeError/500）、状态码/文案漂移。
 */
async function expectJwtPathRejects401(p: Promise<unknown>): Promise<void> {
  // 第一步钉类型：抛 TypeError/ForbiddenException/500 一律红——这是 catch{}
  // 时代被吞掉的形态。若守卫静默返回 true（认证绕过），jests 的 rejects
  // 也会直接以 "promise resolved instead of rejecting" 失败。
  await expect(p).rejects.toBeInstanceOf(UnauthorizedException);
  // 第二步钉 401 语义：类型对但状态码/文案漂移（例如 handleRequest 被改成
  // 抛裸 Error 或 403）同样红。
  await expect(p).rejects.toMatchObject({
    status: 401,
    message: "Invalid or expired token",
    response: { statusCode: 401, message: "Invalid or expired token" },
  });
}

describe("AUTH-03 JwtAuthGuard 分流", () => {
  const makeGuard = (facade?: { authenticate: jest.Mock }) =>
    new (JwtAuthGuard as any)(REFLECTOR, facade);

  it("Bearer acf_… → 分发到 ApiKeyAuthFacade.authenticate", async () => {
    const facade = { authenticate: jest.fn(async () => true) };
    const guard = makeGuard(facade);
    await expect(
      guard.canActivate(makeContext("Bearer acf_deadbeef")),
    ).resolves.toBe(true);
    expect(facade.authenticate).toHaveBeenCalledTimes(1);
  });

  it("Bearer <JWT> → 不进 API-Key 分支（facade 零调用，走 passport 并 401）", async () => {
    const facade = { authenticate: jest.fn() };
    const guard = makeGuard(facade);
    await expectJwtPathRejects401(
      guard.canActivate(makeContext("Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")),
    );
    expect(facade.authenticate).not.toHaveBeenCalled();
  });

  it("无 Authorization 头 → 不进 API-Key 分支（同样落到 passport 的 401）", async () => {
    const facade = { authenticate: jest.fn() };
    const guard = makeGuard(facade);
    await expectJwtPathRejects401(guard.canActivate(makeContext()));
    expect(facade.authenticate).not.toHaveBeenCalled();
  });

  it("@Public 路由 → 恒 true，两种凭证都不触发", async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    const facade = { authenticate: jest.fn() };
    const guard = new (JwtAuthGuard as any)(reflector, facade);
    await expect(
      guard.canActivate(makeContext("Bearer acf_deadbeef")),
    ).resolves.toBe(true);
    expect(facade.authenticate).not.toHaveBeenCalled();
  });

  it("API_KEY_AUTH_FACADE 未注入（既有装配）→ acf_ 回落 JWT 路径并 401，不抛 TypeError", async () => {
    const guard = makeGuard(undefined);
    // 关键回归面：acf_ 凭证不得因 facade 缺失去调 this.apiKeyAuth.authenticate
    // （undefined.authenticate → TypeError → 500）。断言收紧到 401 具体类型后，
    // 该形态即使被 catch 也红。
    await expectJwtPathRejects401(
      guard.canActivate(makeContext("Bearer acf_deadbeef")),
    );
  });
});
