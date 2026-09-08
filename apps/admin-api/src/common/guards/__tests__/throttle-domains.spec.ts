import { Test, TestingModule } from "@nestjs/testing";
import { ExecutionContext } from "@nestjs/common";
import {
  ThrottlerGuard,
  ThrottlerStorageService,
  ThrottlerStorage,
} from "@nestjs/throttler";
import { AUTH_THROTTLE, OPS_THROTTLE } from "../../../config/throttle-profiles";

/**
 * SEC-09: 限流分级行为套件——真实 ThrottlerGuard + 真实内存存储
 * （ThrottlerStorageService），档位来自各路由 @Throttle({ default: ... })
 * 元数据；通过 guard.canActivate 全链路驱动（与全局 APP_GUARD 挂载形态
 * 一致），断言 429 抛出（ThrottlerException → 429）与放行行为。
 *
 * 时间策略：TTL 注入为 300ms 真实窗口（远小于 jest 默认 5s 超时），
 * 「窗口内连发」用同步循环调用 canActivate（内存 increment 为微秒级
 * Promise），无需真实等待/jest fake timers；「窗口过期放行」单独用例
 * 真实 sleep 350ms（用例级，套件总耗时可控）。
 *
 * XFF 防伪对齐既有注记（TRUST_PROXY=false）：tracker = req.ip = socket
 * 地址，测试上下文以 req.ip 直供，伪造 XFF 头不参与分键。
 */

const TTL_MS = 300;

interface FakeReq {
  ip: string;
  headers: Record<string, string>;
}

function makeContext(req: FakeReq): ExecutionContext {
  const handler = { name: "handler" };
  const cls = { name: "FakeController" };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({
        header: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      }),
    }),
    getHandler: () => handler,
    getClass: () => cls,
    getArgs: () => [],
    getArgByIndex: () => ({}),
    switchToRpc: () => ({}) as any,
    switchToWs: () => ({}) as any,
    getType: () => "http",
  } as unknown as ExecutionContext;
}

/**
 * 构造 guard 实例：throttlers 数组提供单 default 域（与 app.module
 * forRootAsync 形状一致，name 缺省 = default）。路由档位以 reflector 桩
 * 给出（与 @Throttle 落到 THROTTLER:LIMITdefault/TTLdefault 的读取路径
 * 一致）——本套件断言 guard 对给定档位的计数/429/复位行为，装饰器到
 * 元数据的绑定由元数据 spec 覆盖。
 */
async function buildGuard(): Promise<ThrottlerGuard> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ThrottlerGuard,
      {
        provide: "THROTTLER:MODULE_OPTIONS",
        useValue: {
          throttlers: [{ name: "default", ttl: TTL_MS, limit: 60 }],
        },
      },
      // 默认内存存储（ThrottlerStorageService）——与 ThrottlerModule 默认装配一致
      {
        provide: ThrottlerStorage as unknown as string,
        useFactory: () => new ThrottlerStorageService(),
      },
    ],
  }).compile();
  const guard = module.get<ThrottlerGuard>(ThrottlerGuard);
  await guard.onModuleInit();
  return guard;
}

type ReflectorStub = (key: string) => unknown;

/** 以显式 limit 档位驱动 N 次请求，返回 [放行数, 429 数]。 */
async function driveWith(
  guard: ThrottlerGuard,
  limit: number,
  hits: number,
  req: FakeReq = { ip: "10.0.0.1", headers: {} },
  reflectorStub?: ReflectorStub,
): Promise<[number, number]> {
  (guard as any).reflector = {
    getAllAndOverride:
      reflectorStub ??
      ((key: string) =>
        key === "THROTTLER:LIMITdefault"
          ? limit
          : key === "THROTTLER:TTLdefault"
            ? TTL_MS
            : undefined),
  };
  let ok = 0;
  let throttled = 0;
  for (let i = 0; i < hits; i++) {
    try {
      await guard.canActivate(makeContext(req));
      ok++;
    } catch {
      throttled++;
    }
  }
  return [ok, throttled];
}

