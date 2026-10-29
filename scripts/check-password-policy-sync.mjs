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
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **事实源缺失 = 崩栈**：后端/前端文件不在时旧实现直接 `readFileSync` 抛
 *     ENOENT，CI 日志是一段 stack；`--selftest` 更是**必然**崩（它无条件读真仓库
 *     的两个文件）。现在缺失 → **结构红**并点名路径，退出码 1。
 *   · **抽取失败与真漂移混在同一个 `errors` 数组里**：旧 `compare()` 把
 *     "找不到 validatePasswordStrength"/"只抽到 2 条正则" 和 "最小长度不一致"
 *     并排报成"漂移"，于是「判据瞎了」与「代码真漂移」在日志里长得一样，处置动作
 *     却相反（前者改判据，后者改代码）。现在 `structure` 与 `errors` 分开。
 *   · **规则字符集为空 = 该规则恒不命中却报绿**：若某侧写成 `/(?!)/`、
 *     `/[^\s\S]/`（匹配不到任何字符），这条规则实际是死的（等于无条件通过），
 *     而两侧只要"死得一样"就全绿——判据静默失效。现在字符集为空 = 结构红。
 *   · **`g`/`y` 标志让逐字符/逐探针判定变成有状态**：`charSet` 与
 *     `makeSatisfies` 对同一个 RegExp 反复 `test`，带 `g`/`y` 时 `lastIndex`
 *     会推进，同一份正则在 103 个字符/517 个探针上给出**交替结果**，两侧可能
 *     「碰巧一致」而全绿（也可能噪声红）。现在统一在编译时剥掉 `g`/`y`。
 *   · **只数条数/函数级断言**：旧 selftest 断言 `compare(b, f).length === 0`
 *     之类的内存性质——把 CLI 末尾的 `process.exit(1)` 删掉照样全绿（闸不关门）。
 *     现在跑**真子进程**，逐条断言退出码 + 关键文本（11 条，含 5 条反证）。
 *   · **`--root` 缺失 + import 有副作用**：旧实现根目录钉死、文件末尾无条件
 *     执行正式检查，任何 import 都会**顺带跑一遍守卫并可能 process.exit**。
 *     现在路径相对 `root`，且只在被直接调用时执行。
 *
 * 零依赖、秒级。用法：
 *   node scripts/check-password-policy-sync.mjs                  # 正式检查
 *   node scripts/check-password-policy-sync.mjs --selftest       # 有齿自检（负例必须被检出）
 *   node scripts/check-password-policy-sync.mjs --root <dir>     # 把该目录当仓库根（selftest 专用）
 * 退出码：0 = 同源；1 = 漂移 / **判据本身不可信**（事实源缺失、抽取失败、规则集塌方）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectExit, makeFixtureRepo, reportCases, runGuard } from './lib/guard-selftest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根（由脚本位置推出，不依赖调用方 cwd）。 */
export const DEFAULT_ROOT = resolve(HERE, '..');

export const BACKEND = 'apps/admin-api/src/modules/users/users.service.ts';
export const FRONTEND = 'apps/admin-web/src/utils/passwordPolicy.ts';

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
  // 三条判定都是 `if (!/<re>/.test(password)) {` 形态，按出现顺序取
  const found = [];
  const re = /if\s*\(\s*!\s*\//g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const lit = scanRegexLiteral(body, m.index + m[0].length - 1);
    if (lit) found.push(lit);
  }
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

/**
 * 编译抽取到 ({source, flags}) 的正则，**剥掉 `g`/`y`**。
 *
 * 这两枚标志让 `test` 变成有状态操作（`lastIndex` 推进）：同一份正则在
 * 逐字符（`charSet`）与逐探针（`makeSatisfies`/合并正则）判定里会给出交替结果，
 * 两侧可能「碰巧一致」→ 判据静默失效。密码规则只关心"是否命中"，不需要 `g`/`y`。
 */
function compile(lit) {
  return new RegExp(lit.source, String(lit.flags ?? '').replace(/[gy]/g, ''));
}

