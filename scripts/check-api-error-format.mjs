#!/usr/bin/env node
/**
 * R178 · `check-api-error-format` —— **文档里的「错误响应字段」必须和代码里的真实字段一致**。
 *
 * ## 为什么需要这条（这不是假想风险，是本轮实测抓到的真事）
 *
 * `docs/api-reference.md` 的「错误响应格式」示例**漏了 `errorCode` 与 `params` 两个字段**，
 * 而这两个字段正是**整套错误本地化的入口**：
 * 客户端按 `errorCode` 查自己的文案表、按 `params` 插值，查不到才回落 `message`（恒为中文）。
 * ⇒ **照旧示例实现的第三方，等于「错误本地化不存在」**：英文界面会直接显示中文。
 * 这个偏差存在了很久没人发现 —— 因为**「错误响应格式」那段是纯散文，没有任何判据守着**
 * （`gen-api-reference-appendix --check` 只管 REST 端点附录，不管这段）。
 *
 * 同一轮里我自己也踩了一次：改文档时把 `code` 误写成 `statusCode`（真实字段是 `code`）
 * ⇒ **靠人眼核对文档与代码，两边都会漂**。所以要有机器判据。
 *
 * ## 判据
 * ①（**正向**）过滤器 `response.status(...).json({ ... })` 里的**每一个键**，
 *    都必须出现在 `docs/api-reference.md` 的「错误响应格式」代码块里；
 * ②（**反向**）文档代码块里的**每一个键**，都必须是过滤器真实产出的键 ——
 *    文档**多写**一个不存在的字段，比少写更糟（客户端会去读一个永远是 `undefined` 的字段）；
 * ③（**结构**）两侧都要能解析出**非空**键集合 —— 解析出空集时判**结构红**
 *    （不是判「一致」：那会让「正则失效」伪装成「零差异全绿」）。
 *
 * ⚠️ 只锚**字段名**，不锚示例值的具体内容（值本来就可以随便举例）。
 *
 * ## 用法
 *   node scripts/check-api-error-format.mjs              # 判据（门禁用）
 *   node scripts/check-api-error-format.mjs --selftest   # 验证判据本身有齿
 *   node scripts/check-api-error-format.mjs --root <dir> # 指定仓库根（自检夹具用）
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

/** 本脚本自身的绝对路径 —— 黑盒 selftest 用 runGuard(SELF, ...) 起真子进程。 */
const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);

export const FILTER_REL = "apps/admin-api/src/common/filters/http-exception.filter.ts";
export const DOC_REL = "docs/api-reference.md";

/** 文档里「错误响应格式」小节的标题锚点（改标题会让判据结构红——这是有意的）。 */
export const DOC_HEADING = "**错误响应格式：**";

/**
 * 从过滤器源码里抽 `response.status(...).json({ … })` 的**顶层键**。
 *
 * 只取顶层（`{` 深度为 1 的键），因为嵌套对象（`params` 的内容）不属于「响应格式」。
 * 解析不出 ⇒ 返回 `null`（由调用方判结构红）。
 */
export function parseFilterKeys(src) {
  const text = String(src ?? "");
  const m = /response\.status\([^)]*\)\.json\(\s*\{/.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length; // 指向 `{` 之后
  let depth = 1;
  const keys = [];
  let lineStart = i;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === "\n") {
      lineStart = i + 1;
    } else if (depth === 1) {
      // 顶层键：行首（允许空白）紧跟 `ident:`，或 `ident,`（简写）
      const rest = text.slice(lineStart);
      const km = /^\s*([A-Za-z_$][\w$]*)\s*[,:]/.exec(rest);
      if (km && lineStart >= m.index && !keys.includes(km[1])) {
        // 同一行只取一次：把 lineStart 推到该行末尾
        keys.push(km[1]);
        const nl = text.indexOf("\n", lineStart);
        lineStart = nl === -1 ? text.length : nl + 1;
      }
    }
  }
  return keys;
}

/**
 * 从文档「错误响应格式」小节的 JSON 代码块里抽**顶层键**。
 * 解析不出 ⇒ 返回 `null`（结构红）。
 */
