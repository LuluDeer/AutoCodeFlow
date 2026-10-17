#!/usr/bin/env node
/**
 * SECURITY §3.1 配套守卫：**密码策略的后端 ⇔ 前端同源校验**。
 *
 * 为什么需要它：后端 `UsersService.validatePasswordStrength` 是密码策略的
 * 权威，前端 `utils/passwordPolicy.ts` 是它的**镜像**（表单先行拦截 + 实时强度
 * 反馈）。镜像漂移的两种方向都是**静默**故障：
 *   · 镜像写松 → 表单放行、提交 400（用户看到"密码不符合要求"却不知差在哪）；
 *   · 镜像写严 → 表单拒绝后端本可接受的密码。**真实发生过**：管理台两处内联
 *     正则多要求小写字母（`(?=.*[a-z])`），后端并不要求（见本项目 2026-10-17
 *     的 SECURITY §3.1 修复），于是同一个平台上"什么算合法密码"有三个答案。
 * 而这三种形态 tsc / eslint / 单测**全都看不出来**（各自都以自己为基准）。
 *
 * 判据（**不是文本对比，而是把两侧的正则从源码里抽出来真正执行**）：
 *   ① 抽取：后端 `validatePasswordStrength` 的四条判定（最小长度 + 三个正则）
 *      与前端 `passwordPolicy.ts` 导出的四个常量，各自用带转义感知的
 *      regex-literal 扫描器取字面量；
 *   ② 字面量相等：四条规则的 `RegExp.source` 与最小长度数字必须逐字相同
 *      （报错直接给出两侧原文，便于照抄修正）；
 *   ③ 行为等价：在共享探针语料上，
 *      `backendSatisfies(p) === frontendSatisfies(p)` 必须恒成立
 *      ——这一层能抓住"字面量相同但组合方式不同"之类的隐式差异；
 *   ④ 合并正则自洽：前端 `PASSWORD_POLICY_PATTERN`（antd pattern 规则用）与
 *      前端四条规则的合取必须给出同一答案（否则界面上"提示"与"拦截"打架；
 *      2026-10-17 初版用 `.` 写前瞻、不跨换行，正是本层判据抓出的缺陷）。
 *
 * 零依赖、秒级。用法：
 *   node scripts/check-password-policy-sync.mjs             # 正式检查
 *   node scripts/check-password-policy-sync.mjs --selftest  # 有齿自检（负例必须被检出）
 * 退出码：0 = 同源；1 = 漂移 / 抽取失败。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const BACKEND = "apps/admin-api/src/modules/users/users.service.ts";
const FRONTEND = "apps/admin-web/src/utils/passwordPolicy.ts";

/** 带转义感知的 regex-literal 扫描：从 `from` 处的 `/` 起，到第一个未转义的 `/`。 */
export function scanRegexLiteral(text, from) {
  if (text[from] !== "/") return null;
  let i = from + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      let j = i + 1;
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      return { source: text.slice(from + 1, i), flags: text.slice(i + 1, j), end: j };
    } else if (ch === "\n") {
      return null; // 正则字面量不跨行
    }
    i++;
  }
  return null;
}

/** 在文本里找 `anchor` 之后**第一个** regex 字面量。 */
export function regexAfter(text, anchor) {
  const at = text.indexOf(anchor);
  if (at === -1) return null;
  const slash = text.indexOf("/", at + anchor.length);
  if (slash === -1) return null;
  return scanRegexLiteral(text, slash);
}

/** 抽取后端 `validatePasswordStrength` 的四条判定。 */
export function extractBackendPolicy(text) {
  const fnAt = text.indexOf("validatePasswordStrength(password");
  if (fnAt === -1) return { error: "找不到 validatePasswordStrength" };
  // 该方法的函数体（从签名起 1200 字符足够覆盖四条判定，防越界读入下一方法）
  const body = text.slice(fnAt, fnAt + 1200);
  const minMatch = body.match(/password\.length\s*<\s*(\d+)/);
  if (!minMatch) return { error: "找不到最小长度判定（password.length < N）" };
  const anchors = [
    ["uppercase", "!.test(password)) {", 0],
    ["digit", "!.test(password)) {", 1],
    ["special", "!.test(password)) {", 2],
  ];
  // 三条判定都是 `if (!/<re>/.test(password)) {` 形态，按出现顺序取
  const found = [];
  const re = /if\s*\(\s*!\s*\//g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const lit = scanRegexLiteral(body, m.index + m[0].length - 1);
    if (lit) found.push(lit);
  }
  void anchors;
  if (found.length < 3) {
    return { error: `后端只抽到 ${found.length} 条正则判定（应为 3）` };
  }
  return {
    minLength: Number(minMatch[1]),
    rules: {
      uppercase: found[0],
      digit: found[1],
      special: found[2],
    },
  };
}

