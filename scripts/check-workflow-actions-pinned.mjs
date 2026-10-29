#!/usr/bin/env node
/**
 * CIR-05（第 3 轮审计）：workflow 里的第三方 action 必须固定到 **40 位 commit SHA**。
 *
 * 为什么这是供应链问题而不是风格问题：`uses: actions/checkout@v4` 里的 `v4` 是一个
 * **可变引用**。上游可以随时把 tag 指到另一个 commit（发布流程事故、维护者账号被盗、
 * 仓库被转让/接管都会发生），而 CI 这边**没有任何代码变更**——下一次 push 触发的
 * job 就执行了另一份代码。这些 job 里恰好都有 `secrets.*` 与 `GITHUB_TOKEN`
 * （发布、PyPI、Pages、docker push 全在内），所以「tag 被移动」等价于「任意上游可写者
 * 获得本仓的发布凭据」。SHA 是内容寻址的，指到哪就是哪，因此不可漂移。
 *
 * 判据（逐行扫 `.github/workflows/*.yml|*.yaml` 与 `.github/actions/**`）：
 *   每个 `uses:` 的取值必须是以下三者之一——
 *     ① `./relative/path`   —— 本仓内的 composite action，随 commit 一起版本化；
 *     ② `docker://image[:tag|@digest]` —— 不是 git 引用，不在本判据内；
 *     ③ `<owner>/<repo>[@<subdir>]@<40 位 hex>` —— 固定 SHA（后面可带 `# 原 ref` 注释）。
 *   其余一律红：tag（`@v4`）、分支（`@main`）、短 SHA（`@3d3c42e`，7 位够被撞/
 *   被前缀猜测，且不可校验完整性）、干脆没有 `@ref`。
 *
 * 两条反漂移判据（防「固定了但固定歪了」）：
 *   ① 同一 action 在仓内出现**两个不同 SHA** → warn 列出。典型来源是两个人各自
 *      `gh api` 取了一次（或一次取 tag、一次取 branch），于是同一版本被固定成两个
 *      值：CI 仍然绿、供应链仍然「固定」，但审计时无法回答「我们到底跑的是哪个
 *      checkout」。这是**告警不判红**——多 SHA 本身可能是刻意的（灰度升级）。
 *   ② `pull_request_target` 出现在任何 workflow → 红，除非该处（同行或前 3 行）
 *      有 `# allow-prt: <理由>` 注释。这个事件在**基分支上下文**里跑、且默认能读
 *      secrets，与 `pull_request` 只差一个后缀却是「fork PR 直接拿到写权限」的经典
 *      提权面；它有时确实必需（打标签、评论），所以不做一刀切，而是要求**显式
 *      人工确认并留理由**。
 *
 * 解析方式：**逐行正则，不引 YAML 依赖**。理由有二——① 本仓装不起新依赖也刻意不装；
 * ② 判据要报 `file:line`，而 YAML 解析器会把行列信息丢在 node 里（没有 yaml 包）。
 * 代价是必须自己剥注释：`# uses: foo@v1` 只是说明文字，不是引用；反过来行尾的
 * `# v4` 是对的（保留原 ref 便于升级），不能因为它红。
 * 已知边界：`run: |` 块里若**恰好**写着形如 `uses: x@y` 的文本行会被误扫——本仓
 * 无此形态（106 处 uses 全为真实引用），若未来出现，请改成变量拼接或加缩进前缀。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **只测函数，不测闸门（最贵的一条）**：旧 `--selftest` 把 `checkFiles()` 当纯函数
 *     喂内存 YAML，断言 `errors.length === wantErrors`——把 CLI 末尾的 `process.exit(1)`
 *     删掉、或让 `collectTargets()` 永远返回空数组，`--selftest` 照样「14 条夹具 +
 *     6 条元断言」全绿。**报告在说话，闸不关门**。现在每条用例跑**真子进程**
 *     （`--root` 指向临时 fixture 树），断言退出码 + 关键报错文本。
 *   · **只数条数**：`errors.length` 无法区分「tag 被抓」与「反正有条错」。旧写法下
 *     只要让 tag 那条永远报红，短 SHA / 缺 @ref / pull_request_target 三类反例**全部
 *     通过**。现在每条用例点名**具体文案**（`短 SHA（7 位）` / `缺少 @ref` /
 *     `pull_request_target 需要人工确认`）+ 文件:行。
 *   · **`readdirSync` / `readFileSync` 静默 catch**：旧 `checkFiles()` 是
 *     `catch { continue; }`——某个 workflow 读不出来（权限、被换成目录、编码坏）时，
 *     它的 uses **一个都不进判据**，于是「0 处未固定」= 假绿。现在读失败 → **结构红**
 *     （`事实源不可读`），且「扫到 0 处 uses」也不再是「全部已固定」（见下）。
 *   · **扫描面塌方 = 永真绿**：旧 CLI 只在 `files.length === 0` 时红。若
 *     `.github/actions/**` 没被收进来（历史上正是这条：`walk(ACTIONS_DIR)` 用了相对
 *     常量，只有 cwd 恰好是仓库根时才碰巧能用），或 uses 正则因 YAML 风格变化匹配不到
 *     任何东西（`total === 0`），判据都是空的却报绿。现在两者都是**结构红**，
 *     并带扫描面下界 `MIN_USES`。
 *   · **`--root` 缺失 + 路径钉死 `process.cwd()`**：旧 `collectTargets()` 默认读
 *     `process.cwd()`，selftest 只能对内存字符串断言，**守卫在别的 cwd 下还扫不扫得到
 *     从未被验证**。现在默认根由脚本位置推出（`DEFAULT_ROOT`），`--root` 可覆盖。
 *   · **注释算数**：`# uses: actions/checkout@v4` 是说明文字不是引用。旧 selftest 只
 *     断言「0 err」，无法证明是「注释被剥」还是「整行没被解析」——现在同时断言
 *     `1 处 uses`（计数面）与 `0 err`（判据面），两者一起才叫真绿。
 *
 * 用法：
 *   node scripts/check-workflow-actions-pinned.mjs                # 扫本仓
 *   node scripts/check-workflow-actions-pinned.mjs --selftest     # 只验判据本身（真子进程）
 *   node scripts/check-workflow-actions-pinned.mjs --root <dir>   # 把该目录当仓库根（selftest 专用）
 * 退出码：0 = 全部已固定（可能有 warn）；1 = 有未固定引用 / 未声明的 pull_request_target，
 *         **或判据本身不可信**（扫描面为空 / 事实源不可读）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = resolve(HERE, "..");

const WORKFLOWS_DIR = ".github/workflows";
const ACTIONS_DIR = ".github/actions";

/**
 * 扫描面下界：至少要解析出 1 处 `uses`。
 *
 * 取 1 而不是历史规模（106）：这条钉的是「正则还能不能从 YAML 里读出引用」，
 * 不是「引用有几处」。`total === 0` 时本守卫**一处都没判**，此时报绿等于
 * 把「正则失配」伪装成「全部已固定」——宁可红。
 */
