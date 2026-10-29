#!/usr/bin/env node
/**
 * 回调面 per-IP 硬顶的**真机**演练（F1，2026-10-27 审计轮 #7 落地 / 轮 #11 验证）。
 *
 * ## 为什么需要它（单测覆盖不到的那一半）
 *
 * `ip-ceiling.middleware.spec.ts` 已经证明「滑动窗口计数正确」与「换头换不到新桶」，
 * 但那是在**假 express 对象**上跑纯逻辑。真正要证明的是：把它挂进**真 Nest 应用**、
 * 挂在 55MB body parser **之前**、在真 HTTP 栈上，行为是否仍然成立。这三件事里
 * 任何一件错位都不会让单测变红——顺序写反、中间件没注册、路径前缀不匹配，全都
 * 表现为"测试全绿但线上没有防护"。
 *
 * ## 判据（每条都对应一个具体失效形态）
 *
 *   ① 回调面在额度内返回**非 429**（证明中间件没有把正常流量打死）；
 *   ② 连续超限后返回 **429 + Retry-After**（证明闸门真的在拦）；
 *   ③ 超限时**每次换一个 x-executor-address** 仍然 429（**这就是原缺陷的绕过形态**：
 *      分桶键来自客户端可设的头，换头即换桶，聚合速率无上限）；
 *   ④ 不带该头的回调同样受限（证明桶键与头无关）；
 *   ⑤ 同一 IP 的**其它路由不受影响**（证明没有误伤登录/健康检查）。
 *
 * ## 用法
 *
 *   BASE_URL=http://127.0.0.1:3199 CALLBACK_IP_CEILING_PER_MINUTE=5 \
 *     node scripts/ip-ceiling-live-drill.mjs
 *
 * 前置：一个**以该额度启动**的 admin-api（脚本会先读 /api/health/live 确认可达）。
 * 脚本刻意不启动服务、不连数据库——它只验证"已经跑起来的那个实例"。
 * 因为需要真栈，本脚本**不进** test:guards（与 e2e-full.sh 同待遇）。
 */
import process from "node:process";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3105").replace(/\/+$/, "");
const LIMIT = Number(process.env.CALLBACK_IP_CEILING_PER_MINUTE || "12000");
const CALLBACK = BASE_URL + "/api/executions/callback";

let failures = 0;
const pass = (m) => console.log("  ✔ " + m);
const fail = (m) => {
  failures += 1;
  console.error("  ✘ " + m);
};

async function post(url, headers) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "[]",
  });
  // 读完 body 释放连接（否则 keep-alive 连接会挂住脚本）
  await res.text().catch(() => "");
  return res;
}

async function main() {
  console.log("回调面 per-IP 硬顶真机演练");
  console.log("  target: " + CALLBACK);
  console.log("  额度:   " + LIMIT + "/min（须与服务端启动时一致）");

  // 前置：服务可达
  const live = await fetch(BASE_URL + "/api/health/live").catch(() => null);
  if (!live || !live.ok) {
    console.error(
      "✘ 目标不可达：" + BASE_URL + "/api/health/live —— 先启动一个 admin-api 再跑本脚本",
    );
    process.exit(2);
  }
  pass("前置：admin-api 可达");

  // 前置 ②：目标是否是**带 F1 的构建**。判据用一条不会误伤的真实请求——
  // 若服务端连 429 的语义都没有（旧构建），跑满额度只会浪费时间并给出误导性结论。
  // 这里用「额度 + 2」次探测的**结果分布**判断：一次 429 都没有 ⇒ 直接判"旧构建/未接线"。
  // （不做版本端点探测：那要给生产加面，不划算。）

  // ① 额度内不拦（前 limit-1 次必须是"非 429"）
  let firstBlockedAt = -1;
  for (let i = 1; i <= LIMIT + 2; i++) {
    const res = await post(CALLBACK, {
      // ③ 的形态：每次换一个全新的地址值——若分桶按头走，这里永远不会 429
      "x-executor-address": "drill-host-" + i + ":8002",
      Authorization: "Bearer drill-token-" + i,
    });
    if (res.status === 429) {
      firstBlockedAt = i;
      break;
    }
  }
  if (firstBlockedAt === -1) {
    fail(
      "跑了 " +
        (LIMIT + 2) +
        " 次仍未触发 429 —— 硬顶没生效。三种可能，按概率排序：" +
        "① 目标跑的是**旧构建**（镜像/产物早于 F1 落地，最常见：demo 栈就是这种情况）；" +
        "② 服务端 CALLBACK_IP_CEILING_PER_MINUTE 比脚本传的额度大；" +
        "③ 中间件没注册（接线被改掉了）。先确认 ①：重启目标实例再跑。",
    );
  } else if (firstBlockedAt <= LIMIT) {
    fail("第 " + firstBlockedAt + " 次就被拦，早于额度 " + LIMIT + "（额度算错了）");
  } else {
    pass("额度内放行、超出后触发 429（第 " + firstBlockedAt + " 次）");
    pass("③ 换 x-executor-address 仍被拦（原缺陷的绕过形态已关闭）");
  }

  // ② 429 必须带 Retry-After
  const blocked = await post(CALLBACK, {
    "x-executor-address": "drill-final:1",
    Authorization: "Bearer drill-final",
  });
  if (blocked.status !== 429) {
    fail("已超限但未返回 429（实际 " + blocked.status + "）");
  } else {
    const ra = blocked.headers.get("retry-after");
    if (ra && Number(ra) > 0) pass("429 携带 Retry-After=" + ra);
    else fail("429 缺 Retry-After（客户端无法判断何时重试）");
  }

  // ④ 不带该头 → 同一个 IP 桶，同样受限
  const noHeader = await post(CALLBACK, {});
  if (noHeader.status === 429) pass("④ 不带 x-executor-address 同样受限（桶键与头无关）");
  else fail("不带头的回调未被限流（" + noHeader.status + "）——桶键可能仍依赖该头");

  // ⑤ 其它路由不受影响（同 IP 不同路径）
  const other = await fetch(BASE_URL + "/api/health/live");
  if (other.status === 200) pass("⑤ 同 IP 的其它路由不受影响（health/live=200）");
  else fail("其它路由被误伤（health/live=" + other.status + "）");

  console.log(failures === 0 ? "\n✔ 真机演练全部通过" : "\n✘ 真机演练失败 " + failures + " 项");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("drill crashed:", e);
  process.exit(2);
});
