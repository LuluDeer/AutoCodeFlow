#!/usr/bin/env node
/**
 * P1 运行时行为验证 —— Qwen 多模态接入的**真实执行**断言。
 *
 * 为什么不用 jest：本仓 admin-api 的 jest 配置（jest 30 + ts-jest 29）在
 * 当前环境整模块不可运行（`Must use import to load ES Module`），且这是
 * **既有问题**（未改动的 audit/task 模块同样失败）——不是本次改动引入。
 *
 * 本脚本改用「转译后直接实例化 AiService + mock axios」的方式跑真逻辑：
 * 它验证的是**行为**（请求体形状、安全守卫、fail-open），不是文本匹配。
 *
 * 用法: node scripts/qwen-runtime-check.mjs
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const apiDir = join(root, "apps/admin-api");
const require = createRequire(join(apiDir, "package.json"));

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ── 用 ts 编译器把 ai.service.ts 转成可 require 的 CJS ─────────────
// 关键：产物必须落在 **apps/admin-api 树内**，否则 require('@nestjs/common')
// 与相对 import（../../common/utils/safe-http.util）都解析不到——它们依赖
// 该目录下的 node_modules 与相对层级。故用 .qwen-check/<原相对路径> 的
// 临时子目录，跑完即清（脚本末尾 rmSync）。
const ts = require("typescript");
const scratch = join(apiDir, ".qwen-check");
mkdirSync(scratch, { recursive: true });

const transpiled = new Set();

/** 转译单个源文件到 .qwen-check 内（保持相对层级）。 */
function transpileOne(relPath) {
  const absSrc = join(apiDir, relPath);
  const src = readFileSync(absSrc, "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      emitDecoratorMetadata: false,
      esModuleInterop: true,
    },
    fileName: relPath,
  });
  const dest = join(scratch, relPath.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out.outputText);
  return src;
}

/**
 * 递归转译整个**本地** import 图。
 *
 * 为什么必须递归：ai.service → safe-http.util → config/env → …，任一环
 * 没转译都会在 require 时炸在 `.ts` 上（Node 不认 TS）。只挑几个文件
 * 手工转译是打地鼠；这里改成扫 import 语句自动展开。
 * 只跟随**相对路径** import（`./x` / `../x`）；裸模块名（@nestjs/*、axios）
 * 交给 apiDir 的 node_modules 正常解析，不转译。
 */
function transpileGraph(entryRel) {
  const queue = [entryRel];
  while (queue.length) {
    const rel = queue.shift();
    if (transpiled.has(rel)) continue;
    transpiled.add(rel);

    let src;
    try {
      src = transpileOne(rel);
    } catch {
      continue; // 非 .ts 或不存在 → 跳过（由 node_modules / 运行时兜底）
    }

    const importRe = /from\s+["'](\.[^"']+)["']/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      const relDir = dirname(rel);
      // 候选：显式 .ts，或目录下的 index.ts
      const base = join(relDir, spec).replace(/\\/g, "/");
      for (const cand of [`${base}.ts`, `${base}/index.ts`]) {
        if (transpiled.has(cand)) break;
        try {
          readFileSync(join(apiDir, cand));
          queue.push(cand);
          break;
        } catch {
          /* 不存在则试下一个 */
        }
      }
    }
  }
}