export const MIN_USES = 1;

/**
 * 解析不到 SHA 的 action 的显式豁免（键：`owner/repo@ref`，值：**理由** + 复查日）。
 *
 * 纪律：解析不到时**绝不猜 SHA**——猜出来的 SHA 指向未知代码，比 tag 更糟（tag 至少
 * 是「上游当时的意图」，猜的 SHA 是我们自己编的）。正确处理是：保留原样 + 在这里
 * 登记 + 在报告里列出，让「有未固定项」始终可见，而不是让它静默通过。
 *
 * 当前为空：本仓 12 个 distinct action 全部解析成功（gh 2.100.0 / `gh api ... --jq .sha`）。
 */
const ALLOWED_UNPINNED = {
  // "owner/repo@v1": "私有 action，gh api 无权限（404）；需改用 docker:// 或 vendor 进本仓 —— 复查 2026-12-31",
};

const SHA_RE = /^[0-9a-fA-F]{40}$/;
/** owner/repo 或 owner/repo/sub/dir（composite action 可带子目录），后接 @ref */
const REMOTE_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@(.+)$/;
const HEXISH_RE = /^[0-9a-fA-F]{4,39}$/;

/**
 * 把一行拆成「代码部分」与「注释部分」。
 * 只在 `#` 前是行首或空白、且不在引号内时才算注释（`"a#b"` 不是注释）。
 */