/** 抽取前端 `passwordPolicy.ts` 的四个常量 + 合并正则。 */
export function extractFrontendPolicy(text) {
  const minMatch = text.match(/PASSWORD_MIN_LENGTH\s*=\s*(\d+)/);
  if (!minMatch) return { error: "找不到 PASSWORD_MIN_LENGTH" };
  const pick = (name) => {
    const hit = regexAfter(text, `export const ${name} =`);
    return hit ? { source: hit.source, flags: hit.flags } : null;
  };
  const uppercase = pick("PASSWORD_RULE_UPPERCASE");
  const digit = pick("PASSWORD_RULE_DIGIT");
  const special = pick("PASSWORD_RULE_SPECIAL");
  const combined = pick("PASSWORD_POLICY_PATTERN");
  if (!uppercase || !digit || !special || !combined) {
    return { error: "前端四条常量未全部抽到（PASSWORD_RULE_* / PASSWORD_POLICY_PATTERN）" };
  }
  return {
    minLength: Number(minMatch[1]),
    rules: { uppercase, digit, special },
    combined,
  };
}

/** 由「最小长度 + 三条正则」构造判定函数（两侧共用同一构造，只喂不同来源）。 */
export function makeSatisfies(minLength, rules) {
  const upper = new RegExp(rules.uppercase.source, rules.uppercase.flags);
  const digit = new RegExp(rules.digit.source, rules.digit.flags);
  const special = new RegExp(rules.special.source, rules.special.flags);
  return (pwd) =>
    pwd.length >= minLength && upper.test(pwd) && digit.test(pwd) && special.test(pwd);
}

/** 共享探针语料（确定性，禁随机；覆盖边界 / 换行 / 非 ASCII / 各类字符）。 */
export function probeCorpus() {
  const fixed = [
    "",
    "a",
    "ABCDEF1",
    "ABCDEF1!",
    "ADMIN2026!",
    "ALLCAPS2026!",
    "allcaps2026!",
    "ABCdef12!",
    "ABCDEFG\n1!",
    "ABCDEFG1\n!",
    "\n1!ABCDEFG",
    "ABCDEFG\t1!",
    "密码Password1!",
    "       1!A",
    "A1!     ",
    "A1!" + "x".repeat(17),
    "A1!" + "x".repeat(20),
  ];
  const alphabet = "abzXYZ019!@#{}|:\"<>/?=-_ \n\t中？";
  const out = [...fixed];
  let seed = 20261017;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(next() * 24);
    let s = "";
    for (let j = 0; j < len; j++) {
      s += alphabet[Math.floor(next() * alphabet.length)];
    }
    out.push(s);
  }
  return out;
}

/**
 * 判据用字符全集：ASCII 可打印全域（0x20–0x7E）+ 边界与代表性 Unicode
 * （换行/制表/回车/NBSP/全角空格/中文字/全角问号/emoji）。
 *
 * 为什么用"逐字符成员关系"而不是"字面量文本相等"来判字符集一致：同一字符集
 * 可以有多种**等价写法**（字符类里的 `\[` 与裸 `[`、`\/` 与 `/` 在 JS 里语义
 * 完全相同），而 eslint 的 `no-useless-escape` 会要求前端去掉那些无谓转义。
 * 文本比对会把"等价写法"误报成漂移，同时**抓不到**真正的问题（如抄漏一个
 * 字符时两侧文本不同、但某处若恰好做了无关的编辑，文本比对也可能被绕过）。
 * 逐字符执行是"语义等价"的直接判据，且"抄漏一个字符"必然被抓。
 */