// 被测服务 + 其完整本地依赖图
let serviceMod;
try {
  transpileGraph("src/modules/ai/ai.service.ts");
  serviceMod = require(join(scratch, "src/modules/ai/ai.service.js"));
} catch (err) {
  console.error(`\n[FATAL] 转译/加载 ai.service.ts 失败: ${err.message}\n`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const { AiService } = serviceMod;

// ── 依赖桩 ────────────────────────────────────────────────────────
/** 造一个可控的 AiService 实例：DB 配置 + axios 全部 mock。 */
function makeService(values, { axiosPost } = {}) {
  const systemConfig = {
    findOne: async (key) =>
      key in values ? { value: values[key] } : null,
  };
  const config = {
    get: (key, dflt) => (key in values ? values[key] : dflt),
  };
  const svc = new AiService(config, systemConfig);

  // 注入 mock axios（模块级 import，用 require 缓存替换）
  const axiosMod = require(join(apiDir, "node_modules/axios"));
  svc._axios = axiosMod;
  return svc;
}

// 直接替换 axios 的 post（ai.service.ts 用 `axios.post`，取的是模块默认导出）
const axiosPath = require.resolve(join(apiDir, "node_modules/axios"));
const axiosReal = require(axiosPath);
let lastCall = null;
function mockAxios(response) {
  lastCall = null;
  axiosReal.post = async (url, body, cfg) => {
    lastCall = { url, body, cfg };
    if (response instanceof Error) throw response;
    return response;
  };
}

// ── DNS 固定 ──────────────────────────────────────────────────────
// 同 ai.service.spec.ts 的既有做法（V3 round-7）：本机若走 TUN/代理栈，DNS
// 会返回 198.18.0.0/15（该段在 SSRF 拒绝名单上）→ 被测的 assertAndPinHttpUrl
// 会直接拒绝出站，测试变成环境相关。
// 这里把 dns.lookup 钉到一个公网地址，让 SSRF 守卫走「通过」分支，
// 从而真正验证到请求体构造与 pin 注入。
const dnsPromises = require("node:dns/promises");
const originalLookup = dnsPromises.lookup;
dnsPromises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
// 同步版也被 safe-http.util 使用（dns.lookup callback 形式）
const dns = require("node:dns");
const originalSyncLookup = dns.lookup;
dns.lookup = (hostname, options, cb) => {
  const callback = typeof options === "function" ? options : cb;
  if (typeof callback === "function") {
    process.nextTick(() => callback(null, "93.184.216.34", 4));
    return undefined;
  }
  return originalSyncLookup(hostname, options, cb);
};

const QWEN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const baseValues = {
  "ai.provider": "qwen",
  "ai.qwenApiKey": "sk-test",
  "ai.qwenModel": "qwen-vl-max",
  "ai.qwenBaseUrl": QWEN_BASE,
  "ai.qwenMaxTokens": "4096",
  "ai.qwenTimeoutMs": "120000",
};

const okResp = (content, extra = {}) => ({
  data: { choices: [{ message: { content, ...extra } }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
});

console.log("\n=== P1 Qwen 运行时行为验证 ===\n");

// ── 1. fail-open ──────────────────────────────────────────────────
console.log("── fail-open（AI 不可用绝不影响主链）──");
{
  const svc = makeService({ ...baseValues, "ai.provider": "openai" });
  mockAxios(okResp("should not be called"));
  const res = await svc.chatMultimodal({ messages: [{ role: "user", content: "x" }] });
  check("provider=openai 时返回空结果", res.content === "");
  check("provider=openai 时不发出请求", lastCall === null);
}
{
  const svc = makeService({ ...baseValues, "ai.qwenApiKey": "" });
  mockAxios(okResp("nope"));
  const res = await svc.chatMultimodal({ messages: [{ role: "user", content: "x" }] });
  check("无 API key 时返回空结果", res.content === "");
  check("无 API key 时不发出请求", lastCall === null);
}

// ── 2. 请求体形状 ─────────────────────────────────────────────────
console.log("\n── 请求体形状 ──");
{
  const svc = makeService(baseValues);
  mockAxios(okResp("分析结果"));
  const res = await svc.chatMultimodal({ messages: [{ role: "user", content: "hello" }] });

  check("URL 为 DashScope 兼容端点 /chat/completions", lastCall.url === `${QWEN_BASE}/chat/completions`, lastCall.url);
  check("model 取自 ai.qwenModel", lastCall.body.model === "qwen-vl-max");
  check("Authorization 为 Bearer", lastCall.cfg.headers.Authorization === "Bearer sk-test");
  check("content 原样透传", JSON.stringify(lastCall.body.messages) === JSON.stringify([{ role: "user", content: "hello" }]));
  check("返回 content 正确", res.content === "分析结果");
  check("usage 映射正确", res.usage.tokensIn === 1 && res.usage.tokensOut === 2);
}
{
  const svc = makeService({ ...baseValues, "ai.qwenMaxTokens": "8192" });
  mockAxios(okResp(""));
  await svc.chatMultimodal({ messages: [{ role: "user", content: "x" }] });
  check("max_tokens 用 qwen 独立配置（8192）", lastCall.body.max_tokens === 8192);
  check("max_tokens 不是 openai 的 500", lastCall.body.max_tokens !== 500);
}
{
  const svc = makeService(baseValues);
  mockAxios(okResp(""));
  await svc.chatMultimodal({ messages: [{ role: "user", content: "x" }] });
  check("不传 tools 时请求体无 tools 键", !("tools" in lastCall.body));
  check("不传 tools 时请求体无 tool_choice 键", !("tool_choice" in lastCall.body));
}

// ── 3. 多模态 / 视频 ──────────────────────────────────────────────
console.log("\n── 多模态与视频理解 ──");
{
  const svc = makeService(baseValues);
  mockAxios(okResp("ok"));
  await svc.chatMultimodal({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "https://cdn.example.com/a.png" } },
      ],
    }],
  });
  const parts = lastCall.body.messages[0].content;
  check("content 为数组", Array.isArray(parts));
  check("含 image_url 片段", parts[1].type === "image_url");
}
{
  const svc = makeService(baseValues);
  mockAxios(okResp("看懂了"));
  const res = await svc.chatMultimodal({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "分析录屏" },
        { type: "video_url", video_url: { url: "https://cdn.example.com/r.mp4" } },
      ],
    }],
  });
  check("接受 video_url 扩展", lastCall.body.messages[0].content[1].video_url.url.endsWith(".mp4"));
  check("视频分析结果返回", res.content === "看懂了");
}