export function parseDocKeys(md) {
  const text = String(md ?? "");
  const at = text.indexOf(DOC_HEADING);
  if (at < 0) return null;
  const fence = text.indexOf("```json", at);
  if (fence < 0) return null;
  const end = text.indexOf("```", fence + 7);
  if (end < 0) return null;
  const body = text.slice(fence + 7, end);
  const obj = /\/\*[\s\S]*?\*\//.test(body) ? null : body; // 代码块里有注释 ⇒ 不是纯 JSON
  const keys = [];
  // 顶层键 = 缩进恰为 2 空格的 `"key":`
  for (const line of (obj ?? body).split("\n")) {
    const m = /^ {2}"([A-Za-z_$][\w$]*)"\s*:/.exec(line);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys.length > 0 ? keys : null;
}

export function check({ root }) {
  const problems = [];
  const structure = [];

  const filterPath = join(root, FILTER_REL);
  const docPath = join(root, DOC_REL);
  if (!existsSync(filterPath)) {
    structure.push(`读不到过滤器 ${FILTER_REL} —— 路径变了或文件被移走，判据瞎了。`);
    return { problems, structure };
  }
  if (!existsSync(docPath)) {
    structure.push(`读不到 ${DOC_REL} —— 文档被移走，判据瞎了。`);
    return { problems, structure };
  }

  const codeKeys = parseFilterKeys(readFileSync(filterPath, "utf8"));
  const docKeys = parseDocKeys(readFileSync(docPath, "utf8"));

  if (!codeKeys || codeKeys.length === 0) {
    structure.push(
      `从 ${FILTER_REL} 解析出 0 个响应字段 —— 正则失效了（不是响应体变空了）。` +
        `此处必须判**结构红**：否则「文档漏字段」会伪装成「零差异全绿」。`,
    );
    return { problems, structure };
  }
  if (!docKeys || docKeys.length === 0) {
    structure.push(
      `从 ${DOC_REL} 的「错误响应格式」小节解析出 0 个字段 —— ` +
        `标题被改 / 代码块被删 / 缩进变了。判结构红（不是判「一致」）。`,
    );
    return { problems, structure };
  }

  for (const k of codeKeys) {
    if (!docKeys.includes(k)) {
      problems.push(
        `${DOC_REL} 的「错误响应格式」示例**缺字段 \`${k}\`** —— 而过滤器真的会产出它。` +
          `客户端照文档实现就会漏读它；若缺的是 \`errorCode\`/\`params\`，等于**整套错误本地化不存在**。`,
      );
    }
  }
  for (const k of docKeys) {
    if (!codeKeys.includes(k)) {
      problems.push(
        `${DOC_REL} 的「错误响应格式」示例里有 \`${k}\`，但过滤器**不产出这个字段** —— ` +
          `文档多写一个不存在的字段比少写更糟：客户端会去读一个永远是 undefined 的字段。`,
      );
    }
  }

  return { problems, structure, codeKeys, docKeys };
}

// ── selftest ────────────────────────────────────────────────────────────────
/**
 * R-黑盒化：本守卫的 selftest 此前**全部进程内直调** `check()` / `parse*Keys()`，
 * main 的退出码、`--root` 解析、以及结构红 / problems 红两条 `process.exit(1)`
 * 分支一条都没覆盖 —— 把任一 `process.exit(1)` 改成 `process.exit(0)`，CLI 照样
 * 打印 ✘ 却 EXIT 0、CI 转绿，而旧 selftest 仍 6/6 全绿（与
 * `check-categories-single-source` 同款假绿缺口）。现在每条用例都起**真子进程**
 * 跑本脚本 CLI：`runGuard(SELF, { args: ["--root", dir] })` + `expectExit`，
 * 「退出码 0/1 + stdout/stderr 文本」本身成为断言面。
 *
 * ⚠️ 本守卫 main 的 `--root` 是**空格分离形态**（`argv.indexOf("--root")` +
 * `argv[rootIdx+1]`），不是 `--root=<dir>`，夹具一律用 `args: ["--root", dir]`。
 *
 * 六个夹具场景与旧版逐条对应（一致 / 文档缺字段 / 文档多字段 / 标题漂移结构红 /
 * 过滤器正则失效结构红 / 嵌套对象不算顶层键），语义不变，只改「怎么调」。
 */
function selftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  /** 起一个真子进程跑本脚本 CLI，断言退出码 + stdout/stderr 观测文本。 */
  const subprocess = (name, files, expectations) => {
    push(name, () => {
      const repo = makeFixtureRepo(files, { prefix: "api-error-format-selftest-" });
      try {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          ...expectations,
          label: name,
        });
      } finally {
        repo.cleanup();
      }
    });
  };

  const FILTER_OK = `response.status(status).json({
      code: status,
      errorCode,
      message,
      params,
      data: errors,
      timestamp: new Date().toISOString(),
      path: request.url,
    });`;
  const DOC_OK = `${DOC_HEADING}

\`\`\`json
{
  "code": 400,
  "errorCode": "X",
  "message": "m",
  "params": null,
  "data": [],
  "timestamp": "t",
  "path": "/p"
}
\`\`\`
`;

  // 与旧版逐条对应的四个变异夹具（判据语义不变，只改成写进临时仓库树）。
  const docMissing = DOC_OK.replace('  "errorCode": "X",\n', "");
  const docExtra = DOC_OK.replace('  "path": "/p"', '  "path": "/p",\n  "traceId": "bogus"');
  const docRenamed = DOC_OK.replace(DOC_HEADING, "**错误响应：**");
  const filterNoJson = "export const x = 1;";
  const filterNested = FILTER_OK.replace("params,", "params: { inner: 1 },");

  subprocess(
    "① 两侧一致 ⇒ CLI exit 0 + ✔（正例控制组，无假红）",
    { [FILTER_REL]: FILTER_OK, [DOC_REL]: DOC_OK },
    {
      code: 0,
      contains: ["✔ API 错误响应格式", "COVERAGE_CASES: 6"],
      absent: ["✖ API 错误响应格式"],
    },
  );
  subprocess(
    "② 文档缺 errorCode ⇒ CLI exit 1 + 报「缺字段 errorCode」（problems 红分支）",
    { [FILTER_REL]: FILTER_OK, [DOC_REL]: docMissing },
    {
      code: 1,
      contains: ["✖ API 错误响应格式与文档不一致", '缺字段 `errorCode`'],
      absent: ["✔ API 错误响应格式"],
    },
  );
  subprocess(
    "③ 文档多写 traceId ⇒ CLI exit 1 + 报「不产出这个字段」（problems 红分支）",
    { [FILTER_REL]: FILTER_OK, [DOC_REL]: docExtra },
    {
      code: 1,
      contains: ["✖ API 错误响应格式与文档不一致", "traceId", "不产出这个字段"],
      absent: ["✔ API 错误响应格式"],
    },
  );
  subprocess(
    "④ 标题被改 ⇒ CLI exit 1 + 报解析出 0 个字段（结构红分支）",
    { [FILTER_REL]: FILTER_OK, [DOC_REL]: docRenamed },
    {
      code: 1,
      contains: ["✖ API 错误响应格式守卫结构错误", "解析出 0 个字段"],
      absent: ["✔ API 错误响应格式"],
    },
  );
  subprocess(
    "⑤ 过滤器无 response.status(...).json ⇒ CLI exit 1 + 报解析出 0 个响应字段（结构红分支）",
    { [FILTER_REL]: filterNoJson, [DOC_REL]: DOC_OK },
    {
      code: 1,
      contains: ["✖ API 错误响应格式守卫结构错误", "解析出 0 个响应字段"],
      absent: ["✔ API 错误响应格式"],
    },
  );
  subprocess(
    "⑥ 嵌套对象不算顶层键 ⇒ CLI exit 0 + ✔（inner 未混入字段表）",
    { [FILTER_REL]: filterNested, [DOC_REL]: DOC_OK },
    {
      code: 0,
      contains: ["✔ API 错误响应格式"],
      absent: ["✖ API 错误响应格式", "inner"],
    },
  );

  const failed = reportCases(cases, { title: "check-api-error-format selftest" });
  return failed === 0 ? 0 : 1;
}

// ── main ───────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    process.exit(selftest());
  }
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? argv[rootIdx + 1] : join(HERE, "..");
  if (rootIdx >= 0 && !root) {
    console.error("--root 需要一个目录参数");
    process.exit(2);
  }
  let res;
  try {
    res = check({ root });
  } catch (e) {
    console.error(`✖ check-api-error-format 运行失败：${e && e.message}`);
    process.exit(2);
  }
  console.log("COVERAGE_CASES: 6");
  if (res.structure.length > 0) {
    console.error("✖ API 错误响应格式守卫结构错误（判据本身不可信）：");
    for (const s of res.structure) console.error(`  · ${s}`);
    process.exit(1);
  }
  if (res.problems.length > 0) {
    console.error(`✖ API 错误响应格式与文档不一致：${res.problems.length} 项`);
    for (const p of res.problems) console.error(`  · ${p}`);
    process.exit(1);
  }
  console.log(
    `✔ API 错误响应格式：文档与过滤器一致（${res.codeKeys.length} 个字段：${res.codeKeys.join(" / ")}）。`,
  );
  process.exit(0);
}

void readdirSync;