export function splitCode(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
  }
  return { code: line, comment: "" };
}

/** 判断一个 uses 值是否合规；返回 null 表示绿，否则返回「为什么红 + 怎么修」 */
function judgeUse(value) {
  if (value.startsWith("./") || value === ".") return null;
  if (value.startsWith("docker://")) return null;

  const m = REMOTE_RE.exec(value);
  if (!m) {
    if (!value.includes("@")) {
      return {
        kind: "missing-ref",
        why: "缺少 @ref（不可固定到任何 commit）",
        fix: `补成 ${value}@<40位SHA> # <原ref>`,
      };
    }
    return {
      kind: "malformed",
      why: "不是 owner/repo@ref 形态",
      fix: "写成 uses: <owner>/<repo>@<40位SHA> # <原ref>",
    };
  }

  const [, action, ref] = m;
  if (SHA_RE.test(ref)) return null;

  if (HEXISH_RE.test(ref)) {
    return {
      kind: "short-sha",
      why: `短 SHA（${ref.length} 位）—— 无法校验完整性，且前缀可被碰撞/猜测`,
      fix: `展开成 40 位：gh api repos/${action}/commits/${ref} --jq .sha`,
    };
  }

  return {
    kind: "tag-or-branch",
    why: `可变引用（tag/branch \`${ref}\`）—— 上游可移动它，CI 会在无代码变更时执行不同代码`,
    fix: `gh api repos/${action}/commits/${ref} --jq .sha → uses: ${action}@<40位SHA> # ${ref}`,
  };
}

/**
 * 扫描若干文件的内容（注入 reader，便于 selftest 不落盘）。
 *
 * ⚠️ 读不出来**不许静默跳过**：旧实现是 `catch { continue; }`，某个 workflow 因权限/
 * 被换成目录/编码坏而读不到时，它的 uses 全部消失，于是「0 处未固定」——判据在说话，
 * 但它没看过那个文件。现在收进 `unreadable`，由调用方升级为**结构红**。
 *
 * @param {string[]} files 展示用路径
 * @param {(f: string) => string} read
 */
