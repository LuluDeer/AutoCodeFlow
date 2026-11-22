/**
 * 内网巡检示例（node runtime）
 *
 * 场景：批量探测多个内网目标（TCP 连通性）→ 汇总每个目标的存活状态 →
 *       把汇总结果通过 HTTP POST 回调给结果汇总系统；凭据用占位符，
 *       真实环境从 secrets（按原名注入 env）读取令牌。
 *
 * 「批量探测 + 结果汇总回调」类任务的骨架：把 probeTcp 换成真实探测逻辑
 * （HTTP 健康检查、SNMP、端口扫描等），把 callbackUrl 换成你的汇总端点即可。
 *
 * 运行参数（执行器注入 AUTOFLOW_<KEY> 环境变量）：
 *   targets     : JSON 数组字符串，元素为 "host:port"（AUTOFLOW_TARGETS_JSON 可读原始 JSON）
 *   timeoutMs   : 单个目标探测超时毫秒，默认 1000
 *   callbackUrl : 汇总结果回调地址（示例默认用 httpbin 演示，不实际外发）
 *   INTRANET_SCAN_TOKEN : 巡检系统令牌（secrets 按原名注入 env，示例不实际使用）
 *
 * 结果查看：acf task trigger <taskId> --wait 看终态，
 *           acf task logs <execId> 看 "RESULT" 行里的汇总。
 */
const net = require("node:net");

function rawParam(name) {
  // jsonb / 数组类参数在 AUTOFLOW_PARAMS_JSON 里是原始 JSON；裸值在 AUTOFLOW_<KEY>。
  return process.env[`AUTOFLOW_${name}`];
}

function parseTargets() {
  const raw = rawParam("TARGETS");
  if (!raw) return ["HOST_A:PORT_A", "HOST_B:PORT_B"];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [raw];
  } catch {
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  }
}

/** 单目标 TCP 连通性探测；true=可连接，false=不可达/超时。 */
function probeTcp(target, timeoutMs) {
  return new Promise((resolve) => {
    const [host, portRaw] = String(target).split(":");
    const port = Number(portRaw);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      resolve({ target, alive: false, error: "invalid host:port" });
      return;
    }
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ target, alive: true }));
    socket.once("timeout", () => finish({ target, alive: false, error: "timeout" }));
    socket.once("error", (err) => finish({ target, alive: false, error: err.code || err.message }));
    socket.connect(port, host);
  });
}

/**
 * 结果汇总回调：示例只打印待上报的 payload（占位 URL 不实际外发）。
 * 真实场景把这里换成 fetch(callbackUrl, { method:'POST', body }) 即可，
 * 请求头带 Authorization: Bearer <INTRANET_SCAN_TOKEN>。
 */
function reportSummary(callbackUrl, summary) {
  console.log(`[intranet-inspection] callback -> ${callbackUrl}`);
  console.log(`[intranet-inspection] payload ${JSON.stringify(summary)}`);
}

async function main() {
  const targets = parseTargets();
  const timeoutMs = Number(rawParam("TIMEOUTMS") || "1000");
  const callbackUrl = rawParam("CALLBACKURL") || "https://callback.example.com/intranet-inspection";
  console.log(`[intranet-inspection] start targets=${targets.length}`);

  const results = await Promise.all(targets.map((t) => probeTcp(t, timeoutMs)));
  const summary = {
    success: true,
    total: results.length,
    alive: results.filter((r) => r.alive).length,
    unreachable: results.filter((r) => !r.alive).length,
    results,
  };
  reportSummary(callbackUrl, summary);
  console.log("RESULT " + JSON.stringify(summary));
  return summary;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[intranet-inspection][ALARM] inspection failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, probeTcp, parseTargets };
