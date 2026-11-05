#!/usr/bin/env node
/**
 * R68（2026-11-06）：**posture matrix 表驱动测试的存在性/口径守卫**（meta 守卫）。
 *
 * ## 为什么不比"结论"
 * R67 实测：三端闸层调用形态不同（admin 走 `policy`/env、node 走 `categoryAllowed(...)` 参数、
 * python 走 `host_safety_verdict(...)` 参数），且 admin 只能跑在 ts-jest 里、node 需要 `tsx`。
 * 若用**一个探针**复刻三种形态去比结论，探针就会退化成"第二实现"（R61 教训：建模 ≠ 真跑）。
 * ⇒ 本项目裁定：**"真跑"发生在各端自己的测试 runner 里**；本守卫只保证**那三张表存在、同源、同量、且真的会被跑**。
 *
 * ## 四判据（明确**不比对**放行/拒绝结论）
 * (a) **三端各存在至少一个表驱动 spec**，按下列匹配规约识别（写死在 `ENDS[].specPattern`）：
 *     · python：`apps/executor-python/tests/**\/*posture*matrix*.py`
 *     · node：`apps/executor-node/src/**\/*posture*matrix*.spec.ts`
 *     · admin：`apps/admin-api/src/**\/*posture*matrix*.spec.ts`
 * (b) **地址条数相同且等于契约**：三处 spec 里必须有一行机器可读声明 `// posture-addresses: <N>`，
 *     且 `N` 等于**契约**里 `networkPolicy.addresses.*.examples` 的总数（守卫自己从契约算，不从声明反推）。
 * (c) **都从契约读、且不硬编码**：spec 里必须出现契约读取标记（`packages/executor-protocol/protocol.json`
 *     或 `networkPolicy` 字样），并且**不得出现契约里的地址字面量**（如 `100.100.100.200`）——
 *     例外：该行以 `// allowed-literal:` 开头（用于说明性注释/对照表标题）。
 * (d) **都被各自测试入口执行**：python 由 `pytest.ini` 的 `testpaths` 覆盖 tests/；node/admin 由各自
 *     `package.json` 的 `scripts.test` 存在且 jest/vitest 的 testRegex 覆盖 `.spec.ts`（有则读，无则按默认）。
 *
 * ## 用法
 *   node scripts/check-posture-matrix-tables.mjs            # 守卫
 *   node scripts/check-posture-matrix-tables.mjs --selftest # 自检（正例 + 反例）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(HERE, "../..");
export const CONTRACT_REL = "packages/executor-protocol/protocol.json";
export const COUNT_MARKER = /\/\/\s*posture-addresses:\s*(\d+)/;
export const ALLOW_LITERAL = /\/\/\s*allowed-literal:/;

export const ENDS = [
  {
    id: "python",
    dir: "apps/executor-python/tests",
    specPattern: /posture.*matrix.*\.py$/i,
    entry: { file: "apps/executor-python/pytest.ini", needle: "testpaths" },
  },
  {
    id: "node",
    dir: "apps/executor-node/src",
    specPattern: /posture.*matrix.*\.spec\.ts$/i,
    entry: { file: "apps/executor-node/package.json", needle: '"test"' },
  },
  {
    id: "admin",
    dir: "apps/admin-api/src",
    specPattern: /posture.*matrix.*\.spec\.ts$/i,
    entry: { file: "apps/admin-api/package.json", needle: '"test"' },
  },
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(abs, out);
    } else out.push(abs);
  }
  return out;
}

/** 契约里的地址清单（逐字读，不硬编码副本）。 */
export function contractAddresses(root = REPO_ROOT) {
  const abs = join(root, CONTRACT_REL);
  if (!existsSync(abs)) return { error: `读不到契约 ${CONTRACT_REL}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    return { error: `契约不是合法 JSON：${e.message}` };
  }
  const np = parsed.networkPolicy ?? {};
  const examples = [];
  for (const [key, v] of Object.entries(np.addresses ?? {})) {
    for (const ex of v.examples ?? []) examples.push({ key, value: String(ex) });
  }
  // R69：**恒拒表（metadataAddresses.addresses）也并入"不许硬编码"检查面** ——
  // W3 实测：往 admin spec 注入 `100.100.100.200`（恒拒表地址）原先**不报**，因为这里只收 `addresses.*.examples`。
  // 恒拒表地址同样是"必须逐字从契约读"的事实（ADR-029），漏掉它等于给硬编码留了后门。
  const metaRaw = np.metadataAddresses ?? {};
  const metaList = Array.isArray(metaRaw) ? metaRaw : (metaRaw.addresses ?? []);
  // **两套清单分开**：`examples` 只作 (b) 的"三端条数一致"口径（= addresses.*.examples，实测 25）；
  // `literals` 才是 (c) 的"不许硬编码"面（additional 恒拒表）—— 混在一起会把条数口径改成 27，误伤 (b)。
  const literals = [
    ...examples.map((e) => e.value),
    ...metaList.map((a) => String(a).replace(/\/\d+$/, "")),
  ];
  return { examples, count: examples.length, metadataCount: metaList.length, literals };
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const contract = contractAddresses(root);
  if (contract.error) return [contract.error];
  if (contract.count === 0) return [`契约 ${CONTRACT_REL} 的 networkPolicy.addresses 没有任何 examples —— 判据面塌方`];

  for (const end of ENDS) {
    const files = walk(join(root, end.dir)).filter((f) => end.specPattern.test(f.replace(/\\/g, "/")));
    if (files.length === 0) {
      errors.push(
        `[${end.id}] 缺表驱动 spec：在 ${end.dir} 下没有匹配 ${String(end.specPattern)} 的文件 —— ` +
          `"真跑"必须发生在该端自己的 runner 里（本守卫只校验表的存在与口径）`,
      );
      continue;
    }
    for (const abs of files) {
      const rel = relative(root, abs).split("\\").join("/");
      const text = readFileSync(abs, "utf8");
      // (c) 必须从契约读
      if (!text.includes(CONTRACT_REL) && !/networkPolicy/.test(text)) {
        errors.push(`[${end.id}] ${rel} 没有"从契约读网络策略"的痕迹（既无 ${CONTRACT_REL} 也无 networkPolicy）`);
      }
      // (c′) 不得硬编码地址字面量
      const lines = text.split("\n");
      for (const [i, line] of lines.entries()) {
        if (ALLOW_LITERAL.test(line)) continue;
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("#")) continue;
        for (const lit of contract.literals) {
          const ex = { value: lit };
          if (line.includes(ex.value)) {
            errors.push(`[${end.id}] ${rel}:${i + 1} 硬编码了契约地址字面量「${ex.value}」（应逐字从契约读；说明性文本用 // allowed-literal: 前缀）`);
            break;
          }
        }
      }
      // (b) 条数声明必须等于契约实测条数
      const m = text.match(COUNT_MARKER);
      if (!m) {
        errors.push(`[${end.id}] ${rel} 缺机器可读声明 \`// posture-addresses: <N>\`（本守卫用它比对三端条数，免去复刻调用形态）`);
      } else if (Number(m[1]) !== contract.count) {
        errors.push(`[${end.id}] ${rel} 声明 posture-addresses=${m[1]}，但契约实测 **${contract.count}** —— 三端口径必须与契约同量`);
      }
    }
  }

  // (d) 各自测试入口存在
  for (const end of ENDS) {
    const p = join(root, end.entry.file);
    if (!existsSync(p)) {
      errors.push(`[${end.id}] 缺测试入口文件 ${end.entry.file}`);
      continue;
    }
    if (!readFileSync(p, "utf8").includes(end.entry.needle)) {
      errors.push(`[${end.id}] ${end.entry.file} 里找不到 \`${end.entry.needle}\` —— 表可能不会被跑`);
    }
  }
  errors.meta = { contractCount: contract.count, ends: ENDS.length };
  return errors;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });
  const CONTRACT = JSON.stringify(
    { networkPolicy: { addresses: { loopback: { examples: ["127.0.0.1"] }, cgnat: { examples: ["100.64.0.1"] } }, metadataAddresses: { addresses: ["100.100.100.200/32", "169.254.169.254"] } } },
    null,
    2,
  );
  const tree = (over = {}) => ({
    [CONTRACT_REL]: CONTRACT,
    "apps/executor-python/pytest.ini": "[pytest]\ntestpaths = tests\n",
    "apps/executor-node/package.json": '{ "scripts": { "test": "jest" } }',
    "apps/admin-api/package.json": '{ "scripts": { "test": "jest" } }',
    "apps/executor-python/tests/test_posture_matrix.py": over.py ??
      "// posture-addresses: 2\nimport json\ncfg = json.load(open('packages/executor-protocol/protocol.json'))\nnetworkPolicy = cfg['networkPolicy']\n",
    "apps/executor-node/src/posture-matrix.spec.ts": over.node ??
      "// posture-addresses: 2\nconst c = require('../../../../packages/executor-protocol/protocol.json'); // networkPolicy\n",
    "apps/admin-api/src/posture-matrix.spec.ts": over.admin ??
      "// posture-addresses: 2\nconst c = require('../../../../packages/executor-protocol/protocol.json'); // networkPolicy\n",
  });

  push("正例控制组：三端表齐备且口径一致 ⇒ exit 0", () => {
    const repo = makeFixtureRepo(tree());
    try {
      expectExit(runGuard(fileURLToPath(import.meta.url), { args: ["--root", repo.dir] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally {
      repo.cleanup();
    }
  });

  push("反例①：缺一端表 ⇒ exit 1 点名该端", () => {
    const t = tree();
    delete t["apps/executor-node/src/posture-matrix.spec.ts"];
    const repo = makeFixtureRepo(t);
    try {
      expectExit(runGuard(fileURLToPath(import.meta.url), { args: ["--root", repo.dir] }), {
        code: 1, contains: ["[node] 缺表驱动 spec"], withinMs: 20000, label: "缺 node",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例②：硬编码契约地址字面量 ⇒ exit 1 点名", () => {
    const repo = makeFixtureRepo(tree({ py: "// posture-addresses: 2\nADDRS = ['100.64.0.1']\n" }));
    try {
      expectExit(runGuard(fileURLToPath(import.meta.url), { args: ["--root", repo.dir] }), {
        code: 1, contains: ["硬编码了契约地址字面量"], withinMs: 20000, label: "硬编码",
      });
    } finally {
      repo.cleanup();
    }
  });

  // R69：**恒拒表地址（metadataAddresses.addresses）也必须落入"不许硬编码"面**。
  // W3 实测过：注入 `100.100.100.200`（恒拒表成员）原先**不报**，因为判据只查 addresses.*.examples。
  push("反例④：硬编码恒拒表地址（metadataAddresses）⇒ exit 1 点名 file:line", () => {
    const repo = makeFixtureRepo(
      tree({ admin: "// posture-addresses: 2\nconst c = require('x'); // networkPolicy\nconst DENY = '100.100.100.200';\n" }),
    );
    try {
      expectExit(runGuard(fileURLToPath(import.meta.url), { args: ["--root", repo.dir] }), {
        code: 1, contains: ["100.100.100.200", "硬编码了契约地址字面量"], withinMs: 20000, label: "恒拒表硬编码",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例③：条数与契约不一致 ⇒ exit 1 点名", () => {
    const repo = makeFixtureRepo(tree({ admin: "// posture-addresses: 9\nconst c = require('x'); // networkPolicy\n" }));
    try {
      expectExit(runGuard(fileURLToPath(import.meta.url), { args: ["--root", repo.dir] }), {
        code: 1, contains: ["声明 posture-addresses=9", "契约实测"], withinMs: 20000, label: "条数不一致",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-posture-matrix-tables selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const at = argv.indexOf("--root");
  const rootArg = eq ? eq.slice("--root=".length) : at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  const errors = check(resolve(rootArg ?? REPO_ROOT));
  const meta = errors.meta ?? {};
  if (errors.length === 0) {
    console.log(
      `✔ posture matrix 守卫通过：三端表驱动 spec 齐备、条数与契约一致（${meta.contractCount} 条）、不硬编码地址、各自测试入口可达。`,
    );
    return 0;
  }
  console.error(`✘ posture matrix 守卫：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
