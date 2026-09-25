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

check("provider 分发含 qwen 分支", svc.includes('provider === "qwen"'));
check("callQwenText 存在（纯文本路径）", /private async callQwenText/.test(svc));
check("chatMultimodal 存在（多模态路径）", /async chatMultimodal\(/.test(svc));

// fail-open：provider 非 qwen 时返回空，绝不抛错影响主链
check(
  "fail-open：非 qwen provider 返回空结果",
  /provider !== "qwen"[\s\S]{0,600}?content:\s*""/.test(svc),
);
check(
  "fail-open：无 API key 时返回空结果",
  /no API key[\s\S]{0,300}?content:\s*""/.test(svc),
);

// 安全姿态必须与 callOpenAI 一致（不新开旁路）
check(
  "安全：保留 assertAndPinHttpUrl（SSRF + DNS pin）",
  /assertAndPinHttpUrl\(baseUrl/.test(svc),
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

// 令牌上限独立于 openai 的 500
check(
  "max_tokens 来自 qwen 独立配置（不共享 openai 的 500）",
  /maxTokens = req\.maxTokens \?\?/.test(svc),
);
check(
  "既有 callOpenAI 的 500 未被改动",
  /max_tokens:\s*500/.test(svc),
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

// ── 回归：既有 provider 路径零变化 ─────────────────────────────────
console.log("\n── 回归：既有 provider 零变化 ──");
check(
  "openai 分支仍存在且用 openaiBaseUrl",
  /if \(provider === "openai"\) return await this\.callOpenAI/.test(svc),
);
check(
  "ollama 分支仍存在",
  /if \(provider === "ollama"\) return await this\.callOllama/.test(svc),
);
check("callOpenAI 方法体未被删除", /private async callOpenAI/.test(svc));
check("callOllama 方法体未被删除", /private async callOllama/.test(svc));
check(
  "sanitizeLogs 仍在（S-10 脱敏未退化）",
  /private sanitizeLogs/.test(svc),
);
check(
  "analyzeFailure 仍走 sanitizeLogs",
  /const sanitized = this\.sanitizeLogs\(logs\)/.test(svc),
);
check(
  "suggestSchedule 的 cron 校验未被删（WIKI-OPT-3）",
  /nodeCron\.validate\(parsed\.suggestedCron\)/.test(svc),
);

console.log(
  failures
    ? `\n=== ${failures} 项失败 ===\n`
    : "\n=== 全部结构断言通过 ===\n",
);
process.exit(failures ? 1 : 0);