/** 由「最小长度 + 三条正则」构造判定函数（两侧共用同一构造，只喂不同来源）。 */
export function makeSatisfies(minLength, rules) {
  const upper = compile(rules.uppercase);
  const digit = compile(rules.digit);
  const special = compile(rules.special);
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

/** 字符集成员关系（对单字符测试即字符类成员判定）。`g`/`y` 一律剥掉，见 compile()。 */
export function charSet(re) {
  const clean = new RegExp(re.source, String(re.flags ?? '').replace(/[gy]/g, ''));
  return CHAR_ALPHABET.filter((ch) => clean.test(ch));
}

/**
 * 语义层判据（**已抽取成功后**才有意义）：返回漂移描述数组。
 *
 * 抽取失败不在这里报——那是"判据不可信"（结构错），由 `check()` 分流。
 */
export function compare(backend, frontend) {
  const errors = [];

  if (backend.minLength !== frontend.minLength) {
    errors.push(
      `最小长度不一致：后端 ${backend.minLength} vs 前端 ${frontend.minLength}（${BACKEND} / ${FRONTEND}）`,
    );
  }
  for (const name of ['uppercase', 'digit', 'special']) {
    const b = backend.rules[name];
    const f = frontend.rules[name];
    const bSet = charSet(compile(b));
    const fSet = charSet(compile(f));
    const onlyBackend = bSet.filter((c) => !fSet.includes(c));
    const onlyFrontend = fSet.filter((c) => !bSet.includes(c));
    if (onlyBackend.length || onlyFrontend.length) {
      const show = (arr) => arr.map((c) => JSON.stringify(c)).join(' ');
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
        .join(', ')}`,
    );
  }

  // ④ 前端合并正则必须与前端四条规则的合取同义（界面提示 ⇔ 表单拦截）
  const combined = compile(frontend.combined);
  const combinedDivergent = probes.filter((p) => combined.test(p) !== frontendSatisfies(p));
  if (combinedDivergent.length) {
    errors.push(
      `前端 PASSWORD_POLICY_PATTERN 与四条规则合取不同义：${combinedDivergent.length} 个探针不一致，例：${combinedDivergent
        .slice(0, 3)
        .map((p) => JSON.stringify(p))
        .join(', ')}\n      （常见原因：前瞻里用了 . 而不是 [\\s\\S]，. 不跨换行；或漏了某条规则的类别）`,
    );
  }
  return errors;
}

/**
 * 全量判据。
 *
 * @param {string} [root] 仓库根
 * @returns {{errors: string[], structure: string[], stats: {backend: object|null, frontend: object|null}}}
 *   `errors` = 真实漂移；`structure` = **判据本身不可信**（事实源缺失、抽取失败、规则集塌方）。
 */
export function check(root = DEFAULT_ROOT) {
  const errors = [];
  const structure = [];

  /** @type {any} */
  let backend = null;
  /** @type {any} */
  let frontend = null;

  for (const [label, rel] of [
    ['后端', BACKEND],
    ['前端', FRONTEND],
  ]) {
    if (!existsSync(join(root, rel))) {
      structure.push(
        `事实源缺失：${rel} —— ${label}策略不在，判据无从比对（路径改名/文件没生成都会这样，不是「同源」）。`,
      );
    }
  }

  if (structure.length === 0) {
    backend = extractBackendPolicy(readFileSync(join(root, BACKEND), 'utf8'));
    frontend = extractFrontendPolicy(readFileSync(join(root, FRONTEND), 'utf8'));
    if (backend?.error) structure.push(`后端抽取失败：${backend.error}（${BACKEND}）`);
    if (frontend?.error) structure.push(`前端抽取失败：${frontend.error}（${FRONTEND}）`);
  }

  // 规则集塌方：某条规则匹配不到任何字符 ⇒ 该规则恒不命中（等于无条件通过）。
  if (structure.length === 0) {
    for (const name of ['uppercase', 'digit', 'special']) {
      const bSet = charSet(compile(backend.rules[name]));
      if (bSet.length === 0) {
        structure.push(
          `uppercase/digit/special 之 ${name}：后端 /${backend.rules[name].source}/ 命中 0 个字符 —— 该规则恒不命中（= 无条件通过），判据失效。`,
        );
      }
      const fSet = charSet(compile(frontend.rules[name]));
      if (fSet.length === 0) {
        structure.push(
          `uppercase/digit/special 之 ${name}：前端 /${frontend.rules[name].source}/ 命中 0 个字符 —— 该规则恒不命中（= 无条件通过），判据失效。`,
        );
      }
    }
  }

  if (structure.length === 0) errors.push(...compare(backend, frontend));

  return { errors, structure, stats: { backend, frontend } };
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/**
 * 合规的后端 fixture：与真仓库同构（最小长度 + 三条 `if (!/<re>/…)` 判定）。
 * 字符集与真实代码逐字一致（`[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]`）。
 */
const BACKEND_OK = `export class UsersService {
  private validatePasswordStrength(password: string): void {
    if (!password || password.length < 8) {
      throw new AppError("PASSWORD_TOO_SHORT");
    }
    if (!/[A-Z]/.test(password)) {
      throw new AppError("PASSWORD_NEEDS_UPPERCASE");
    }
    if (!/[0-9]/.test(password)) {
      throw new AppError("PASSWORD_NEEDS_DIGIT");
    }
    if (!/[!@#$%^&*()_+\\-=\\[\\]{};':"\\\\|,.<>\\/?]/.test(password)) {
      throw new AppError("PASSWORD_NEEDS_SPECIAL");
    }
  }
}
`;

/** 合规的前端 fixture（同一字符集的无谓转义已按 eslint no-useless-escape 去掉）。 */
const FRONTEND_OK = `export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_RULE_UPPERCASE = /[A-Z]/;
export const PASSWORD_RULE_DIGIT = /[0-9]/;
export const PASSWORD_RULE_SPECIAL = /[!@#$%^&*()_+\\-=[\\]{};':"\\\\|,.<>\\/?]/;

export const PASSWORD_POLICY_PATTERN =
  /^(?=[\\s\\S]{8,})(?=[\\s\\S]*[A-Z])(?=[\\s\\S]*[0-9])(?=[\\s\\S]*[!@#$%^&*()_+\\-=[\\]{};':"\\\\|,.<>\\/?])/;
`;

/**
 * 与 FRONTEND_OK 逐字相同、但四条正则都带 `g` 标志。
 *
 * `g`/`y` 让 `test()` 走 `lastIndex`（有状态）：同一份正则逐字符/逐探针反复 test
 * 会给出**交替**结果，两侧可能「碰巧一致」而假绿（或噪声红）。`compile()` 剥掉
 * 这两枚标志后，本 fixture 必须判「同源」——这也是判据本身的一条反证。
 */
const FRONTEND_GLOBAL = `export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_RULE_UPPERCASE = /[A-Z]/g;
export const PASSWORD_RULE_DIGIT = /[0-9]/g;
export const PASSWORD_RULE_SPECIAL = /[!@#$%^&*()_+\\-=[\\]{};':"\\\\|,.<>\\/?]/g;

export const PASSWORD_POLICY_PATTERN =
  /^(?=[\\s\\S]{8,})(?=[\\s\\S]*[A-Z])(?=[\\s\\S]*[0-9])(?=[\\s\\S]*[!@#$%^&*()_+\\-=[\\]{};':"\\\\|,.<>\\/?])/g;
`;

const tree = ({ backend = BACKEND_OK, frontend = FRONTEND_OK } = {}) => {
  const files = { 'package.json': { name: 'fixture', private: true } };
  if (backend !== null) files[BACKEND] = backend;
  if (frontend !== null) files[FRONTEND] = frontend;
  return files;
};

/** 自检：11 条子进程用例（每条断言退出码 + 关键文本 + <1s）。 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: 'password-policy-selftest-' });
        try {
          expectExit(runGuard(SELF, { args: ['--root', repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess('① 合规树：四条规则与后端同源 → 绿（正例控制组）', tree(), {
    code: 0,
    contains: ['✓ 密码策略前后端同源', '最小长度 8', '517 个探针上行为等价'],
    absent: ['✗ 密码策略前后端不同源', '结构错误'],
  });

  subprocess(
    '② 【反证·判据②】前端最小长度 8→6 → 红（点名字段，不是笼统「不同源」）',
    tree({ frontend: FRONTEND_OK.replace('PASSWORD_MIN_LENGTH = 8', 'PASSWORD_MIN_LENGTH = 6') }),
    {
      code: 1,
      contains: ['最小长度不一致：后端 8 vs 前端 6', '✗ 密码策略前后端不同源'],
      absent: ['✓ 密码策略前后端同源'],
    },
  );

  subprocess(
    '③ 【反证·判据②】前端特殊字符集抄漏 "?" → 红（逐字符核验，不是文本比对）',
    tree({
      frontend: FRONTEND_OK.replace(
        /PASSWORD_RULE_SPECIAL = [^\n]*/,
        'PASSWORD_RULE_SPECIAL = /[!@#$%^&*()_+\\-=[\\]{};\':"\\\\|,.<>\\/]/;',
      ),
    }),
    {
      code: 1,
      contains: ['special 规则字符集不一致', '前端独有(0)'],
      absent: ['✓ 密码策略前后端同源'],
    },
  );

  subprocess(
    '④ 【反证·判据④】合并正则退回用 "." 写前瞻（不跨换行）→ 红',
    tree({
      frontend: FRONTEND_OK.replace(
        /PASSWORD_POLICY_PATTERN =[\s\S]*?;/,
        'PASSWORD_POLICY_PATTERN =\n  /^(?=[\\s\\S]{8,})(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*()_+\\-=[\\]{};\':"\\\\|,.<>\\/?])/;',
      ),
    }),
    {
      code: 1,
      contains: ['PASSWORD_POLICY_PATTERN 与四条规则合取不同义'],
      absent: ['✓ 密码策略前后端同源'],
    },
  );

  subprocess(
    '⑤ 【反证·结构红】后端删掉大写判定 → 结构红（抽取不足 ≠ 漂移）',
    tree({
      backend: BACKEND_OK.replace(
        /\s*if \(!\/\[A-Z\]\/\.test\(password\)\) \{\s*\n\s*throw new AppError\("PASSWORD_NEEDS_UPPERCASE"\);\s*\n\s*\}/,
        '',
      ),
    }),
    {
      code: 1,
      contains: ['结构错误', '后端只抽到 2 条正则判定（应为 3）'],
      absent: ['✗ 密码策略前后端不同源'],
    },
  );

  subprocess(
    '⑥ 【反证·结构红】前端常量改名（DIGIT→NUMBER）→ 结构红（抽取不到 = 判据瞎了）',
    tree({ frontend: FRONTEND_OK.replace('PASSWORD_RULE_DIGIT', 'PASSWORD_RULE_NUMBER') }),
    {
      code: 1,
      contains: ['结构错误', '前端四条常量未全部抽到'],
      absent: ['✓ 密码策略前后端同源'],
    },
  );

  subprocess(
    '⑦ 【反证·结构红】某侧规则恒不命中（字符集为空）→ 结构红，不许"两侧一样死"就算同源',
    tree({
      frontend: FRONTEND_OK.replace(
        /PASSWORD_RULE_UPPERCASE = [^\n]*/,
        'PASSWORD_RULE_UPPERCASE = /[^\\s\\S]/;',
      ),
    }),
    {
      code: 1,
      contains: ['结构错误', '命中 0 个字符'],
      absent: ['✓ 密码策略前后端同源'],
    },
  );

  subprocess(
    '⑧ 事实源缺失（后端 users.service.ts 不在）→ 结构红并点名路径，不是崩栈',
    tree({ backend: null }),
    {
      code: 1,
      contains: ['结构错误', `事实源缺失：${BACKEND}`],
      absent: ['✓ 密码策略前后端同源', 'Error:', 'ENOENT'],
    },
  );

  subprocess(
    '⑨ 事实源缺失（前端 passwordPolicy.ts 不在）→ 结构红并点名路径',
    tree({ frontend: null }),
    {
      code: 1,
      contains: ['结构错误', `事实源缺失：${FRONTEND}`],
      absent: ['✓ 密码策略前后端同源', 'Error:', 'ENOENT'],
    },
  );

  subprocess(
    '⑩ 【反证·结构红】后端侧规则恒不命中（`/[^\\s\\S]/`）→ 结构红（后端分支同样有牙）',
    tree({ backend: BACKEND_OK.replace('/[A-Z]/.test(password)', '/[^\\s\\S]/.test(password)') }),
    {
      code: 1,
      contains: ['结构错误', '后端 /[^\\s\\S]/ 命中 0 个字符'],
      absent: ['✓ 密码策略前后端同源'],
    },
  );

  subprocess(
    '⑪ 【反证·有状态正则】四条规则都带 g 标志 → 剥掉后仍判同源（g/y 会让逐字符判定交替）',
    tree({ frontend: FRONTEND_GLOBAL }),
    {
      code: 0,
      contains: ['✓ 密码策略前后端同源'],
      absent: ['字符集不一致', '结构错误'],
    },
  );

  const failed = reportCases(cases, { title: 'check-password-policy-sync selftest' });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, '/').split('/').pop();

if (invoked === 'check-password-policy-sync.mjs') {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    const rootArg = argValue(process.argv, '--root');
    const { errors, structure, stats } = check(rootArg ? resolve(rootArg) : DEFAULT_ROOT);

    if (structure.length > 0) {
      console.error('');
      console.error('✗ 密码策略守卫结构错误（判据本身不可信，先修事实源/抽取口径）：');
      for (const e of structure) console.error('  · ' + e);
      console.error('');
      process.exit(1);
    }

    if (errors.length) {
      console.error('✗ 密码策略前后端不同源：');
      for (const e of errors) console.error('  - ' + e);
      console.error(
        `\n处置：以 ${BACKEND} 的 validatePasswordStrength 为准，同步 ${FRONTEND}。`,
      );
      process.exit(1);
    }
    console.log(
      `✓ 密码策略前后端同源（最小长度 ${stats.backend.minLength}；uppercase/digit/special 三规则字符集逐字符一致（${CHAR_ALPHABET.length} 个字符上核验）；` +
        `${probeCorpus().length} 个探针上行为等价；前端合并正则与四条规则同义）`,
    );
  }
}