export function checkFiles(files, read) {
  const errors = [];
  const warnings = [];
  const unreadable = [];
  /** @type {Map<string, Map<string, string[]>>} action(lower) -> sha(lower) -> [loc] */
  const seen = new Map();
  const stats = { total: 0, pinned: 0, local: 0, docker: 0, allowed: 0 };

  for (const file of files) {
    let text;
    try {
      text = read(file);
    } catch (error) {
      unreadable.push(`${file} 读不出来（${error?.code ?? error?.message ?? "unknown"}）`);
      continue;
    }
    const lines = text.split(/\r?\n/);
    // 文件级「近期注释」窗口：allow-prt 允许写在该键上方几行
    for (let i = 0; i < lines.length; i++) {
      const { code, comment } = splitCode(lines[i]);
      const lineNo = i + 1;

      // ── 判据 ②：pull_request_target 需人工确认 ──────────────────────────
      if (/^\s*(?:-\s+)?pull_request_target\s*:/.test(code)) {
        const window = [
          comment,
          ...lines.slice(Math.max(0, i - 3), i).map((l) => splitCode(l).comment),
        ].join("\n");
        const allow = /#\s*allow-prt\b[:\s-]*(.*)/.exec(window);
        const reason = allow ? allow[1].trim() : "";
        if (!allow) {
          errors.push(
            `${file}:${lineNo} pull_request_target 需要人工确认 —— 它在基分支上下文运行且可读 secrets，fork PR 因此可能直接拿到写权限；确实需要时在该键同行或上方 3 行内加 \`# allow-prt: <理由>\``,
          );
        } else if (reason.length < 8) {
          errors.push(
            `${file}:${lineNo} pull_request_target 的 \`# allow-prt\` 缺少理由（需 ≥8 字符说明为何非它不可）`,
          );
        }
        continue;
      }

      // ── 判据 ①：每个 uses 必须固定 ─────────────────────────────────────
      const m = /^\s*(?:-\s+)?uses\s*:\s*(.*?)\s*$/.exec(code);
      if (!m) continue;
      let value = m[1].trim();
      if (!value) continue;
      // 去掉 YAML 引号
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1).trim();
      }
      // 行内注释粘在取值后面的情形（`uses: a/b@sha # v1` 且 stripCode 已切开 → 不会到这里；
      // 但仍兜一层：空白后跟 # 截断）
      value = value.split(/\s+#/)[0].trim();
      if (!value) continue;

      stats.total += 1;
      const loc = `${file}:${lineNo}`;

      if (ALLOWED_UNPINNED[value]) {
        stats.allowed += 1;
        continue;
      }

      const verdict = judgeUse(value);
      if (verdict) {
        errors.push(`${loc} ${value} —— ${verdict.why}；修法：${verdict.fix}`);
        continue;
      }

      if (value.startsWith("./") || value === ".") {
        stats.local += 1;
        continue;
      }
      if (value.startsWith("docker://")) {
        stats.docker += 1;
        continue;
      }

      stats.pinned += 1;
      const [, action, ref] = REMOTE_RE.exec(value);
      const key = action.toLowerCase();
      if (!seen.has(key)) seen.set(key, new Map());
      const bySha = seen.get(key);
      const sha = ref.toLowerCase();
      if (!bySha.has(sha)) bySha.set(sha, []);
      bySha.get(sha).push(loc);
    }
  }

  // ── 反漂移 ①：同一 action 被固定成多个 SHA ────────────────────────────
  for (const [action, bySha] of seen) {
    if (bySha.size < 2) continue;
    const detail = [...bySha.entries()]
      .map(([sha, locs]) => `${sha.slice(0, 8)}… @ ${locs[0]}${locs.length > 1 ? ` (+${locs.length - 1})` : ""}`)
      .join("；");
    warnings.push(
      `${action} 在本仓被固定成 ${bySha.size} 个不同 SHA（${detail}）—— 同一版本出现多值通常意味着各自解析了一次（tag vs branch），审计时无法回答「实际跑的是哪个」；确认是否刻意灰度，否则统一`,
    );
  }

  return { errors, warnings, unreadable, stats, seen };
}

/** 收集扫描面：workflow 文件 + 仓库内 composite action 定义 */
export function collectTargets(root = DEFAULT_ROOT) {
  const out = [];
  // 归一化：尾随分隔符会让下面的 slice(root.length) 差一位（root 可传绝对路径）
  const base = root.replace(/[/\\]+$/, "") || "/";
  const rel = (p) => p.slice(base.length).replace(/^[/\\]/, "").replace(/\\/g, "/");

  const wf = join(base, WORKFLOWS_DIR);
  if (existsSync(wf)) {
    for (const name of readdirSync(wf).sort()) {
      if (!/\.ya?ml$/.test(name)) continue;
      out.push(rel(join(wf, name)));
    }
  }
  const act = join(base, ACTIONS_DIR);
  if (existsSync(act)) {
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.ya?ml$/.test(name)) out.push(rel(p));
      }
    };
    // 必须传绝对/已拼接的 act：此处曾写成 walk(ACTIONS_DIR)（相对常量），
    // 只有 root === cwd 时碰巧能用；一旦把 action vendor 进本仓、或有人在
    // 别的 cwd 调用本模块（selftest 正是如此），readdirSync 直接 ENOENT。
    walk(act);
  }
  return out;
}


// ── 判据总入口（CLI 与 selftest 共用）──────────────────────────────────────
/**
 * 跑一次判据。
 *
 * @param {string} [root] 仓库根
 * @returns {{errors: string[], warnings: string[], structure: string[],
 *            stats: {total: number, pinned: number, local: number, docker: number, allowed: number},
 *            seen: Map, targets: string[]}}
 *   `structure` = **判据本身不可信**（扫描面为空 / 事实源不可读）。它与「真实存在
 *   未固定引用」必须是两条输出流：处置动作相反（一个是补文件/查权限，一个是改引用）。
 */
