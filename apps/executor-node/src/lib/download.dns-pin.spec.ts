/**
 * R74-A1（安全面四轴审计·轴 1）：下载链的 **resolve-then-connect TOCTOU**。
 *
 * ssrf-guard 的 DNS 闸只证明「此刻解析出的地址都安全」，而 http.get 在真正
 * 建连时会**再解析一次**——攻击者控制的域名可以把 TTL 压到 0，第一次返回公网
 * IP 过闸、第二次返回 127.0.0.1/169.254.169.254（DNS rebinding）。
 *
 * 修法：闸把「已校验的地址表」交回 download，download 用 http.request 的
 * `lookup` 选项在建连时**只从这张表里取地址**，连接期不再触发 DNS。本文件
 * 是那次修复的红样本：旧实现的 options 里没有 lookup，连接期重新解析。
 *
 * 注意：config.allowPrivateNetwork 必须为 false（否则闸直接逃生、不做解析）；
 * 同时必须用 require('http') 拿模块对象——ts-jest 的 import * 会做命名空间
 * 拷贝，spy 打在拷贝上不影响 download 内部的 require('http')。
 */
jest.mock('../config', () => ({
  config: { token: 'test-shared-token', allowPrivateNetwork: false },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dns from 'node:dns';
import { EventEmitter } from 'node:events';

 
const nodeHttp = require('http') as typeof import('http');

import { downloadFile } from './download';

interface Captured {
  url: string;
  options: Record<string, unknown>;
}

function tempDest(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acf-pin-')), 'pkg.bin');
}

/** 最小 ClientRequest 桩：download 只用到 on/setTimeout/destroy。 */
function fakeRequest(): unknown {
  return {
    on: () => undefined,
    setTimeout: () => undefined,
    destroy: () => undefined,
  };
}

/** 302 响应桩：download 只读 statusCode/headers，再 resume() 掉 body。 */
function redirectResponse(location: string): unknown {
  const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
  res.statusCode = 302;
  res.headers = { location };
  res.resume = () => undefined;
  return res;
}

describe('downloadFile — DNS rebinding TOCTOU 钉扎（R74-A1 轴 1）', () => {
  let dnsSpy: jest.SpyInstance;
  let getSpy: jest.SpyInstance;
  let captured: Captured[];

  beforeEach(() => {
    captured = [];
    dnsSpy = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as never);
  });

  afterEach(() => {
    dnsSpy.mockRestore();
    getSpy?.mockRestore();
  });

  it('建连时把 DNS 解析钉扎到已校验的地址表，连接期不再解析（rebinding 无从发生）', async () => {
    getSpy = jest.spyOn(nodeHttp, 'get').mockImplementation(((url: string, options: Record<string, unknown>) => {
      captured.push({ url, options });
      return fakeRequest();
    }) as never);
    const dest = tempDest();
    try {
      // 200ms 整体 deadline 保证 promise 一定会 settle（无真实网络）。
      await expect(
        downloadFile('http://pin.example.com/pkg.zip', dest, { timeoutMs: 200 }),
      ).rejects.toThrow(/下载超时/);

      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe('http://pin.example.com/pkg.zip');
      const lookup = captured[0].options.lookup;
      expect(typeof lookup).toBe('function');

      // 连接层回调（net/tls 传 hostname + dns 选项）必须答出闸校验过的那个 IP。
      const resolved = await new Promise<unknown>((resolve, reject) => {
        (lookup as Function)('pin.example.com', { family: 0, hints: 32 }, (err: unknown, address: unknown) => {
          if (err) reject(err);
          else resolve(address);
        });
      });
      expect(resolved).toBe('93.184.216.34');

      // 关键断言：连接期没有第二次 DNS 查询（第一次也是唯一一次在闸里）。
      expect(dnsSpy).toHaveBeenCalledTimes(1);
      expect(dnsSpy).toHaveBeenCalledWith('pin.example.com', { all: true, verbatim: true });
    } finally {
      fs.rmSync(path.dirname(dest), { recursive: true, force: true });
    }
  });

  it('重定向的每一跳都各自过闸并各自钉扎（不是只钉首跳）', async () => {
    getSpy = jest.spyOn(nodeHttp, 'get').mockImplementation(((url: string, options: Record<string, unknown>, cb?: Function) => {
      captured.push({ url, options });
      if (captured.length === 1) {
        // 首跳立刻 302 到另一个域名
        cb?.(redirectResponse('http://hop2.example.com/final.zip'));
      }
      return fakeRequest();
    }) as never);
    const dest = tempDest();
    try {
      await expect(
        downloadFile('http://hop1.example.com/pkg.zip', dest, { timeoutMs: 300 }),
      ).rejects.toThrow(/下载超时/);

      expect(captured.map((c) => c.url)).toEqual([
        'http://hop1.example.com/pkg.zip',
        'http://hop2.example.com/final.zip',
      ]);
      for (const hop of captured) {
        expect(typeof hop.options.lookup).toBe('function');
      }
      // 两跳各解析一次，且解析的主机名不同 —— 证明钉扎是「逐跳」而非复用首跳结果。
      expect(dnsSpy).toHaveBeenCalledTimes(2);
      expect(dnsSpy.mock.calls.map((c) => c[0])).toEqual(['hop1.example.com', 'hop2.example.com']);
    } finally {
      fs.rmSync(path.dirname(dest), { recursive: true, force: true });
    }
  });
});
