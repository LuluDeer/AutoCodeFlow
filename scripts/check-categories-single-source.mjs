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
/**
 * R94：**「契约类别名 → 标签字符串」形态**（W3 反向验证实证：把手抄映射改回并让 multicast 写回 reserved，
 * 旧守卫仍 exit 0 —— 因为旧正则只认布尔）。同样只认契约 `categories.order` 成员作键。
 */
const HARDCODED_LABEL_RE = /(?:['"]([A-Za-z][\w]*)['"]|\b([A-Za-z][\w]*))\s*:\s*['"]([A-Za-z][\w-]*)['"]/;
const ALLOW_LITERAL_RE = /\/\/\s*allowed-literal:|#\s*allowed-literal:/;

function readMaybe(root, rel) {
  const abs = join(root, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/**
 * R94：**豁免区（按常量名，逐条给理由；数量进基线，不许无痕增加）**
 * 这些常量是**架构性兜底**（纯模块 0 import ⇒ 不能 import 生成物），其正确性由判据②「兜底 ≡ 生成物」
 * 独立钉死 ⇒ 判据①（禁硬编码）对这些块**跳过**，否则会把唯一的兜底也判红。
 */
export const EXEMPT_BLOCKS = [
  { name: "ADMIN_LABEL_FALLBACK", why: "纯模块 0 import 无法引生成物，架构性兜底；由判据②钉其与 END_LABELS_ADMIN 逐字相等" },
  { name: "DEFAULT_UNLOCKED_UNDER_SWITCH", why: "同上：node 纯模块的默认值兜底；由判据②钉其与 ALLOWED_UNDER_PRIVATE 相等" },
  { name: "ALLOWED_UNDER_PRIVATE_FALLBACK", why: "DEFAULT_UNLOCKED_UNDER_SWITCH 的单向别名，同值两名；由判据②覆盖" },
];

/** 计算某个常量声明块的起止行（1-based，含首尾）。 */
function blockRange(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes(name) && /=|:/.test(l));
  if (start < 0) return null;
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth += 1; seen = true; }
      if (ch === "}") depth -= 1;
    }
    if (seen && depth <= 0) return [start + 1, i + 1];
    if (!seen && i > start + 3) return [start + 1, start + 1];
  }
  return [start + 1, lines.length];
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

    // ① 硬编码映射（跳过 EXEMPT_BLOCKS 覆盖的行）
    const exemptRanges = EXEMPT_BLOCKS.map((b) => blockRange(implText, b.name)).filter(Boolean);
    const exemptLines = new Set();
    for (const [a, b] of exemptRanges) for (let n = a; n <= b; n += 1) exemptLines.add(n);
    implText.split("\n").forEach((line, i) => {
      if (exemptLines.has(i + 1)) return;
      if (ALLOW_LITERAL_RE.test(line)) return;
      const labelM = line.match(HARDCODED_LABEL_RE);
      const labelKey = labelM ? (labelM[1] ?? labelM[2]) : null;
      if (labelM && catSet.has(labelKey)) {
        errors.push(
          `[${end.id}] ${(injected ?? end.impl).replace(`${root}/`, "")}:${i + 1} 出现**硬编码类别→标签映射** ` +
            `\`${labelKey}: ${labelM[3]}\` —— 标签也只能来自契约 endLabels（ADR-034）；确需写死请用 \`// allowed-literal: <≥12 字理由>\``,
        );
      }
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
  // ② R94：**兜底常量 ≡ 生成物**（独立断言，不依赖 spec）。
  // 注意：`ADMIN_ADDRESS_CATEGORIES`（safe-http.util.ts）**故意**与 AddressRisk 联合类型不同源 ——
  // 改成派生会变成同义反复（永远绿）⇒ **不纳入**（W3 已论证，本守卫尊重该判断）。
  const genNode = readMaybe(root, "apps/executor-node/src/generated/protocol-categories.ts");
  const genAdmin = readMaybe(root, "apps/admin-api/src/generated/protocol-categories.ts");
  const allowedSet = new Set(allowed);
  const fallbackChecks = [];
  const nodeImpl = readMaybe(root, process.env.CAT_SS_NODE_SRC ?? "apps/executor-node/src/lib/address-category.ts");
  if (nodeImpl && genNode) {
    const decl = nodeImpl.match(/DEFAULT_UNLOCKED_UNDER_SWITCH[^=]*=\s*(\[[^\]]*\])/);
    if (!decl) {
      errors.push("[node] 找不到 DEFAULT_UNLOCKED_UNDER_SWITCH 声明 —— 兜底常量判据失去对象");
    } else {
      const vals = [...decl[1].matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]);
      const same = vals.length === allowedSet.size && vals.every((v) => allowedSet.has(v));
      fallbackChecks.push(`node DEFAULT_UNLOCKED_UNDER_SWITCH=${JSON.stringify(vals)}`);
      if (!same) {
        errors.push(
          `[node] DEFAULT_UNLOCKED_UNDER_SWITCH 与契约 allowedUnderPrivateNetwork **漂移**：` +
            `实现 ${JSON.stringify(vals)} / 契约 ${allowedJson}`,
        );
      }
    }
  }
  const adminImpl = readMaybe(root, process.env.CAT_SS_ADMIN_SRC ?? "apps/admin-api/src/common/utils/address-category.util.ts");
  if (adminImpl && genAdmin) {
    const genLabels = genAdmin.match(/END_LABELS_ADMIN[^=]*=\s*(\{[^}]*\})/);
    const fb = adminImpl.match(/ADMIN_LABEL_FALLBACK[^=]*=\s*\{([\s\S]*?)\n\}/);
    if (genLabels && fb) {
      const pairs = (txt) => [...txt.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]([\w-]+)['"]/g)].map((m) => `${m[1]}=>${m[2]}`).sort();
      const a = pairs(fb[1]);
      const b = pairs(genLabels[1]);
      fallbackChecks.push(`admin ADMIN_LABEL_FALLBACK=${a.length} 对`);
      if (a.join("|") !== b.join("|")) {
        errors.push(
          `[admin] ADMIN_LABEL_FALLBACK 与生成物 END_LABELS_ADMIN **漂移**：实现 ${a.join(",")} / 生成物 ${b.join(",")}`,
        );
      }
    }
  }

  // ③ R103：`CATEGORY_ALIASES` 归一化表**不得含放行布尔**（它是"名字归一化"，不是第二份"类别→放行"）。
  const aliasSrc = readMaybe(root, process.env.CAT_SS_ALIAS_SRC ?? "scripts/ssrf-category-matrix.mjs");
  if (aliasSrc === null) {
    errors.push("读不到 scripts/ssrf-category-matrix.mjs —— 别名表判据失去对象");
  } else {
    const block = aliasSrc.match(/CATEGORY_ALIASES[^=]*=\s*\{([\s\S]*?)\n\};/);
    if (!block) {
      errors.push("scripts/ssrf-category-matrix.mjs 里找不到 CATEGORY_ALIASES 表 —— 判据失去对象");
    } else {
      block[1].split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|#)/.test(line)) return;
        if (/['"]?[\w-]+['"]?\s*:\s*(true|false|True|False)\b/.test(line)) {
          errors.push(
            `scripts/ssrf-category-matrix.mjs CATEGORY_ALIASES 第 ${i + 1} 行出现**放行布尔**：\`${line.trim()}\` —— ` +
              `别名表只做名字归一化，放行结论必须由生成物决定（ADR-034）`,
          );
        }
      });
    }
  }

  errors.meta = {
    ends: ENDS.length,
    categories: order.length,
    fallbackChecks,
    exemptBlocks: EXEMPT_BLOCKS.length,
  };
  return errors;
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const root = eq ? resolve(eq.slice("--root=".length)) : REPO_ROOT;
  const errors = check(root);
  const meta = errors.meta ?? {};
  if (meta.exemptBlocks) {
    console.log(`（判据①豁免区 ${meta.exemptBlocks} 处：${EXEMPT_BLOCKS.map((b) => b.name).join("、")} —— 由判据②钉住其与生成物逐字相等）`);
  }
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
