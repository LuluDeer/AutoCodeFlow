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
 * 用法：
 *   node scripts/check-workflow-actions-pinned.mjs              # 扫本仓
 *   node scripts/check-workflow-actions-pinned.mjs --selftest   # 只验判据本身
 * 退出码：0 = 全部已固定（可能有 warn）；1 = 有未固定引用 / 未声明的 pull_request_target。
 */
import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WORKFLOWS_DIR = ".github/workflows";
const ACTIONS_DIR = ".github/actions";

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
 * @param {string[]} files 展示用路径
 * @param {(f: string) => string} read
 */
export function checkFiles(files, read) {
  const errors = [];
  const warnings = [];
  /** @type {Map<string, Map<string, string[]>>} action(lower) -> sha(lower) -> [loc] */
  const seen = new Map();
  const stats = { total: 0, pinned: 0, local: 0, docker: 0, allowed: 0 };

  for (const file of files) {
    let text;
    try {
      text = read(file);
    } catch {
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

  return { errors, warnings, stats, seen };
}

/** 收集扫描面：workflow 文件 + 仓库内 composite action 定义 */
export function collectTargets(root = process.cwd()) {
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

// ── 自检：夹具驱动，不依赖真实 workflow ───────────────────────────────────
export function selftest() {
  const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  const SHA2 = "949feb2413d6458794dcd2491c4babbbce0c15c1";

  /** 每条用例：[名字, yaml, 期望错误数, 期望 warn 数, 期望统计（可选）] */
  const cases = [
    [
      "1. tag 引用（@v4）必须红",
      `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n`,
      1, 0,
    ],
    [
      "2. 40 位 SHA 必须绿",
      `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n`,
      0, 0,
    ],
    [
      "3. 本地路径（./）必须绿",
      `jobs:\n  a:\n    steps:\n      - uses: ./.github/actions/setup\n      - uses: ./\n`,
      0, 0,
    ],
    [
      "4. docker:// 必须绿",
      `jobs:\n  a:\n    steps:\n      - uses: docker://alpine:3.20\n      - uses: docker://ghcr.io/foo/bar@sha256:abc\n`,
      0, 0,
    ],
    [
      "5. 7 位短 SHA 必须红（且点名 short-sha）",
      `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@3d3c42e\n`,
      1, 0,
    ],
    [
      "6. 注释里的 uses 不算",
      `jobs:\n  a:\n    steps:\n      # uses: actions/checkout@v4\n      - uses: actions/checkout@${SHA} # v4\n`,
      0, 0,
    ],
    [
      "7. SHA + 行尾 `# 原ref` 注释必须绿（保留升级线索是允许的）",
      `jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@${SHA} # v7\n`,
      0, 0,
    ],
    [
      "8. 完全缺 @ref 必须红",
      `jobs:\n  a:\n    steps:\n      - uses: actions/checkout\n`,
      1, 0,
    ],
    [
      "9. pull_request_target 无 allow-prt 必须红",
      `on:\n  pull_request_target:\n    types: [opened]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n`,
      1, 0,
    ],
    [
      "10. pull_request_target + `# allow-prt: 理由` 必须绿",
      `on:\n  pull_request_target: # allow-prt: 需要给 fork PR 打标签，但不 checkout 其代码\n    types: [opened]\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n`,
      0, 0,
    ],
    [
      "11. allow-prt 缺理由必须红",
      `on:\n  pull_request_target: # allow-prt\n    types: [opened]\n`,
      1, 0,
    ],
    [
      "12. 同一 action 两个 SHA → warn（不判红）",
      `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n      - uses: actions/checkout@${SHA2}\n`,
      0, 1,
    ],
    [
      "13. 分支引用（@main）必须红",
      `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@main\n`,
      1, 0,
    ],
    [
      "14. 子目录 action（owner/repo/sub@SHA）必须绿",
      `jobs:\n  a:\n    steps:\n      - uses: google-github-actions/auth@${SHA}\n      - uses: owner/repo/sub/dir@${SHA}\n`,
      0, 0,
    ],
  ];

  let failed = 0;
  for (const [name, yaml, wantErrors, wantWarns] of cases) {
    const { errors, warnings } = checkFiles(["fixture.yml"], () => yaml);
    if (errors.length !== wantErrors || warnings.length !== wantWarns) {
      console.error(
        `selftest FAIL: ${name} —— 期望 ${wantErrors} err / ${wantWarns} warn，实际 ${errors.length} err / ${warnings.length} warn`,
      );
      for (const e of errors) console.error(`    err: ${e}`);
      for (const w of warnings) console.error(`    warn: ${w}`);
      failed += 1;
    }
  }

  // 扫描面本身必须被验：`.github/actions/**` 是**将来**才会出现的目录（现在没有），
  // 一旦它没被收进来，把 action vendor 进本仓后就等于「本地 action 里再套 tag 引用」
  // 完全不受检——这正是「守卫安静地瞎了」的形态，故用临时夹具目录实测一次。
  {
    const tmp = mkdtempSync(join(tmpdir(), "wfpin-"));
    try {
      mkdirSync(join(tmp, WORKFLOWS_DIR), { recursive: true });
      mkdirSync(join(tmp, ACTIONS_DIR, "setup"), { recursive: true });
      mkdirSync(join(tmp, ACTIONS_DIR, "nested", "deep"), { recursive: true });
      writeFileSync(join(tmp, WORKFLOWS_DIR, "a.yml"), "on: push\n");
      writeFileSync(join(tmp, WORKFLOWS_DIR, "b.yaml"), "on: push\n");
      writeFileSync(join(tmp, WORKFLOWS_DIR, "notes.txt"), "not a workflow\n");
      writeFileSync(join(tmp, ACTIONS_DIR, "setup", "action.yml"), "runs:\n  using: node20\n");
      writeFileSync(join(tmp, ACTIONS_DIR, "nested", "deep", "action.yaml"), "runs:\n  using: node20\n");
      const targets = collectTargets(tmp);
      const want = [
        ".github/actions/nested/deep/action.yaml",
        ".github/actions/setup/action.yml",
        ".github/workflows/a.yml",
        ".github/workflows/b.yaml",
      ].sort();
      const got = [...targets].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.error(`selftest FAIL: collectTargets 扫描面不符 —— 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
        failed += 1;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 用例 5 必须真的命中 short-sha 分支（而不是碰巧因为别的理由红）
  const shortSha = checkFiles(["f.yml"], () => `- uses: actions/checkout@3d3c42e\n`).errors[0] ?? "";
  if (!shortSha.includes("短 SHA")) {
    console.error(`selftest FAIL: 短 SHA 报错文案应点名「短 SHA」，实际：${shortSha}`);
    failed += 1;
  }
  // 用例 1 必须给出可执行的修法（含 gh api 原文）
  const tagErr = checkFiles(["f.yml"], () => `- uses: actions/checkout@v4\n`).errors[0] ?? "";
  if (!tagErr.includes("gh api repos/actions/checkout/commits/v4")) {
    console.error(`selftest FAIL: tag 报错应给出 gh api 修法，实际：${tagErr}`);
    failed += 1;
  }
  // 报错必须带 file:line（可定位），不能只报 action 名
  if (!/f\.yml:1\b/.test(tagErr)) {
    console.error(`selftest FAIL: 报错应含 file:line，实际：${tagErr}`);
    failed += 1;
  }
  // 统计口径：local/docker 不应被计入 pinned
  const st = checkFiles(["f.yml"], () => `- uses: ./x\n- uses: docker://alpine\n- uses: a/b@${SHA}\n`).stats;
  if (st.pinned !== 1 || st.local !== 1 || st.docker !== 1 || st.total !== 3) {
    console.error(`selftest FAIL: 统计口径错误 ${JSON.stringify(st)}`);
    failed += 1;
  }
  // 注释必须被剥掉：行尾 `# ...` 里的伪引用不得进 total
  const st2 = checkFiles(["f.yml"], () => `- uses: a/b@${SHA} # see uses: c/d@v1\n`).stats;
  if (st2.total !== 1 || st2.pinned !== 1) {
    console.error(`selftest FAIL: 行尾注释里的伪 uses 被计入 —— ${JSON.stringify(st2)}`);
    failed += 1;
  }
  // ALLOWED_UNPINNED 是显式豁免而非兜底：默认必须为空（否则守卫形同虚设需重审）
  if (Object.keys(ALLOWED_UNPINNED).length > 0) {
    for (const [k, v] of Object.entries(ALLOWED_UNPINNED)) {
      if (!v || v.length < 10) {
        console.error(`selftest FAIL: ALLOWED_UNPINNED["${k}"] 缺理由`);
        failed += 1;
      }
    }
  }

  if (failed > 0) process.exit(1);
  console.log(
    `selftest OK: workflow action pinning 判据 ${cases.length} 条夹具 + 6 条元断言（报错含 file:line / 修法可执行 / 统计口径 / 注释被剥 / 豁免须给理由 / 扫描面）全部符合预期`,
  );
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const files = collectTargets();
    if (files.length === 0) {
      console.error(`未找到任何 workflow：${WORKFLOWS_DIR} — guard is blind`);
      process.exit(1);
    }
    const { errors, warnings, stats, seen } = checkFiles(files, (f) => readFileSync(f, "utf8"));
    console.log(
      `check-workflow-actions-pinned: ${files.length} 个文件 / ${stats.total} 处 uses —— ` +
        `${stats.pinned} 已固定 SHA、${stats.local} 本地路径、${stats.docker} docker://` +
        (stats.allowed ? `、${stats.allowed} 显式豁免` : "") +
        `；${seen.size} 个 distinct action`,
    );
    for (const w of warnings) console.warn(`  warn: ${w}`);
    if (errors.length > 0) {
      console.error(`\n未固定的 action 引用（${errors.length} 处）：`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log("✔ 所有第三方 action 均已固定到 commit SHA");
  }
}
