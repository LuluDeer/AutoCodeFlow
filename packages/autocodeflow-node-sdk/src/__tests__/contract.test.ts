/**
 * QA-07 共享契约测试（autocodeflow-node-sdk 端消费）。
 *
 * 向量来源：packages/contract-fixtures/contract.json（单一事实源，四端
 * acf-cli / mcp-server / 本包 / autoflow-sdk 消费同一份文件）。
 * 契约语义与信封源头见 contract-fixtures/README.md。
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import contract from "../../../contract-fixtures/contract.json";

import axios from "axios";
import { HttpClient } from "../http-client";
import { VALID_FAILURE_REASONS } from "../context";

jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;

/** jest 的 expect 不收 message 参数（vitest 专属）——失败定位用 try/catch 重抛。 */
async function expectUnwraps(
  run: () => Promise<unknown>,
  expected: unknown,
  label: string,
): Promise<void> {
  try {
    await expect(run()).resolves.toEqual(expected);
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`);
  }
}

describe("contract-fixtures (QA-07 shared vectors)", () => {
  let mockInstance: {
    get: jest.Mock;
    post: jest.Mock;
    put: jest.Mock;
    delete: jest.Mock;
    interceptors: { request: { use: jest.Mock }; response: { use: jest.Mock } };
  };

  beforeEach(() => {
    mockInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    };
    mockedAxios.create.mockReturnValue(mockInstance as never);
  });

  it("envelope vectors unwrap to the documented payload via get()", async () => {
    for (const [name, v] of Object.entries(contract.envelope)) {
      mockInstance.get.mockResolvedValueOnce({
        data: (v as { raw: unknown }).raw,
      });
      const client = new HttpClient("http://api.example.com", "t");
      await expectUnwraps(
        () => client.get("/x"),
        (v as { unwrapped: unknown }).unwrapped,
        `envelope.${name}`,
      );
    }
  });

  it("passthrough vectors are returned unchanged via get()", async () => {
    for (const [name, v] of Object.entries(contract.passthrough)) {
      mockInstance.get.mockResolvedValueOnce({
        data: (v as { raw: unknown }).raw,
      });
      const client = new HttpClient("http://api.example.com", "t");
      await expectUnwraps(
        () => client.get("/x"),
        (v as { unwrapped: unknown }).unwrapped,
        `passthrough.${name}`,
      );
    }
  });

  it("knownHeuristicEdge behaves exactly as documented", async () => {
    mockInstance.get.mockResolvedValueOnce({
      data: contract.knownHeuristicEdge.raw,
    });
    const client = new HttpClient("http://api.example.com", "t");
    await expect(client.get("/x")).resolves.toEqual(
      contract.knownHeuristicEdge.unwrapped,
    );
  });

  it("error interceptor surfaces the documented detail from errorBody vectors", async () => {
    new HttpClient("http://api.example.com", "t");
    const onRejected = mockInstance.interceptors.response.use.mock
      .calls[0][1] as (e: unknown) => Promise<never>;
    for (const v of contract.errorBody) {
      const status = (v.raw as { statusCode?: number }).statusCode ?? 400;
      const error = Object.assign(new Error("Request failed"), {
        response: { status, data: v.raw },
      });
      // node-sdk 拦截器只采纳 string 非空 message（不做 error 兜底，也不
      // join message[]）——对「detail 能取到时取 detail 前缀、取不到时
      // 保持原错误」的交集行为断言，见 contract.knownDivergence 注记。
      const stringMessage =
        typeof (v.raw as { message?: unknown }).message === "string"
          ? ((v.raw as { message: string }).message as string)
          : "";
      if (stringMessage) {
        await expect(onRejected(error)).rejects.toMatchObject({
          message: expect.stringContaining(stringMessage),
        });
      } else {
        await expect(onRejected(error)).rejects.toBe(error);
      }
    }
  });
});

// ── NETOPT-G P3: executor-protocol 契约（node-sdk 侧）────────────────────────
// 白名单三源（protocol.json executorReportable / python callback.py / node
// context.ts）当前逐值相等，但 CI 交叉闸门此前只盖到 executor-node 与
// admin-api 两侧（executor-protocol-contract.spec.ts），node-sdk 的
// VALID_FAILURE_REASONS 无测试比对 protocol.json——未来新增 failureReason
// 值会静默落后，直到某任务上报 → admin @IsIn 400 拒掉整批回调。本 describe
// 与 executor-node 侧同款 findRepoRoot 加载同一份单一事实源。
const PROTOCOL_RELATIVE = path.join("packages", "executor-protocol", "protocol.json");

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, PROTOCOL_RELATIVE))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`executor-protocol/protocol.json not found above ${from}`);
}

const protocol = JSON.parse(
  readFileSync(path.join(findRepoRoot(__dirname), PROTOCOL_RELATIVE), "utf-8"),
);

describe("executor-protocol parity (node-sdk side)", () => {
  it("VALID_FAILURE_REASONS 与 failureReason.executorReportable 逐值一致", () => {
    expect([...VALID_FAILURE_REASONS].sort()).toEqual(
      [...protocol.failureReason.executorReportable].sort(),
    );
  });

  it("白名单不含 admin 内部专用取值（stale_recovered 等）", () => {
    for (const internal of protocol.failureReason.adminInternalOnly) {
      expect(VALID_FAILURE_REASONS).not.toContain(internal);
    }
  });
});