export function check(root = DEFAULT_ROOT) {
  const targets = collectTargets(root);
  const structure = [];
  const zero = {
    errors: [],
    warnings: [],
    stats: { total: 0, pinned: 0, local: 0, docker: 0, allowed: 0 },
    seen: new Map(),
  };

  if (targets.length === 0) {
    structure.push(
      `扫描面为空：${WORKFLOWS_DIR} 与 ${ACTIONS_DIR} 下都找不到 .yml/.yaml —— guard is blind` +
        `（0 处 uses 不是「全部已固定」，是一处都没判）。`,
    );
    return { ...zero, structure, targets };
  }

  const scanned = checkFiles(targets, (f) => readFileSync(join(root, f), "utf8"));
  for (const u of scanned.unreadable) {
    structure.push(`事实源不可读：${u} —— 该文件的 uses 一处都没进判据。`);
  }
  if (scanned.stats.total < MIN_USES) {
    structure.push(
      `扫描面为空：${targets.length} 个 workflow/action 文件里只解析出 ${scanned.stats.total} 处 uses` +
        `（下界 ${MIN_USES}）—— uses 正则与 YAML 风格已失配，判据一处也没执行。`,
    );
  }
  return { ...scanned, structure, targets };
}

/**
 * 跑一次守卫（供 CLI 与 selftest 共用）。
 *
 * @param {{root?: string}} [options]
 * @returns {number} 退出码
 */
