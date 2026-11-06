#!/usr/bin/env node
/**
 * R92（2026-11-06，ADR-034 步骤 5）：**类别单一来源守卫**。
 *
 * ADR-034 消灭的是「三端各自推导一份类别表」。步骤 1–3 已把三端都改成读生成物，
 * 但那只是**当下**消掉；若没有守卫，将来「新增类别只改实现不改契约」或「某端偷偷硬编码一份映射」都会复活同一缺陷。
 *
 * ## 三条判据
 * ① **禁止硬编码类别→放行映射**：三端类别判定实现文件里不得出现「类别名字面量 + 布尔字面量」的映射形态
 *    （如 `'multicast': true` / `"cgnat": False`）；确需写死的行用 `// allowed-literal: <≥12 字理由>` 豁免。
 * ② **生成物必须来自契约**：三份生成物的类别集合/顺序与 `networkPolicy.categories.order` **逐字一致**，
 *    且 `ALLOWED_UNDER_PRIVATE` 与 `categories.allowedUnderPrivateNetwork` 一致。
 * ③ **三端覆盖**：三端实现都引用生成物（静态特征：各自 import 生成物/由调用方注入），缺一端即红。
 *
 * ## 注入（沿用 R88）：`CAT_SS_<END>_SRC` 可替换单端实现副本；**不存在即报错，不静默回落**。
 *
 * 用法：node scripts/check-categories-single-source.mjs [--root=<dir>]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
export const CONTRACT_REL = "packages/executor-protocol/protocol.json";

export const ENDS = [
  {
    id: "admin",
    impl: "apps/admin-api/src/common/utils/address-category.util.ts",
    gen: "apps/admin-api/src/generated/protocol-categories.ts",
    envKey: "CAT_SS_ADMIN_SRC",
  },
  {
    id: "node",
    impl: "apps/executor-node/src/lib/address-category.ts",
    gen: "apps/executor-node/src/generated/protocol-categories.ts",
    envKey: "CAT_SS_NODE_SRC",
  },
  {
    id: "python",
    impl: "apps/executor-python/network_policy.py",
    gen: "apps/executor-python/generated/protocol_categories.py",
    envKey: "CAT_SS_PY_SRC",
  },
];

/** 判据 ①：类别名 + 布尔字面量的映射形态（`'x': true` / `"x": False`）。 */
const HARDCODED_MAP_RE = /(['"])([A-Za-z][\w]*)\1\s*:\s*(true|false|True|False)\b/;
const ALLOW_LITERAL_RE = /\/\/\s*allowed-literal:|#\s*allowed-literal:/;

function readMaybe(root, rel) {
  const abs = join(root, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const contractText = readMaybe(root, CONTRACT_REL);
  if (!contractText) return [`读不到契约 ${CONTRACT_REL}`];
  let contract;
  try {
    contract = JSON.parse(contractText);
  } catch (e) {
    return [`契约不是合法 JSON：${e.message}`];
  }
  const cats = contract.networkPolicy?.categories ?? {};
  const order = cats.order ?? [];
  const allowed = cats.allowedUnderPrivateNetwork ?? [];
  if (order.length === 0) return ["契约 networkPolicy.categories.order 为空 —— 判据面塌方"];
  const catSet = new Set(order);
  const orderJson = `[${order.map((x) => `"${x}"`).join(",")}]`;
  const allowedJson = `[${allowed.map((x) => `"${x}"`).join(",")}]`;

  for (const end of ENDS) {
    // 注入 A：实现文件可替换（不存在即报错）
    const injected = process.env[end.envKey];
    if (injected && !existsSync(injected)) {
      errors.push(`注入源不存在：${end.envKey}=${injected}`);
      continue;
    }
    const implPath = injected ?? join(root, end.impl);
    const implText = existsSync(implPath) ? readFileSync(implPath, "utf8") : null;
    if (implText === null) {
      errors.push(`[${end.id}] 读不到实现文件 ${injected ?? end.impl}`);
      continue;
    }

    // ① 硬编码映射
    implText.split("\n").forEach((line, i) => {
      if (ALLOW_LITERAL_RE.test(line)) return;
      const m = line.match(HARDCODED_MAP_RE);
      // 只认**契约类别名**作为键（否则会把 `allowed: False` 这类普通字段误判成映射）
      if (m && catSet.has(m[2])) {
        errors.push(
          `[${end.id}] ${(injected ?? end.impl).replace(`${root}/`, "")}:${i + 1} 出现**硬编码类别→放行映射** ` +
            `\`${m[2]}: ${m[3]}\` —— 类别表只能来自生成物（ADR-034）；确需写死请用 \`// allowed-literal: <≥12 字理由>\``,
        );
      }
    });

    // ③ 三端覆盖：实现必须引用生成物或由调用方注入
    const genBase = end.gen.split("/").pop().replace(/\.(ts|py)$/, "");
    const referencesGen =
      implText.includes(genBase) ||
      /CATEGORY_ORDER|ALLOWED_UNDER_PRIVATE/.test(implText) ||
      /tables\s*[:=]/.test(implText);
    if (!referencesGen) {
      errors.push(`[${end.id}] 实现文件里看不到「引用生成物 / 由调用方注入」的痕迹 —— 三端覆盖缺口（判据 ③）`);
    }

    // ② 生成物 vs 契约
    const genText = readMaybe(root, end.gen);
    if (genText === null) {
      errors.push(`[${end.id}] 读不到生成物 ${end.gen}`);
      continue;
    }
    const orderInGen = genText.match(/CATEGORY_ORDER[^=]*=\s*(\[[^\]]*\])/);
    if (!orderInGen) {
      errors.push(`[${end.id}] 生成物里找不到 CATEGORY_ORDER：${end.gen}`);
    } else {
      const normalized = orderInGen[1].replace(/\s+/g, "");
      if (normalized !== orderJson) {
        errors.push(
          `[${end.id}] 生成物 CATEGORY_ORDER 与契约 categories.order **不一致**：生成物 ${normalized} / 契约 ${orderJson}`,
        );
      }
    }
    const allowedInGen = genText.match(/ALLOWED_UNDER_PRIVATE[^=]*=\s*(\[[^\]]*\])/);
    if (!allowedInGen) {
      errors.push(`[${end.id}] 生成物里找不到 ALLOWED_UNDER_PRIVATE：${end.gen}`);
    } else {
      const normalized = allowedInGen[1].replace(/\s+/g, "");
      if (normalized !== allowedJson) {
        errors.push(
          `[${end.id}] 生成物 ALLOWED_UNDER_PRIVATE 与契约 allowedUnderPrivateNetwork **不一致**：生成物 ${normalized} / 契约 ${allowedJson}`,
        );
      }
    }
  }
  errors.meta = { ends: ENDS.length, categories: order.length };
  return errors;
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const root = eq ? resolve(eq.slice("--root=".length)) : REPO_ROOT;
  const errors = check(root);
  const meta = errors.meta ?? {};
  if (errors.length === 0) {
    console.log(
      `✔ 类别单一来源：${meta.ends} 端实现无硬编码映射、${meta.categories} 个类别与契约逐字一致、三端均引用生成物。`,
    );
    return 0;
  }
  console.error(`✘ 类别单一来源：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(main(process.argv.slice(2)));
}