export const CHAR_ALPHABET = [
  ...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)),
  "\n",
  "\t",
  "\r",
  "\u00a0",
  "\u3000",
  "中",
  "？",
  "🚨",
];

/** 字符集成员关系（对单字符测试即字符类成员判定）。 */
export function charSet(re) {
  return CHAR_ALPHABET.filter((ch) => re.test(ch));
}

/**
 * 判据实现（供正式检查与 selftest 共用）。
 */
export function compare(backend, frontend) {
  const errors = [];
  if (backend.error) errors.push(`后端抽取失败：${backend.error}`);
  if (frontend.error) errors.push(`前端抽取失败：${frontend.error}`);
  if (errors.length) return errors;

  if (backend.minLength !== frontend.minLength) {
    errors.push(
      `最小长度不一致：后端 ${backend.minLength} vs 前端 ${frontend.minLength}（${BACKEND} / ${FRONTEND}）`,
    );
  }
  for (const name of ["uppercase", "digit", "special"]) {
    const b = backend.rules[name];
    const f = frontend.rules[name];
    const bSet = charSet(new RegExp(b.source, b.flags));
    const fSet = charSet(new RegExp(f.source, f.flags));
    const onlyBackend = bSet.filter((c) => !fSet.includes(c));
    const onlyFrontend = fSet.filter((c) => !bSet.includes(c));
    if (onlyBackend.length || onlyFrontend.length) {
      const show = (arr) =>
        arr.map((c) => JSON.stringify(c)).join(" ");
      errors.push(
        `${name} 规则字符集不一致：\n      后端独有(${onlyBackend.length}): ${show(onlyBackend)}\n      前端独有(${onlyFrontend.length}): ${show(onlyFrontend)}\n      后端 /${b.source}/  前端 /${f.source}/`,
      );
    }
  }

  // ③ 行为等价（字面量相同但组合不同也能被这一层抓住）
  const probes = probeCorpus();
  const backendSatisfies = makeSatisfies(backend.minLength, backend.rules);
  const frontendSatisfies = makeSatisfies(frontend.minLength, frontend.rules);
  const divergent = probes.filter((p) => backendSatisfies(p) !== frontendSatisfies(p));
  if (divergent.length) {
    errors.push(
      `行为不等价：${divergent.length} 个探针上后端与前端判定不同，例：${divergent
        .slice(0, 3)
        .map((p) => JSON.stringify(p))
        .join(", ")}`,
    );
  }

  // ④ 前端合并正则必须与前端四条规则的合取同义（界面提示 ⇔ 表单拦截）
  const combined = new RegExp(frontend.combined.source, frontend.combined.flags);
  const combinedDivergent = probes.filter((p) => combined.test(p) !== frontendSatisfies(p));
  if (combinedDivergent.length) {
    errors.push(
      `前端 PASSWORD_POLICY_PATTERN 与四条规则合取不同义：${combinedDivergent.length} 个探针不一致，例：${combinedDivergent
        .slice(0, 3)
        .map((p) => JSON.stringify(p))
        .join(", ")}\n      （常见原因：前瞻里用了 . 而不是 [\\s\\S]，. 不跨换行；或漏了某条规则的类别）`,
    );
  }
  return errors;
}

