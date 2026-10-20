/**
 * R177-A1（对外 SDK 健壮性审计）——轴 1「错误面」/ 轴 2「回调重试豁免的路径判定」。
 *
 * 为什么这些符号用 require 取而不是顶层 import：缺陷期它们**还不存在**，
 * 顶层 import 会让整个文件编译失败（ts-jest 直接报 TS2305），把「导出缺失」
 * 这条证据藏在编译错误里；用 require 时它表现为一条可读的断言失败。
 */
import axios from 'axios';

import { HttpClient, isTerminalCallbackUrl,
  effectiveRetryMaxWaitMs,
  CALLBACK_MAX_WAIT_MS } from '../http-client';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

type AnyModule = Record<string, any>;

const httpClientModule = (): AnyModule => require('../http-client') as AnyModule;
const sdkEntry = (): AnyModule => require('../index') as AnyModule;

describe('R177-A1 轴1：错误面必须可分类', () => {
  it('从包入口就能拿到熔断错误类型（否则调用方无法 instanceof）', () => {
    // 缺陷现场：CircuitBreakerOpenError 定义在 http-client.ts 且是 export，
    // 但 index.ts 没有 re-export —— 'import { CircuitBreakerOpenError } from
    // "@autocodeflow/sdk"' 直接编译失败，消费方只能靠 name 字符串猜。
    expect(typeof sdkEntry().CircuitBreakerOpenError).toBe('function');
    // 必须是同一个类（不是复制品），否则 catch 端 instanceof 永远为 false
    expect(sdkEntry().CircuitBreakerOpenError).toBe(httpClientModule().CircuitBreakerOpenError);
  });

  it('禁用态抛的是**有类型**的错误，而不是裸 Error', async () => {
    // 缺陷现场：requireEnabled() 抛 new Error(disabledReason)，与 python SDK 的
    // CallbackDisabledError 不对称——同一份任务代码在两包之间无法用同一个
    // catch 形态区分「配置错」，只能匹配英文文案。
    const disabled = new HttpClient(undefined, undefined);
    const err: unknown = await disabled.get('/x').catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // 1) 名字可判别（不依赖具体导出名）
    expect((err as Error).name).toBe('HttpClientDisabledError');
    // 2) 类型可从包入口取到并 instanceof
    expect(typeof sdkEntry().HttpClientDisabledError).toBe('function');
    expect(err).toBeInstanceOf(sdkEntry().HttpClientDisabledError);
    // 3) 既有面逐字节不变：消息仍是原文案、仍是 Error 子类
    expect((err as Error).message).toMatch(/HttpClient is disabled/);
  });
});

describe('R177-A1 轴2：回调通道重试豁免的路径判定', () => {
  it('带查询串的回调路径仍被认作回调通道', () => {
    // 缺陷现场：判定用 ^/api/executions/callback(?:/|?|$) 裸正则，
    // 任何 query string 都会让这条**唯一豁免非幂等重试**的谓词失配——
    // 终态回调退回「单发即抛」，一次抖动就丢终态（NETOPT-F P2-4 的初衷被绕过）。
    expect(isTerminalCallbackUrl('/api/executions/callback?batch=2', 'POST')).toBe(true);
  });

  it('绝对 URL 形式的回调路径同样被认作回调通道', () => {
    // 调用方传绝对 URL（自建 baseURL / 走网关）时，^/api 锚点直接失配。
    expect(
      isTerminalCallbackUrl('http://admin-api:3105/api/executions/callback', 'POST'),
    ).toBe(true);
  });

  it('兄弟路由与非 POST 仍然不放行（收紧边界不能被放宽）', () => {
    expect(isTerminalCallbackUrl('/api/executions/callback-extra', 'POST')).toBe(false);
    expect(isTerminalCallbackUrl('/api/executions/callback', 'GET')).toBe(false);
    expect(isTerminalCallbackUrl('/api/executions/callback/sub', 'POST')).toBe(false);
    expect(isTerminalCallbackUrl('/api/executions/callback', 'DELETE')).toBe(false);
  });

  it('带查询串的回调 POST 仍然自动盖章 executorAddress', async () => {
    const instance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    };
    mockedAxios.create.mockReturnValue(instance as any);
    instance.post.mockResolvedValue({ data: { results: [] } });

    const client = new HttpClient(
      'http://admin-api:3105',
      'v1.exec-1.1.deadbeef',
      undefined,
      'executor-node:8002',
    );
    await client.post('/api/executions/callback?batch=2', [
      { executionId: 'exec-1', status: 'success' },
    ]);

    const [, body] = instance.post.mock.calls[0];
    // 缺陷现场：withExecutorAddress 用 /\/executions\/callback\/?$/ 判定，
    // 查询串让它静默跳过盖章 → admin 侧该行无法归属到执行器（N27 失效）。
    expect((body as Array<Record<string, unknown>>)[0].executorAddress).toBe(
      'executor-node:8002',
    );
  });
});

describe('R191 终态回调的单次等待上限', () => {
  const retry = { maxWaitMs: 30_000 };

  it('回调通道封顶 5s', () => {
    expect(effectiveRetryMaxWaitMs('/api/executions/callback', 'POST', retry)).toBe(5_000);
    expect(effectiveRetryMaxWaitMs('/api/executions/callback?batch=2', 'POST', retry)).toBe(5_000);
  });

  it('回调通道不受更小上限影响（取更小者）', () => {
    expect(effectiveRetryMaxWaitMs('/api/executions/callback', 'POST', { maxWaitMs: 2_000 })).toBe(2_000);
  });

  it('其余路径沿用 maxWaitMs', () => {
    expect(effectiveRetryMaxWaitMs('/api/tasks', 'GET', retry)).toBe(30_000);
    expect(effectiveRetryMaxWaitMs('/api/executions/callback', 'GET', retry)).toBe(30_000);
  });
});