// ── 4. 安全 ───────────────────────────────────────────────────────
console.log("\n── 安全姿态 ──");
{
  const svc = makeService(baseValues);
  mockAxios(okResp("x"));
  let threw = null;
  try {
    await svc.chatMultimodal({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///etc/passwd" } }] }],
    });
  } catch (e) { threw = e; }
  check("拒绝 file:// 媒体 URL", threw !== null && /non-http\(s\) media URL/.test(threw.message), threw?.message);
  check("拒绝后未发出请求", lastCall === null);
}
{
  const svc = makeService(baseValues);
  mockAxios(okResp("x"));
  await svc.chatMultimodal({ messages: [{ role: "user", content: "x" }] });
  check("maxRedirects=0（拒 3xx 绕过 SSRF 校验）", lastCall.cfg.maxRedirects === 0);
  check("timeout 用 ai.qwenTimeoutMs", lastCall.cfg.timeout === 120000);
  const hasPin = lastCall.cfg.httpAgent !== undefined || lastCall.cfg.httpsAgent !== undefined;
  check("注入了 DNS pin agent（pinnedAxiosConfig）", hasPin);
}

// ── 5. tool-calling ───────────────────────────────────────────────
console.log("\n── tool-calling（P3 Agent 循环的前置）──");
{
  const svc = makeService(baseValues);
  mockAxios(okResp("", {
    tool_calls: [{ id: "call_1", type: "function", function: { name: "list_tasks", arguments: '{"page":1}' } }],
  }));
  const res = await svc.chatMultimodal({
    messages: [{ role: "user", content: "列任务" }],
    tools: [{ type: "function", function: { name: "list_tasks", description: "d", parameters: { type: "object" } } }],
  });
  check("tools 下发到请求体", Array.isArray(lastCall.body.tools) && lastCall.body.tools.length === 1);
  check("tool_choice 默认 auto", lastCall.body.tool_choice === "auto");
  check("tool_calls 回传", res.toolCalls?.[0]?.function?.name === "list_tasks");
}

// ── 6. hasApiKeyForProvider ───────────────────────────────────────
console.log("\n── 密钥就绪判定（修既有硬编码 bug）──");
{
  const svc = makeService({ "ai.provider": "qwen", "ai.qwenApiKey": "sk-a" });
  check("qwen + DB 有 key → true", (await svc.hasApiKeyForProvider()) === true);
}
{
  const svc = makeService({ "ai.provider": "qwen", "ai.qwenApiKey": "sk-from-env" });
  // DB 无值（values 只含 env 兜底路径由 config.get 提供）
  svc.systemConfig = { findOne: async (k) => (k === "ai.provider" ? { value: "qwen" } : null) };
  check("qwen + env 有 key → true", (await svc.hasApiKeyForProvider()) === true);
}
{
  const svc = makeService({ "ai.provider": "disabled" });
  check("provider=disabled → false", (await svc.hasApiKeyForProvider()) === false);
}
{
  const svc = makeService({ "ai.provider": "ollama" });
  check("provider=ollama → false（无需密钥）", (await svc.hasApiKeyForProvider()) === false);
}

// ── 7. getEffectiveConfig ─────────────────────────────────────────
console.log("\n── 生效配置读取 ──");
{
  const svc = makeService(baseValues);
  const cfg = await svc.getEffectiveConfig();
  check("含 qwenModel", cfg.qwenModel === "qwen-vl-max");
  check("含 qwenBaseUrl", String(cfg.qwenBaseUrl).includes("dashscope.aliyuncs.com"));
  check("含 qwenMaxTokens", cfg.qwenMaxTokens === "4096");
  check("密钥不在生效配置中（永不回显）", !JSON.stringify(cfg).includes("sk-test"));
}

// ── 8. 回归：既有 provider 未被影响 ───────────────────────────────
console.log("\n── 回归：既有 provider 路径 ──");
{
  const svc = makeService({
    "ai.provider": "openai",
    "ai.openaiApiKey": "sk-openai",
    "ai.openaiModel": "gpt-4o-mini",
    "ai.openaiBaseUrl": "https://api.openai.com/v1",
  });
  mockAxios(okResp("旧路径结果"));
  const res = await svc.analyzeFailure({ name: "t", runtime: "node" }, "Error: boom");
  check("openai 失败分析仍可用", res === "旧路径结果");
  check("openai 仍用 /chat/completions", lastCall.url === "https://api.openai.com/v1/chat/completions");
  check("openai 的 max_tokens 仍是 500（未被 qwen 污染）", lastCall.body.max_tokens === 500);
}

rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n=== ${failures} 项失败 ===\n` : "\n=== 全部运行时断言通过 ===\n");
process.exit(failures ? 1 : 0);