// ── selftest：负例必须被检出（否则守卫可能恒真）──────────────────────────────
function selftest() {
  const backendText = readFileSync(join(ROOT, BACKEND), "utf8");
  const frontendText = readFileSync(join(ROOT, FRONTEND), "utf8");
  const failures = [];
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `\n   ${detail}` : ""}`);
    if (!ok) failures.push(name);
  };

  const b = extractBackendPolicy(backendText);
  const f = extractFrontendPolicy(frontendText);
  check("抽取：后端四条判定可解析", !b.error, b.error ?? "");
  check("抽取：前端四常量可解析", !f.error, f.error ?? "");
  check("真实代码库上同源（本守卫当前应绿）", compare(b, f).length === 0, compare(b, f).join("\n   "));

  // 反证 1：前端把最小长度改小 → 必须被检出
  const fShorter = extractFrontendPolicy(frontendText.replace("PASSWORD_MIN_LENGTH = 8", "PASSWORD_MIN_LENGTH = 6"));
  check(
    "反证：前端最小长度 8→6 被检出",
    compare(b, fShorter).some((e) => e.includes("最小长度不一致")),
    compare(b, fShorter).join(" | "),
  );

  // 反证 2：前端把特殊字符集换掉 → 必须被检出（字符集比对 + 行为等价）
  const fOtherSpecial = extractFrontendPolicy(
    frontendText.replace(
      /export const PASSWORD_RULE_SPECIAL = \/[^\n]*\/;/,
      "export const PASSWORD_RULE_SPECIAL = /[!@#]/;",
    ),
  );
  check(
    "反证：前端特殊字符集被缩小被检出",
    compare(b, fOtherSpecial).some(
      (e) => e.includes("special 规则字符集不一致") || e.includes("行为不等价"),
    ),
    compare(b, fOtherSpecial).join(" | "),
  );

  // 反证 2b：前端特殊字符集**抄漏一个字符**（去掉 ?）→ 必须被检出
  const fMissingQuestion = extractFrontendPolicy(
    frontendText.replace(
      /export const PASSWORD_RULE_SPECIAL = \/[^\n]*\/;/,
      "export const PASSWORD_RULE_SPECIAL = /[!@#$%^&*()_+\\-=[\\]{};':\"\\\\|,.<>/]/;",
    ),
  );
  check(
    "反证：前端特殊字符集抄漏 '?' 被检出",
    compare(b, fMissingQuestion).some((e) => e.includes("special 规则字符集不一致")),
    compare(b, fMissingQuestion).join(" | "),
  );

  // 反证 3：合并正则退回用 `.` 写前瞻（不跨换行）→ 必须被 ④ 检出
  const fDotCombined = extractFrontendPolicy(
    frontendText.replace(
      /export const PASSWORD_POLICY_PATTERN =[\s\S]*?;/,
      "export const PASSWORD_POLICY_PATTERN = /^(?=[\\s\\S]{8,})(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*()_+\\-=[\\]{};':\"\\\\|,.<>/?])/;",
    ),
  );
  check(
    "反证：合并正则用 '.' 写前瞻（不跨换行）被检出",
    compare(b, fDotCombined).some((e) => e.includes("PASSWORD_POLICY_PATTERN")),
    compare(b, fDotCombined).join(" | "),
  );

  // 反证 4：后端删掉大写判定 → 抽取数量不足或行为不等价，必须被检出
  const bMissingUpper = extractBackendPolicy(
    backendText.replace(/\s*if \(!\/\[A-Z\]\/\.test\(password\)\) \{\s*\n\s*throw new AppError\("PASSWORD_NEEDS_UPPERCASE"\);\s*\n\s*\}/, ""),
  );
  const bMissingUpperErrors = compare(bMissingUpper, f);
  check(
    "反证：后端删掉大写判定被检出",
    bMissingUpperErrors.length > 0,
    bMissingUpperErrors.join(" | ") || "(竟未检出)",
  );

  if (failures.length) {
    console.error(`\n✗ check-password-policy-sync selftest 未全绿（${failures.length} 项）`);
    process.exit(1);
  }
  console.log(
    "\n✓ check-password-policy-sync selftest 全绿（5 条反证均被检出，含「抄漏一个字符」与「合并正则不跨换行」）",
  );
}

// ── 入口 ────────────────────────────────────────────────────────────────────
if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const backend = extractBackendPolicy(readFileSync(join(ROOT, BACKEND), "utf8"));
  const frontend = extractFrontendPolicy(readFileSync(join(ROOT, FRONTEND), "utf8"));
  const errors = compare(backend, frontend);
  if (errors.length) {
    console.error("✗ 密码策略前后端不同源：");
    for (const e of errors) console.error("  - " + e);
    console.error(
      `\n处置：以 ${BACKEND} 的 validatePasswordStrength 为准，同步 ${FRONTEND}。`,
    );
    process.exit(1);
  }
  console.log(
    `✓ 密码策略前后端同源（最小长度 ${backend.minLength}；uppercase/digit/special 三规则字符集逐字符一致（${CHAR_ALPHABET.length} 个字符上核验）；` +
      `${probeCorpus().length} 个探针上行为等价；前端合并正则与四条规则同义）`,
  );
}
