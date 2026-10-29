#!/usr/bin/env node
/**
 * P1 (agent-and-deployment) 结构自检 —— Qwen 多模态接入
 *
 * 为什么是「结构断言」而不是纯单测：本仓 admin-api 的 jest 在部分环境下
 * 因 ESM/CJS 互操作（@nestjs/core 的 require(esm)）整模块不可运行——这是
 * **既有环境问题**（未改动的 audit/task 模块同样失败），不是本次改动引入。
 * 因此本脚本走「读源码 + 断言关键实现点与安全姿态」的路线：它不能替代
 * 真实单测，但能可靠拦住「实现被误删/被绕过」这类回归。
 *
 * 用法: node scripts/ai-qwen-structural-check.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function read(p) {
  return readFileSync(join(root, p), "utf8");
}

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✘ ${name}`);
  }
}

// ── ai.service.ts ──────────────────────────────────────────────────
console.log("\n── ai.service.ts ──");
const svc = read("apps/admin-api/src/modules/ai/ai.service.ts");
// 推理质量轮：provider 注册表与路由解析是新的两个纯函数模块，AI 能力面
// 的结构断言现在有一半落在这里。
const providers = read("apps/admin-api/src/modules/ai/ai-providers.ts");
const route = read("apps/admin-api/src/modules/ai/ai-route.ts");

check("chatMultimodal 存在（多模态路径）", /async chatMultimodal\(/.test(svc));
check("chatMultimodalStream 存在（流式路径）", /async chatMultimodalStream\(/.test(svc));

// 推理质量轮（2026-10-28）架构变更：**厂商分支已删除**，改为「注册表 + 按用途
// 路由」。原断言锁的是 `provider === "qwen"` 这类硬编码分支——那正是本轮要消灭
// 的形态，锁它等于把缺陷钉死。改为锁新架构的三条不变量：
//   ① 出站只有一个 OpenAI 兼容实现（callCompatible），没有每厂商一套；
//   ② 路由解析集中在 ai-route.ts（纯函数），ai.service 只调用不自己判能力；
//   ③ 能力闸（视频 / tool-calling）在路由层如实拒绝，不在调用点静默降级。
check(
  "出站 OpenAI 兼容面收敛为单一实现（无每厂商一套调用体）",
  !/provider === "qwen"/.test(svc) &&
    !/private async callQwenText/.test(svc) &&
    /private async callCompatible\(/.test(svc),
);
check(
  "路由解析委托 ai-route（能力闸不在调用点手写）",
  /resolveAiRoute\(/.test(svc) && /from "\.\/ai-route"/.test(svc),
);
check(
  "按用途路由（analysis / agent / video）",
  /AiPurpose/.test(svc) && /routeFor\(/.test(svc),
);

// fail-open：路由不可用 / 无密钥 / 能力不符时返回空响应，绝不抛错影响主链
check(
  "fail-open：路由不可用（未启用/无密钥/能力不符）返回空结果",
  /resolved\.status === "error"[\s\S]{0,400}?return emptyResponse\(\)/.test(svc),
);
check(
  "fail-open：非 OpenAI 兼容面返回空结果（不静默降级）",
  /route\.transport !== "openai"[\s\S]{0,400}?return emptyResponse\(\)/.test(svc),
);

// 安全姿态必须与既有分支一致（不新开旁路）
check(
  "安全：保留 assertAndPinHttpUrl（SSRF + DNS pin）",
  /assertAndPinHttpUrl\(route\.baseUrl/.test(svc),
);
check("安全：保留 pinnedAxiosConfig", /pinnedAxiosConfig\(pinned\)/.test(svc));
check(
  "安全：保留 maxRedirects: 0（拒 3xx 绕过）",
  /maxRedirects:\s*0/.test(svc),
);
check("安全：媒体 URL 协议白名单校验", /MEDIA_URL_RE/.test(svc));
check(
  "安全：媒体 URL 校验被调用（不可只定义不调用）",
  /this\.validateMediaUrls\(req\.messages\)/.test(svc),
);

// 令牌上限：分析档（省成本 500）与多模态/Agent 档必须**分属不同来源**，
// 不能共用一个数。推理质量轮后由路由分配（`ai.routes.<用途>.maxTokens` →
// provider 条目缺省），请求体仍用变量下发而非字面量。
check(
  "max_tokens 由路由分配下发（不共享单一硬编码）",
  /max_tokens:\s*req\.maxTokens \?\? route\.maxTokens/.test(svc),
);
// F-6 不变量（零行为漂移）：openai 条目缺省仍是 500 —— 它现在住在注册表的
// LEGACY_DEFAULTS 里，故断言改到 ai-providers.ts（默认值语义不变）。
check(
  "既有 openai 分析档 max_tokens 默认值仍为 500（F-6 零行为漂移）",
  /openai: \{[\s\S]{0,400}?maxTokens: 500,/.test(providers),
);

// tool-calling（P3 的 Agent 循环依赖它）
check("支持 tools（function calling）", /body\.tools = req\.tools/.test(svc));

// 多模态契约
check("定义 MultimodalPart 类型", /export type MultimodalPart/.test(svc));
check("定义 video_url 扩展", /type:\s*"video_url"/.test(svc));
check(
  "标注 video_url 为 Qwen 扩展（不可移植到 openai）",
  /Qwen\/DashScope 的扩展/.test(svc),
);

// 密钥就绪判定（修既有 hasApiKey 硬编码 openai 的 bug）
check("hasApiKeyForProvider 按 provider 判定", /async hasApiKeyForProvider/.test(svc));

// ── ai-providers.ts / ai-route.ts（推理质量轮新增的两个纯函数模块）──
console.log("\n── 注册表与路由 ──");
check(
  "注册表 id 形态闸存在（id 会进配置键名）",
  /const ID_RE = \/\^\[a-z0-9\]/.test(providers),
);
check(
  "存量兼容：未配置时用旧键合成内置条目",
  /export function legacyProviders/.test(providers) &&
    /fromJson \? parsed\.entries : legacyEntries/.test(svc),
);
check(
  "密钥与条目分离（密钥单独存 providers.<id>.apiKey）",
  /providers\.\$\{entry\.id\}\.apiKey/.test(svc) &&
  // 条目本身不携带密钥字段
  !/apiKey\s*:\s*string;/.test(
    providers.slice(
      providers.indexOf("export interface AiProviderEntry"),
      providers.indexOf("export interface AiProviderView"),
    ),
  ),
);
check(
  "能力闸：视频用途必须 supportsVideo（不静默降级）",
  /purpose === "video" && !entry\.supportsVideo/.test(route),
);
check(
  "能力闸：Agent 拒绝 ollama（无 tool-calling 面）",
  /purpose === "agent" && entry\.transport !== "openai"/.test(route),
);
check(
  "Agent 输出/超时下限不继承分析档",
  /AGENT_MIN_OUTPUT_TOKENS/.test(route) && /AGENT_MIN_TIMEOUT_MS/.test(route),
);
check(
  "温度只在显式配置时下发",
  /route\.temperature !== undefined\) body\.temperature/.test(svc),
);

// ── ai.controller.ts ───────────────────────────────────────────────
console.log("\n── ai.controller.ts ──");
const ctrl = read("apps/admin-api/src/modules/ai/ai.controller.ts");

check(
  "DTO provider 枚举含 qwen",
  /@IsIn\(\["disabled", "openai", "ollama", "qwen"\]\)/.test(ctrl),
);
check("DTO 含 qwenApiKey", /qwenApiKey\?:/.test(ctrl));
check("DTO 含 qwenModel/BaseUrl", /qwenModel\?:/.test(ctrl) && /qwenBaseUrl\?:/.test(ctrl));
check("保存 ai.qwenModel 配置键", /key: "ai\.qwenModel"/.test(ctrl));
check("保存 ai.qwenBaseUrl 配置键", /key: "ai\.qwenBaseUrl"/.test(ctrl));
check(
  "qwen 密钥仅在传非空值时更新（与 openai 同语义）",
  /dto\.qwenApiKey && dto\.qwenApiKey\.trim\(\) !== ""/.test(ctrl),
);
check(
  "qwen 密钥以 isSecret 落库",
  /key: "ai\.qwenApiKey"[\s\S]{0,120}?isSecret: true/.test(ctrl),
);
check(
  "getConfig 不再硬编码查 openaiApiKey（修 bug）",
  !/findOne\("ai\.openaiApiKey"\)/.test(ctrl),
);
check(
  "getConfig 改用 hasApiKeyForProvider",
  /hasApiKeyForProvider\(\)/.test(ctrl),
);

// ── configuration.ts / app.module.ts ───────────────────────────────
console.log("\n── 配置层 ──");
const cfg = read("apps/admin-api/src/config/configuration.ts");
const mod = read("apps/admin-api/src/app.module.ts");

check("configuration.ts 映射 qwenApiKey", /qwenApiKey:/.test(cfg));
check("configuration.ts 映射 qwenBaseUrl", /qwenBaseUrl:/.test(cfg));
check("configuration.ts 映射 qwenModel", /qwenModel:/.test(cfg));
check("configuration.ts 映射 qwenMaxTokens", /qwenMaxTokens:/.test(cfg));
check("configuration.ts 映射 qwenTimeoutMs", /qwenTimeoutMs:/.test(cfg));
check(
  "configuration.ts 默认端点为 DashScope 兼容模式",
  /dashscope\.aliyuncs\.com\/compatible-mode\/v1/.test(cfg),
);

check(
  "Joi AI_PROVIDER 注册 qwen（ARCH-27 配置收口纪律）",
  /valid\("disabled", "openai", "ollama", "qwen"\)/.test(mod),
);
check("Joi 注册 QWEN_API_KEY", /QWEN_API_KEY:/.test(mod));
check("Joi 注册 QWEN_BASE_URL", /QWEN_BASE_URL:/.test(mod));
check("Joi 注册 QWEN_MODEL", /QWEN_MODEL:/.test(mod));
check("Joi 注册 QWEN_MAX_TOKENS", /QWEN_MAX_TOKENS:/.test(mod));
check("Joi 注册 QWEN_TIMEOUT_MS", /QWEN_TIMEOUT_MS:/.test(mod));

// ── 回归：既有 provider 路径零行为漂移 ─────────────────────────────
// 推理质量轮把「每个厂商一个方法体」换成「一个 OpenAI 兼容实现 + 一个 ollama
// 实现」。原断言（`if (provider === "openai") return callOpenAI`）锁的是被删掉
// 的分支形态；这里改锁**等价的行为不变量**——两条协议面都还在、都由同一个
// 出站实现承载、且 ollama 仍走它自己的 /api/generate。
console.log("\n── 回归：既有 provider 行为零漂移 ──");
check(
  "OpenAI 兼容端点仍走 /chat/completions",
  /`\$\{route\.baseUrl\}\/chat\/completions`/.test(svc),
);
check(
  "ollama 端点仍走 /api/generate（不被并入 chat/completions）",
  /`\$\{route\.baseUrl\}\/api\/generate`/.test(svc),
);
check(
  "两种 transport 仍分派（openai / ollama 未被合并）",
  /route\.transport === "ollama"/.test(svc) &&
    /private async callGenerate\(/.test(svc) &&
    /private async callCompatible\(/.test(svc),
);
check(
  "sanitizeLogs 仍在（S-10 脱敏未退化）",
  /private sanitizeLogs/.test(svc),
);
check(
  "analyzeFailure 仍走 sanitizeLogs",
  /const sanitized = this\.sanitizeLogs\(logs\)/.test(svc),
);
// WIKI-OPT-3 的 cron 校验现在先规范化再验（AI 会产出 POSIX 裸 n/step 形态，
// 如 "12/20 * * * *"，直接喂 nodeCron.validate 会被误判非法）。原断言写死了
// `nodeCron.validate(parsed.suggestedCron)` 这一精确形态，规范化引入后即腐烂。
// 锁真正的不变量：校验存在 + **校验对象是规范化后的 canonical**（不是原始串），
// 且非法分支仍走 warn + fallback:true。
check(
  "suggestSchedule 的 cron 校验未被删（WIKI-OPT-3）",
  /nodeCron\.validate\(canonical\)/.test(svc),
);
check(
  "cron 校验作用在规范化后的值上，而不是 AI 原始串",
  /normalizeCron5Field\(parsed\.suggestedCron\)[\s\S]{0,200}?nodeCron\.validate\(canonical\)/.test(svc),
);
check(
  "非法 cron → warn + fallback:true（不静默透出）",
  /nodeCron\.validate\(canonical\)[\s\S]{0,400}?fallback:\s*true/.test(svc),
);

console.log(
  failures
    ? `\n=== ${failures} 项失败 ===\n`
    : "\n=== 全部结构断言通过 ===\n",
);
process.exit(failures ? 1 : 0);
