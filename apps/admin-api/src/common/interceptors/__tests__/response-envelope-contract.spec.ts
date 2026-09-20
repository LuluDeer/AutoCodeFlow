import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

import { CallHandler, ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";

import { ResponseInterceptor } from "../response.interceptor";

/**
 * NETOPT-10-2: contract.json 的 envelope / statusRange 段在 admin-api 侧缺少
 * 守卫——此前唯一消费者只机检 channelList（A4），而 envelope 行为（code 镜像
 * HTTP 状态码、message 恒 "success"、data 恒包装/null）只被四个客户端包的
 * fixture 测试从"消费端"断言。若 ResponseInterceptor 行为漂移（message 提取、
 * code 计算、空 data 处理），四端 fixture 测试各自为绿，只有 e2e 才红。
 *
 * 本 spec 从**生产端**逐向量钉住同一份 contract.json：
 * - `envelope.*`：拦截器输出必须逐字等于 fixture 的 raw envelope；
 * - `statusRange.*`：success[] 与 failure[] 每个状态码都必须原样镜像为
 *   `code`（无状态码特判绕过）；
 * - `passthrough` / `errorBody` / `knownHeuristicEdge` 是**消费端**（四个 SDK
 *   的 unwrap 逻辑）向量，由各包自身的 fixture 测试守卫；错误响应经全局异常
 *   过滤器直接返回、不走本拦截器，故不在此断言。
 */
describe("response envelope contract (NETOPT-10-2)", () => {
  const contract = loadContractFixture();

  it("契约自守：envelope 段非空且每个向量都有 raw/unwrapped", () => {
    const entries = Object.entries(contract.envelope);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, v] of entries) {
      expect({ name, raw: v.raw }).toEqual({
        name,
        raw: expect.any(Object),
      });
      expect(v).toHaveProperty("unwrapped");
    }
  });

  it("envelope.* 每个向量：拦截器输出逐字等于 fixture 的 raw envelope", async () => {
    for (const [name, v] of Object.entries(contract.envelope)) {
      const out = await runInterceptor(v.raw.code, v.raw.data);
      expect({ vector: name, out }).toEqual({ vector: name, out: v.raw });
    }
  });

  it("statusRange.* 每个状态码都镜像为 code（message 恒 success、data 原样、无状态码特判）", async () => {
    const codes = [
      ...(contract.statusRange.success as number[]),
      ...(contract.statusRange.failure as number[]),
    ];
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const marker = { marker: code };
      const out = await runInterceptor(code, marker);
      expect({ code, out }).toEqual({
        code,
        out: { code, message: "success", data: marker },
      });
    }
  });

  it("handler 返回 undefined 时包装为 data: null（envelope.nullData 同源语义）", async () => {
    const out = await runInterceptor(200, undefined);
    expect(out).toEqual({ code: 200, message: "success", data: null });
  });
});

/** 构造最小 ExecutionContext：ResponseInterceptor 只读 response.statusCode。 */
function makeContext(statusCode: number): ExecutionContext {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ statusCode }),
      getRequest: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

/** 驱动拦截器跑一个 handler 返回值，返回最终包装后的对象。 */
function runInterceptor(
  statusCode: number,
  data: unknown,
): Promise<Record<string, unknown>> {
  const interceptor = new ResponseInterceptor();
  const next: CallHandler = { handle: () => of(data) };
  return new Promise((resolvePromise, reject) => {
    interceptor.intercept(makeContext(statusCode), next).subscribe({
      next: (value) => resolvePromise(value as Record<string, unknown>),
      error: reject,
    });
  });
}

/** 按标记文件向上找仓库根再取 fixture（与 channel-list-contract.spec.ts 同款）。 */
function loadContractFixture(): {
  envelope: Record<
    string,
    { raw: { code: number; data: unknown }; unwrapped: unknown }
  >;
  statusRange: { success: number[]; failure: number[] };
} {
  for (let dir = resolve(__dirname); ; dir = join(dir, "..")) {
    const candidate = join(
      dir,
      "packages",
      "contract-fixtures",
      "contract.json",
    );
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8"));
    }
    if (!existsSync(join(dir, "package.json")) && dir === resolve(dir, "..")) {
      throw new Error(
        "contract-fixtures/contract.json not found (repo root walk failed)",
      );
    }
  }
}