export function run({ root = DEFAULT_ROOT } = {}) {
  const { errors, warnings, stats, seen, targets, structure } = check(root);

  if (structure.length > 0) {
    console.error("");
    console.error("✖ workflow action pinning 守卫结构错误（判据本身不可信，先修扫描面）：");
    for (const s of structure) console.error("  · " + s);
    console.error("");
    return 1;
  }

  console.log(
    `check-workflow-actions-pinned: ${targets.length} 个文件 / ${stats.total} 处 uses —— ` +
      `${stats.pinned} 已固定 SHA、${stats.local} 本地路径、${stats.docker} docker://` +
      (stats.allowed ? `、${stats.allowed} 显式豁免` : "") +
      `；${seen.size} 个 distinct action`,
  );
  for (const w of warnings) console.warn(`  warn: ${w}`);
  if (errors.length > 0) {
    console.error(`\n未固定的 action 引用（${errors.length} 处）：`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  console.log("✔ 所有第三方 action 均已固定到 commit SHA");
  return 0;
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本 + <1s）──────────────────────────
const SELF = fileURLToPath(import.meta.url);

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SHA2 = "949feb2413d6458794dcd2491c4babbbce0c15c1";

/** 一份最小 workflow：`steps` 从第 7 行开始（用例里的 file:line 断言靠这个）。 */
const workflow = (steps) =>
  [
    "name: fixture",
    "on: push",
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...steps,
  ].join("\n") + "\n";

/**
 * 造 fixture 树。
 *
 * @param {{
 *   workflows?: Record<string, string[]>,  // 文件名 → steps 行
 *   raw?: Record<string, string>,          // 文件名 → 整份文本（优先，用于非 steps 结构）
 *   actions?: Record<string, string[]>,    // 相对 .github/actions 的路径 → steps 行
 *   omitWorkflows?: boolean,               // 不造 .github/workflows（事实源缺失）
 * }} spec
 */
function tree({ workflows, raw = {}, actions = {}, omitWorkflows = false } = {}) {
  const files = { "package.json": { name: "fixture", private: true } };
  const wf = workflows ?? { "ci.yml": [`      - uses: actions/checkout@${SHA}`] };
  if (!omitWorkflows) {
    for (const [name, steps] of Object.entries(wf)) {
      files[`.github/workflows/${name}`] = workflow(steps);
    }
  }
  for (const [name, text] of Object.entries(raw)) {
    files[`.github/workflows/${name}`] = text;
  }
  for (const [rel, steps] of Object.entries(actions)) {
    files[`.github/actions/${rel}`] = workflow(steps);
  }
  return files;
}

/** 自检：真子进程，逐条断言退出码 + 关键文本 + <1s。 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect, prepare) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "wf-pinned-selftest-" });
        try {
          if (prepare) prepare(repo);
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
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

  // ① 三种合法形态 + 统计口径（pinned / local / docker 不许互相顶替）
  subprocess(
    "① 40 位 SHA + 本地路径 + docker:// → 绿，且统计口径各自计数",
    tree({
      workflows: {
        "ci.yml": [
          `      - uses: actions/checkout@${SHA}`,
          "      - uses: ./.github/actions/setup",
          "      - uses: docker://alpine:3.20",
        ],
      },
    }),
    {
      code: 0,
      contains: [
        "✔ 所有第三方 action 均已固定到 commit SHA",
        "3 处 uses",
        "1 已固定 SHA、1 本地路径、1 docker://",
      ],
      absent: ["未固定的 action 引用", "结构错误"],
    },
  );

  // ② tag → 红：file:line / 可变引用性质 / 可执行修法，三样都要有
  subprocess(
    "② tag 引用（@v4）→ 红（点名 file:line + 可变引用 + gh api 修法）",
    tree({ workflows: { "ci.yml": ["      - uses: actions/checkout@v4"] } }),
    {
      code: 1,
      contains: [
        "未固定的 action 引用（1 处）",
        "ci.yml:7",
        "actions/checkout@v4",
        "可变引用（tag/branch `v4`）",
        "gh api repos/actions/checkout/commits/v4",
        "# v4",
      ],
      absent: ["✔ 所有第三方 action 均已固定到 commit SHA", "结构错误"],
    },
  );

  // ③ 【反证·只数条数】短 SHA 必须走 short-sha 分支，不能靠 tag 文案冒充
  subprocess(
    "③ 7 位短 SHA → 红（点名「短 SHA」，不是笼统的 tag/branch）",
    tree({ workflows: { "ci.yml": [`      - uses: actions/checkout@${SHA.slice(0, 7)}`] } }),
    {
      code: 1,
      contains: ["短 SHA（7 位）", "无法校验完整性", "展开成 40 位"],
      absent: ["可变引用（tag/branch", "✔ 所有第三方 action 均已固定"],
    },
  );

  // ④ 缺 @ref 与 malformed 必须分开报（否则「有一条红」会掩盖分支失效）
  subprocess(
    "④ 完全缺 @ref → 红（缺 @ref ≠ malformed）",
    tree({ workflows: { "ci.yml": ["      - uses: actions/checkout"] } }),
    {
      code: 1,
      contains: ["缺少 @ref", "补成 actions/checkout@<40位SHA>"],
      absent: ["不是 owner/repo@ref 形态", "✔ 所有第三方 action 均已固定"],
    },
  );

  // ⑤ 【反证·注释算数】同时钉计数面（1 处）与判据面（0 err）——只断 0 err 无法
  //    区分「注释被剥」与「整行没被解析」。
  subprocess(
    "⑤ 注释里的 uses 不算：计数面只认 1 处、判据面 0 红",
    tree({
      workflows: {
        "ci.yml": ["      # uses: actions/checkout@v4", `      - uses: actions/checkout@${SHA} # v4`],
      },
    }),
    {
      code: 0,
      contains: ["1 处 uses", "✔ 所有第三方 action 均已固定"],
      absent: ["未固定的 action 引用", "结构错误"],
    },
  );

  // ⑥ 【反证·扫描面】`.github/actions/**`（深层 + .yaml 变体）必须真的被扫
  subprocess(
    "⑥ `.github/actions/**` 的深层 `.yaml` 也在扫描面内（不是只扫 workflows）",
    tree({
      workflows: { "ci.yml": [`      - uses: actions/checkout@${SHA}`] },
      actions: { "nested/deep/action.yaml": ["      - uses: actions/setup-node@v4"] },
    }),
    {
      code: 1,
      contains: ["2 处 uses", "actions/nested/deep/action.yaml:7", "actions/setup-node@v4"],
      absent: ["✔ 所有第三方 action 均已固定"],
    },
  );

  // ⑦ pull_request_target：无 allow-prt → 红
  subprocess(
    "⑦ pull_request_target 无 `# allow-prt` → 红（提权面必须显式确认）",
    tree({
      raw: {
        "ci.yml":
          "on:\n  pull_request_target:\n    types: [opened]\njobs:\n  a:\n    steps:\n" +
          `      - uses: actions/checkout@${SHA}\n`,
      },
    }),
    {
      code: 1,
      contains: ["pull_request_target 需要人工确认", "ci.yml:2", "allow-prt"],
      absent: ["✔ 所有第三方 action 均已固定"],
    },
  );

  // ⑧ allow-prt 但理由是空的/太短 → 红（「写个键交差」不算确认）
  subprocess(
    "⑧ `# allow-prt` 缺理由（<8 字符）→ 红",
    tree({
      raw: {
        "ci.yml":
          "on:\n  pull_request_target: # allow-prt\n    types: [opened]\njobs:\n  a:\n    steps:\n" +
          `      - uses: actions/checkout@${SHA}\n`,
      },
    }),
    {
      code: 1,
      contains: ["缺少理由（需 ≥8 字符说明为何非它不可）"],
      absent: ["✔ 所有第三方 action 均已固定"],
    },
  );

  // ⑨ 带理由的 allow-prt → 绿（不误伤确有需要的场景）
  subprocess(
    "⑨ `# allow-prt: <理由>` → 绿（确有需要时不做一刀切）",
    tree({
      raw: {
        "ci.yml":
          "on:\n  pull_request_target: # allow-prt: 需要给 fork PR 打标签，但不 checkout 其代码\n" +
          "    types: [opened]\njobs:\n  a:\n    steps:\n" +
          `      - uses: actions/checkout@${SHA}\n`,
      },
    }),
    {
      code: 0,
      contains: ["✔ 所有第三方 action 均已固定"],
      absent: ["结构错误", "pull_request_target 需要人工确认"],
    },
  );

  // ⑩ 同一 action 两个 SHA → warn 但**不判红**（灰度升级是刻意的）
  subprocess(
    "⑩ 同一 action 被固定成 2 个 SHA → warn，不判红",
    tree({
      workflows: {
        "ci.yml": [
          `      - uses: actions/checkout@${SHA}`,
          `      - uses: actions/checkout@${SHA2}`,
        ],
      },
    }),
    {
      code: 0,
      contains: ["✔ 所有第三方 action 均已固定", "被固定成 2 个不同 SHA", "warn:"],
      absent: ["未固定的 action 引用"],
    },
  );

  // ⑪ 【反证·事实源缺失】没有 .github/workflows → 结构红（不是「全部已固定」）
  subprocess(
    "⑪ 事实源缺失（没有 .github/workflows）→ 结构红，不报「全部已固定」",
    tree({ omitWorkflows: true }),
    {
      code: 1,
      contains: ["结构错误", "扫描面为空", "guard is blind"],
      absent: ["✔ 所有第三方 action 均已固定", "未固定的 action 引用", "ENOENT"],
    },
  );

  // ⑫ 【反证·静默 catch】workflow 文件读不出来 → 结构红。旧实现 `catch { continue; }`
  //    会把那个文件的 uses 静默丢掉，剩下「0 处未固定」= 假绿。
  subprocess(
    "⑫ 事实源不可读（文件被目录占名）→ 结构红，不静默跳过",
    tree({ workflows: { "ci.yml": [`      - uses: actions/checkout@${SHA}`] } }),
    {
      code: 1,
      contains: ["结构错误", "事实源不可读", "broken.yml"],
      absent: ["✔ 所有第三方 action 均已固定"],
    },
    (repo) => mkdirSync(repo.pathOf(".github/workflows/broken.yml"), { recursive: true }),
  );

  // ⑬ 【反证·扫描面下界】有 workflow 但一处 uses 都解析不到 → 结构红
  //    （「0 处未固定」不是「全部已固定」，是正则没读到东西）
  subprocess(
    "⑬ workflow 里一处 uses 都没有 → 结构红（0 处 ≠ 全部已固定）",
    tree({ workflows: { "ci.yml": ["      - run: echo hi"] } }),
    {
      code: 1,
      contains: ["只解析出 0 处 uses", "下界 1", "判据一处也没执行"],
      absent: ["✔ 所有第三方 action 均已固定"],
    },
  );

  const failed = reportCases(cases, { title: "check-workflow-actions-pinned selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
  } else {
    const rootArg = argValue(argv, "--root");
    process.exit(run({ root: rootArg ? resolve(rootArg) : DEFAULT_ROOT }));
  }
}
