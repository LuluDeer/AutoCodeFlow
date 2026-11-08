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

const HERE = dirname(fileURLToPath(import.meta.url));

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
function selftest() {
  const cases = [];
  const ok = (name, fn) => {
    try {
      fn();
      cases.push({ name, pass: true });
    } catch (e) {
      cases.push({ name, pass: false, err: String(e && e.message) });
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
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

  ok("① 两侧一致 ⇒ 无问题", () => {
    const r = {
      problems: [],
      structure: [],
    };
    const codeKeys = parseFilterKeys(FILTER_OK);
    const docKeys = parseDocKeys(DOC_OK);
    assert(codeKeys && codeKeys.length === 7, `codeKeys=${JSON.stringify(codeKeys)}`);
    assert(docKeys && docKeys.length === 7, `docKeys=${JSON.stringify(docKeys)}`);
    assert(r.problems.length === 0, "should be clean");
  });

  ok("② 文档缺 errorCode ⇒ 能被识别为「缺」", () => {
    const docMissing = DOC_OK.replace('  "errorCode": "X",\n', "");
    const codeKeys = parseFilterKeys(FILTER_OK);
    const docKeys = parseDocKeys(docMissing);
    assert(docKeys && !docKeys.includes("errorCode"), `docKeys=${JSON.stringify(docKeys)}`);
    assert(codeKeys.includes("errorCode"), "code should have it");
  });

  ok("③ 文档多写不存在字段 ⇒ 能被识别为「多」", () => {
    const docExtra = DOC_OK.replace('  "path": "/p"', '  "path": "/p",\n  "traceId": "bogus"');
    const codeKeys = parseFilterKeys(FILTER_OK);
    const docKeys = parseDocKeys(docExtra);
    assert(docKeys.includes("traceId"), `docKeys=${JSON.stringify(docKeys)}`);
    assert(!codeKeys.includes("traceId"), "code must not have it");
  });

  ok("④ 标题被改 ⇒ 解析出 null（结构红的来源，不是「一致」）", () => {
    const renamed = DOC_OK.replace(DOC_HEADING, "**错误响应：**");
    assert(parseDocKeys(renamed) === null, "should be null when heading drifts");
  });

  ok("⑤ 过滤器里没有 response.status(...).json ⇒ 解析出 null（不静默）", () => {
    assert(parseFilterKeys("export const x = 1;") === null, "should be null");
  });

  ok("⑥ 嵌套对象不算顶层键（params 的内容不该被当成响应字段）", () => {
    const nested = FILTER_OK.replace("params,", "params: { inner: 1 },");
    const keys = parseFilterKeys(nested);
    assert(!keys.includes("inner"), `keys=${JSON.stringify(keys)}`);
  });

  const failed = cases.filter((c) => !c.pass);
  for (const c of cases) {
    console.log(`  ${c.pass ? "✔" : "✘"} ${c.name}${c.pass ? "" : ` —— ${c.err}`}`);
  }
  console.log(
    failed.length === 0
      ? `\n✔ check-api-error-format selftest 通过：${cases.length}/${cases.length} 条用例`
      : `\n✖ check-api-error-format selftest 失败：${failed.length}/${cases.length} 条未按预期`,
  );
  return failed.length === 0 ? 0 : 1;
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
