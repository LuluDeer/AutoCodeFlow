import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';

/**
 * NETOPT-G P1-1（跨境链路韧性）：admin 出站请求的**共享 axios 实例**。
 *
 * ## 为什么单独成模块
 *
 * 修复前，执行器对 admin 有**两条独立的 axios 调用路径**：
 *   1. `admin-client.ts` 的共享实例（心跳 / pull / 回调 / failover）；
 *   2. `middleware/auth.ts::fetchToken` 的**模块级默认 axios**（`axios.post` 直调）
 *      ——这是执行器获取 per-executor 令牌的**唯一路径**。
 *
 * 两者此前都缺 `httpsAgent`。把 agent 修在 `admin-client.ts` 里**修不到**
 * auth.ts 那条（它不经过 admin-client），于是令牌获取仍走"每次冷 TLS 握手
 * 且零重试"的老路——而它一旦失败，所有依赖 token 的请求（心跳 / pull /
 * 回调）会**连带全部失败**，故障面比心跳本身更大。
 *
 * 抽到本模块的另一个理由：`auth.ts` 不能直接 import `admin-client.ts`——
 * 后者依赖前者的 `getCurrentToken`，会形成**循环依赖**（本仓此前已为同类
 * 问题把 startup-identity 拆出去过）。本模块**不依赖任何业务模块**，两侧
 * 各自引用即可，环不存在。
 *
 * ## 配置语义（三者的作用）
 *
 * 生产/桌面部署的 admin 地址是 `https://`（如 `https://redirct.yskj.cc.cd`）。
 * Node 的 http/https 是两个独立模块，axios 对 https 目标**只认 httpsAgent**，
 * `httpAgent` 被完全忽略——这正是修复前 `keepAlive/maxSockets` 对 TLS 连接
 * **从未生效**的原因，直接表现为两类高频告警（生产实测 108 + 211 次）：
 *   - `Client network socket disconnected before secure TLS connection was
 *     established`（握手阶段被链路/中间设备掐断）；
 *   - `socket hang up`（复用了一个对端已静默关闭的半开连接）。
 *
 *  - `keepAlive` + `keepAliveMsecs`：复用 TLS 会话，省掉每次握手的 RTT
 *    （跨境 RTT 高，握手成本被放大）；
 *  - `timeout`（socket 级空闲超时）：让**池中已死**的 socket 被及时淘汰，
 *    而不是在下次复用时才以 `socket hang up` 暴露——这是半开连接问题的
 *    根因修复，**仅靠请求级 timeout 无法解决**（请求发出前连接就已坏）；
 *  - `maxSockets`：与 http 侧同值，防长轮询（40s）+ 心跳 + 令牌 + 回调并发打满。
 *
 * 纯 `http://` 部署（容器内 `http://admin-api:3105`）仍走 `httpAgent`，
 * 两条路径互不影响。
 */
export const sharedHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

export const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  keepAliveMsecs: 10_000,
  // 池中 socket 的空闲上限：略高于最长请求（长轮询 40s），保证在飞请求不被
  // 误杀，同时让死连接在 45s 内被回收。
  timeout: 45_000,
});

/** 全局共享的 axios 实例（admin 出站统一入口）。 */
export const sharedAxios: AxiosInstance = axios.create({
  httpAgent: sharedHttpAgent,
  httpsAgent: sharedHttpsAgent,
});

/**
 * NETOPT-G P1-2：单次请求的**最少**尝试次数。
 *
 * 为什么是 3：跨境链路上单次瞬时故障（TLS 握手中断 / 半开 socket / 读超时）
 * 的观测概率约 4.5%（生产 80/1759 心跳），两次独立尝试后仍同时失败的概率
 * 降到 ~0.2%，足以把"偶发失败被记成离线"压到噪声级；再高则放大 admin-api
 * 侧的 5xx 压力（故障期重试风暴），3 是收敛与压力的折中。
 */
export const MIN_ATTEMPTS = 3;

/** 重试退避基数（与原实现一致）。 */
export const RETRY_BACKOFF_MS = 500;

/** 默认请求超时：20s（跨境链路长尾；原 10s 偏紧，生产有 37 次超时）。 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** 判定一个错误是否为"瞬时、可重试"的 5xx 服务端故障。 */
export function isTransientServerError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | undefined)?.response
    ?.status;
  return typeof status === 'number' && status >= 500 && status <= 599;
}

/** 判定一个错误是否携带 HTTP **应答**状态码（即非连接层故障）。 */
export function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { response?: { status?: number } } | undefined)?.response
    ?.status;
  return typeof status === 'number' ? status : undefined;
}
