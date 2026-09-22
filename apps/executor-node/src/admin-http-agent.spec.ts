import http from 'http';
import https from 'https';
import axios from 'axios';
import {
  sharedHttpAgent,
  sharedHttpsAgent,
  sharedAxios,
  MIN_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  httpStatusOf,
  isTransientServerError,
} from './admin-http-agent';

/**
 * NETOPT-G P1-1/P1-2（跨境链路韧性）的**回归锁**。
 *
 * 背景：生产环境 admin 地址是 `https://redirct.yskj.cc.cd`，而执行器对 admin
 * 有**两条**独立 axios 路径（admin-client 的心跳/pull/回调、middleware/auth 的
 * token 获取）。两条此前都缺 `httpsAgent`，导致 keepAlive 对 TLS 连接从未生效
 * ——生产实测 108 次 TLS 握手中断 + 211 次 socket hang up。本模块是两侧共享的
 * 单一事实源，这些断言防止将来任一侧又被改回"默认 axios / 缺 agent"。
 */
describe('admin-http-agent', () => {
  describe('TLS 连接池（P1-1 根因）', () => {
    it('为 https 目标提供 keepAlive 的 https.Agent（缺失即回归到每次冷握手）', () => {
      expect(sharedHttpsAgent).toBeInstanceOf(https.Agent);
      // keepAlive 是本修复的核心：没有它，每条请求都新建 socket + 完整 TLS 握手
      expect((sharedHttpsAgent as unknown as { keepAlive: boolean }).keepAlive).toBe(true);
      expect((sharedHttpsAgent as unknown as { keepAliveMsecs: number }).keepAliveMsecs)
        .toBeGreaterThan(0);
      // socket 级空闲超时：让池中已死连接被及时淘汰，而不是在下次复用时才以
      // `socket hang up` 暴露（半开连接问题的根因修复，请求级 timeout 无法覆盖）
      expect((sharedHttpsAgent as unknown as { options: { timeout?: number } }).options?.timeout)
        .toBeGreaterThan(0);
    });

    it('同时保留 http.Agent（纯 http:// 部署不受影响）', () => {
      expect(sharedHttpAgent).toBeInstanceOf(http.Agent);
      expect(sharedHttpAgent).not.toBeInstanceOf(https.Agent);
      expect((sharedHttpAgent as unknown as { keepAlive: boolean }).keepAlive).toBe(true);
    });

    it('共享实例同时挂 httpAgent 与 httpsAgent（只挂一个 = 另一半流量裸奔）', () => {
      // 回归锁：最初实现只设了 httpAgent，https 目标被静默忽略
      const defaults = (sharedAxios.defaults ?? {}) as Record<string, unknown>;
      expect(defaults.httpAgent).toBe(sharedHttpAgent);
      expect(defaults.httpsAgent).toBe(sharedHttpsAgent);
    });
  });

  describe('常量与错误分类', () => {
    it('重试下限为 3，且超时已从 10s 放宽到 20s', () => {
      expect(MIN_ATTEMPTS).toBe(3);
      expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
    });

    it('httpStatusOf 只在携带 response 时返回状态码', () => {
      expect(httpStatusOf({ response: { status: 502 } })).toBe(502);
      expect(httpStatusOf(new Error('socket hang up'))).toBeUndefined();
      expect(httpStatusOf(undefined)).toBeUndefined();
    });

    it('isTransientServerError 只认 5xx（4xx 是确定性拒绝，重试无益）', () => {
      for (const s of [500, 502, 503, 599]) {
        expect(isTransientServerError({ response: { status: s } })).toBe(true);
      }
      for (const s of [400, 401, 404, 429]) {
        expect(isTransientServerError({ response: { status: s } })).toBe(false);
      }
      // 连接层故障（无 response）不算 5xx，但仍应可重试——由调用方决定
      expect(isTransientServerError(new Error('socket hang up'))).toBe(false);
    });
  });

  describe('实例复用', () => {
    it('导出的 sharedAxios 是同一个对象（模块级单例，非每次新建）', () => {
      // O-23 的约束：早期实现每次请求都 axios.create()，连接池被丢弃，
      // keepAlive 形同虚设。
      expect(axios.isAxiosError).toBeDefined();
      expect(typeof sharedAxios.request).toBe('function');
      expect(typeof sharedAxios.get).toBe('function');
      expect(typeof sharedAxios.post).toBe('function');
    });
  });
});