describe("SEC-09 限流分域 — ThrottlerGuard 全链路行为", () => {
  it("严格档：AUTH_THROTTLE.limit 内放行、超过即 429（ThrottlerException）", async () => {
    const guard = await buildGuard();
    expect(AUTH_THROTTLE.limit).toBe(10); // 缺省契约：10/min
    const [ok, throttled] = await driveWith(guard, AUTH_THROTTLE.limit, AUTH_THROTTLE.limit + 3);
    expect(ok).toBe(10);
    expect(throttled).toBe(3);
  });

  it("中档：OPS_THROTTLE.limit 内放行、超过即 429；且比全局默认 60/min 收紧", async () => {
    const guard = await buildGuard();
    expect(OPS_THROTTLE.limit).toBe(30);
    const [ok, throttled] = await driveWith(guard, OPS_THROTTLE.limit, OPS_THROTTLE.limit + 2);
    expect(ok).toBe(30);
    expect(throttled).toBe(2);
  });

  it("窗口过期后自动复位：TTL 过 429 解除，新窗口重新放行（短窗口 350ms 真实等待）", async () => {
    const guard = await buildGuard();
    const [ok1, throttled1] = await driveWith(guard, 2, 4);
    expect(ok1).toBe(2);
    expect(throttled1).toBe(2);
    await new Promise((r) => setTimeout(r, TTL_MS + 100));
    const [ok2, throttled2] = await driveWith(guard, 2, 2);
    expect(ok2).toBe(2);
    expect(throttled2).toBe(0);
  });

  it("THROTTLE_ENABLED=false 全局旁路：throttle.enabled=false → skipIf 短路，超量请求全放行", async () => {
    // 复刻 app.module forRootAsync 工厂的 skipIf 形状（cfg.get("throttle.enabled")）
    const cfg = { get: (k: string) => (k === "throttle.enabled" ? false : 60) };
    const skipIf = () => cfg.get("throttle.enabled") === false;
    const guard = await buildGuard();
    // 对照组：skipIf 未挂上时 limit=1 的高敏档应产生 429
    const [, throttledBaseline] = await driveWith(guard, 1, 10, { ip: "10.0.0.1", headers: {} });
    expect(throttledBaseline).toBeGreaterThan(0);
    // skipIf 注入 commonOptions（app.module 工厂产出形状）后全域旁路
    (guard as any).commonOptions.skipIf = skipIf;
    const [ok2, throttled2] = await driveWith(guard, 1, 15, { ip: "10.0.0.2", headers: {} });
    expect(ok2).toBe(15);
    expect(throttled2).toBe(0);
  });

  it("SSE 豁免档：@SkipThrottle 语义（THROTTLER:SKIPdefault=true）→ guard 直接放行不计数", async () => {
    const guard = await buildGuard();
    const skipStub: ReflectorStub = (key) => (key === "THROTTLER:SKIPdefault" ? true : undefined);
    const [ok, throttled] = await driveWith(guard, 1, 50, { ip: "10.0.0.1", headers: {} }, skipStub);
    expect(ok).toBe(50);
    expect(throttled).toBe(0);
  });

  it("防伪 header 行为保持：XFF 伪造不改变分键（tracker=req.ip，TRUST_PROXY=false 对齐既有注记）——不同伪造 XFF 共享同一计数", async () => {
    const guard = await buildGuard();
    (guard as any).reflector = {
      getAllAndOverride: (key: string) =>
        key === "THROTTLER:LIMITdefault"
          ? 2
          : key === "THROTTLER:TTLdefault"
            ? TTL_MS
            : undefined,
    };
    let ok = 0;
    let throttled = 0;
    for (let i = 0; i < 4; i++) {
      try {
        await guard.canActivate(
          makeContext({
            ip: "10.0.0.9",
            headers: { "x-forwarded-for": `1.2.3.${i}` }, // 每次伪造不同 XFF
          }),
        );
        ok++;
      } catch {
        throttled++;
      }
    }
    // limit=2：若 XFF 参与分键，4 个请求会全部放行；socket IP 分键 → 第 3、4 次 429
    expect(ok).toBe(2);
    expect(throttled).toBe(2);
  });
});
