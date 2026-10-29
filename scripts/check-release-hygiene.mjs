#!/usr/bin/env node
/**
 * Release Hygiene 审计（N-15 后续，发版卫生守卫）。
 *
 * 背景：仓库有三条独立发版线混排在同一个 Releases 页（主仓 v* / 桌面
 * desktop-v* / Python 四库 v0.x），历史上积过：忘发布的 Draft（v1.1.x/
 * v1.5.2）、同 tag 重复对象（desktop-v1.5.2 ×2）、非 prerelease 的主仓
 * release 抢 GitHub Latest 破坏桌面自动更新源（v1.5.1 实爆）。
 *
 * 三条判据（违反即 exit 1，CI 红 = 人工处理）：
 *   1. Draft 遗留：draft 状态超过 7 天的 Release；
 *   2. 同 tag 重复：同一 tagName 存在多个 Release 对象（draft 无有效 tag 关联，不计入）；
 *   3. Latest 竞争面：tag 以 v 开头（主仓/Python 四库）的非 draft Release
 *      未标 prerelease——desktop-v* 例外（它们就是桌面更新源，必须可被
 *      /releases/latest 命中）。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的三处假绿 + 两处缺陷
 *
 * 这个守卫是全仓少数**依赖网络**的检查，所以它从来没有 selftest：判据是模块级
 * 顶层 await，只能靠「CI 每周跑一次」验证。于是下面几处一直没人钉：
 *
 *   · **假绿·「0 个 Release 对象 = 无违规」**：`/releases` 返回 `[]`（仓库名写错、
 *     token 权限不足、分页/API 形状变了）时旧实现直接打印
 *     「OK：0 个 Release 对象，无 Draft 遗留 / 无 tag 重复 / 无 Latest 竞争」。
 *     现在 0 个对象是**结构红**（下界 1）。这是本仓反复踩的形态，只是载体换成了 API。
 *   · **假绿·响应形状变了就静默跳过**：三条判据全依赖 `tag_name` / `draft` /
 *     `created_at`。字段改名后 `!r.prerelease` 恒真不会漏判，但
 *     `r.draft && …` 恒假、`new Date(undefined)` → NaN 使超龄比较恒假 ——
 *     于是 draft 遗留整条判据静默失效。现在三者缺失/不可解析都是结构红。
 *   · **假绿·无自检**：三条判据各自都能被「改坏」而不被发现（例如把 7 天改成
 *     70 天、把 desktop-v* 例外写成 `tag_name.includes("v")`）。现在 12 条用例
 *     逐条跑真脚本，断言退出码 + 关键文本。
 *   · **缺陷·兜底 token 从未生效**：`ghApi` 的 Authorization 用的是 `token`
 *     （环境变量），而兜底值放在 `effectiveToken` —— 本地走 `~/.config/gh/hosts.yml`
 *     兜底时请求头是 `Bearer undefined`，必然 401。现在统一用 `effectiveToken`。
 *   · `--fixture`：selftest 无法访问 GitHub API，用它把「Release 对象数组」直接从
 *     JSON 文件灌进判据（**只在 `--selftest` 里使用**；`release-hygiene.yml` 不带它，
 *     主跑路径一行未变）。`--root` 同理，只作为 fixture 路径的解析基准。
 *
 * 用法：
 *   GITHUB_TOKEN=<token> GITHUB_REPOSITORY=owner/repo node scripts/check-release-hygiene.mjs
 *   node scripts/check-release-hygiene.mjs --selftest
 *   （CI 里 GITHUB_TOKEN/GITHUB_REPOSITORY 由 Actions 自动注入。）
 *
 * 退出码：0 干净 / 1 有违规或结构错误 / 2 用法·凭证缺失。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const DRAFT_MAX_AGE_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 扫描面下界：一个有三条发版线的仓库不可能「0 个 Release 对象」。
 * 0 个必然意味着取数失败（仓库名/token/分页/API 形状），必须红。
 */
export const MIN_RELEASES = 1;

/**
 * 纯判据：`releases` → `{ errors, violations, counts }`。
 *
 * errors  = 判据不可信（响应形状 / 空集合）；violations = 真实违规。
 * 网络取数在 CLI 层（`fetchReleases`），本函数无 I/O，selftest 直接喂 fixture。
 */
export function auditReleases(releases, { now = Date.now() } = {}) {
  const violations = [];
  const errors = [];

  if (!Array.isArray(releases)) {
    return {
      errors: [
        `GitHub API 返回的不是 Release 数组（收到 ${releases === null ? "null" : typeof releases}）—— 响应形状变了，三条判据全部无从判定。`,
      ],
      violations,
      counts: { releases: 0 },
    };
  }
  if (releases.length < MIN_RELEASES) {
    return {
      errors: [
        `只读到 ${releases.length} 个 Release 对象（下界 ${MIN_RELEASES}）—— 仓库名/token/分页/API 形状之一出了问题；` +
          "「0 个对象 = 0 处违规」是最贵的一种假绿（守卫在说话，闸不关门）。",
      ],
      violations,
      counts: { releases: releases.length },
    };
  }

  // 形状校验：三条判据各依赖一个字段，任何一处静默失效都会让判据「永远绿」。
  const shape = new Set();
  releases.forEach((r, i) => {
    const where = `第 ${i + 1} 个 Release 对象`;
    if (!r || typeof r !== "object") {
      shape.add(`${where}不是对象（收到 ${JSON.stringify(r)}）`);
      return;
    }
    if (typeof r.tag_name !== "string") {
      shape.add(`${where}缺少字符串 tag_name（实际 ${JSON.stringify(r.tag_name)}）—— 同 tag 重复与 Latest 竞争两条判据会静默跳过它`);
    }
    if (typeof r.draft !== "boolean") {
      shape.add(`${where}缺少布尔 draft（实际 ${JSON.stringify(r.draft)}）—— Draft 遗留判据会把它当「已发布」静默跳过`);
    }
    if (Number.isNaN(new Date(r.created_at).getTime())) {
      shape.add(`${where}的 created_at 不可解析（${JSON.stringify(r.created_at)}）—— draft 超龄比较会永远为假`);
    }
  });
  if (shape.size > 0) {
    return { errors: [...shape], violations, counts: { releases: releases.length } };
  }

  // 1) Draft 遗留（>7 天）
  for (const r of releases) {
    if (r.draft && now - new Date(r.created_at).getTime() > DRAFT_MAX_AGE_DAYS * DAY_MS) {
      violations.push(
        `[draft-遗留] ${r.tag_name}（${r.name || "无标题"}）draft 已超 ${DRAFT_MAX_AGE_DAYS} 天（创建 ${r.created_at}）——publish 或删除`,
      );
    }
  }

  // 2) 同 tag 重复对象
  const byTag = new Map();
  for (const r of releases) {
    if (!r.tag_name || r.draft) continue; // draft 无有效 tag 关联
    const list = byTag.get(r.tag_name) || [];
    list.push(r);
    byTag.set(r.tag_name, list);
  }
  for (const [tag, list] of byTag) {
    if (list.length > 1) {
      violations.push(
        `[tag-重复] ${tag} 存在 ${list.length} 个 Release 对象（创建时间 ${list
          .map((r) => r.created_at)
          .join(" / ")}）——保留一个，其余删除`,
      );
    }
  }

  // 3) Latest 竞争面：所有 v*（非 desktop）非 draft 对象必须标 prerelease
  //    （2026-10-02 已把历史存量全部修正，无豁免期——desktop-v* 是唯一合法
  //    的 Latest 持有者）
  for (const r of releases) {
    if (r.draft) continue;
    if (!r.tag_name.startsWith("v")) continue; // desktop-v* 是更新源，必须可被 /releases/latest 命中
    if (!r.prerelease) {
      violations.push(
        `[latest-竞争] ${r.tag_name}（创建 ${r.created_at}）未标 prerelease——会抢占 GitHub Latest 破坏桌面自动更新源（gh release edit ${r.tag_name} --prerelease）`,
      );
    }
  }

  return { errors, violations, counts: { releases: releases.length } };
}

/**
 * TOKEN-FALLBACK（审计 P2，2026-10-17）：本地直跑时从 `gh` 的 hosts.yml 兜底取
 * token。
 *
 * 缺陷现场：本函数**先于**定义处被一个早退守卫挡死——
 *   `if (!repo || !token) { …exit(2) }`
 * 在 `token` 为空时直接退出，于是「本地没设 GITHUB_TOKEN」这个**唯一**需要
 * 兜底的场景永远走不到下面 `const effectiveToken = token || readTokenFromGhConfig()`
 * ——兜底分支是死代码，本地跑只会得到 exit 2（而脚本注释与错误文案都在
 * 承诺「本地可用 gh auth token」）。
 *
 * 现在把守卫拆开：repo 缺失是硬错（无法确定目标仓库），token 缺失则先尝试
 * 兜底，兜底也失败才报错。
 */
function readTokenFromGhConfig() {
  // 本地直跑兜底：gh CLI 的 keyring 不可脚本化读，仅支持 hosts.yml 明文形态；
  // 读不到返回空，由调用方报缺 token。
  try {
    const hosts = JSON.parse(
      readFileSync(join(homedir(), ".config", "gh", "hosts.yml"), "utf-8")
        .replace(/\bgithub\.com:\b/g, '"github.com":')
        .replace(/\boauth_token:\s*/g, '"oauth_token": ')
        .replace(/\buser:\s*/g, '"user": ')
        .replace(/\bgit_protocol:\s*/g, '"git_protocol": '),
    );
    return hosts["github.com"]?.oauth_token;
  } catch {
    return undefined;
  }
}

async function ghApi(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      // T4：这里曾经用 `token`（环境变量），兜底值放 `effectiveToken` —— 兜底时
      // 请求头是 `Bearer undefined`，必然 401，于是「本地兜底」永远不会成功。
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchReleases(repo, token) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await ghApi(`/repos/${repo}/releases?per_page=100&page=${page}`, token);
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub API /repos/${repo}/releases 返回的不是数组（page ${page}）—— 响应形状变了。`);
    }
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本；网络用 --fixture 绕开）─────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();

/** 造一个 Release 对象；默认是一条 30 天前、已发布、已标 prerelease 的主仓版本。 */
const rel = ({
  tag,
  draft = false,
  prerelease = true,
  createdAt = iso(30),
  name = undefined,
} = {}) => ({
  tag_name: tag,
  name: name ?? tag,
  draft,
  prerelease,
  created_at: createdAt,
});

/** 干净的三线共存形态：主仓/Python 全标 prerelease，desktop-v* 是唯一 Latest 持有者。 */
const cleanReleases = () => [
  rel({ tag: "v1.15.0", createdAt: iso(40) }),
  rel({ tag: "v1.15.1", createdAt: iso(20) }),
  rel({ tag: "v0.3.2", createdAt: iso(10) }),
  rel({ tag: "desktop-v1.5.2", prerelease: false, createdAt: iso(15) }),
  rel({ tag: "v1.16.0", draft: true, createdAt: iso(1) }),
  rel({ tag: "v1.12.0", draft: true, createdAt: iso(2) }),
];

/**
 * 自检：12 条用例，全部 `spawn` 真脚本。
 *
 * 网络依赖用 `--fixture` 绕开：fixture 文件就是「GitHub API 会返回的数组」，
 * 判据本体（`auditReleases`）与被测 CLI 之间的契约一点没变。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, releases, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo({ "releases.json": releases }, { prefix: "release-hygiene-selftest-" });
        try {
          expectExit(
            runGuard(SELF, { args: ["--root", repo.dir, "--fixture", "releases.json"] }),
            { ...expect, withinMs: 1000, label: name },
          );
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("① 干净树：三线共存、draft 未超龄 → 绿（6 个对象）", cleanReleases(), {
    code: 0,
    contains: ["[release-hygiene] OK：6 个 Release 对象", "无 Draft 遗留", "无 tag 重复", "无 Latest 竞争"],
    absent: ["违规", "结构错误"],
  });

  subprocess(
    "② Draft 遗留（8 天前创建）→ 红，点名 tag 与处置动作",
    [...cleanReleases(), rel({ tag: "v1.9.0", draft: true, createdAt: iso(8) })],
    {
      code: 1,
      contains: ["发现 1 处违规", "[draft-遗留] v1.9.0", "draft 已超 7 天", "publish 或删除"],
      absent: ["OK："],
    },
  );

  subprocess(
    "③ 同 tag 重复对象（v1.15.0 ×2）→ 红，报出两个创建时间",
    [...cleanReleases(), rel({ tag: "v1.15.0", createdAt: iso(41) })],
    {
      code: 1,
      contains: ["[tag-重复] v1.15.0 存在 2 个 Release 对象", "保留一个，其余删除"],
      absent: ["OK："],
    },
  );

  subprocess(
    "④ 主仓版本未标 prerelease（会抢 Latest）→ 红",
    [...cleanReleases(), rel({ tag: "v1.15.2", prerelease: false, createdAt: iso(5) })],
    {
      code: 1,
      contains: ["[latest-竞争] v1.15.2", "gh release edit v1.15.2 --prerelease"],
      absent: ["OK："],
    },
  );

  subprocess(
    "⑤ 对照组：desktop-v* 不标 prerelease 是**合法**的（它就是更新源）→ 绿",
    [rel({ tag: "desktop-v1.5.2", prerelease: false, createdAt: iso(3) })],
    { code: 0, contains: ["OK：1 个 Release 对象"], absent: ["违规", "latest-竞争"] },
  );

  subprocess(
    "⑥ 边界对照组：draft 才 6 天（未超 7 天）不算遗留 → 绿",
    [rel({ tag: "v1.16.0", draft: true, createdAt: iso(6) })],
    { code: 0, contains: ["OK：1 个 Release 对象"], absent: ["draft-遗留"] },
  );

  // ⑦ 修掉的假绿：「0 个对象 = 0 处违规 = OK」
  subprocess("⑦ 【反证·事实源】一个 Release 都没读到（[]）→ 结构红，不是 OK", [], {
    code: 1,
    contains: ["结构错误", "只读到 0 个 Release 对象", `下界 ${MIN_RELEASES}`, "假绿"],
    absent: ["OK："],
  });

  subprocess("⑧ 【反证·解析失败】fixture 不是合法 JSON → 结构红", "{\n  oops", {
    code: 1,
    contains: ["fixture 不是合法 JSON"],
    absent: ["OK：", "Error:"],
  });

  subprocess("⑨ 【反证·形状】fixture 是对象而非数组 → 结构红", { message: "Not Found", status: "404" }, {
    code: 1,
    contains: ["不是 Release 数组", "响应形状变了"],
    absent: ["OK："],
  });

  subprocess(
    "⑩ 【反证·形状】某条缺 tag_name → 结构红（否则两条判据静默跳过它）",
    [...cleanReleases(), { draft: false, prerelease: true, created_at: iso(5) }],
    { code: 1, contains: ["缺少字符串 tag_name", "静默跳过"], absent: ["OK："] },
  );

  subprocess(
    "⑪ 【反证·形状】created_at 不可解析 → 结构红（否则超龄比较永远为假）",
    [...cleanReleases(), rel({ tag: "v1.9.1", draft: true, createdAt: "not-a-date" })],
    { code: 1, contains: ["created_at 不可解析", "永远为假"], absent: ["OK："] },
  );

  subprocess(
    "⑫ 对照组：同 tag 的两个 **draft** 不算重复（draft 无有效 tag 关联）→ 绿",
    [
      rel({ tag: "v1.16.0", draft: true, createdAt: iso(1) }),
      rel({ tag: "v1.16.0", draft: true, createdAt: iso(2) }),
    ],
    { code: 0, contains: ["OK：2 个 Release 对象"], absent: ["tag-重复"] },
  );

  const failed = reportCases(cases, { title: "check-release-hygiene selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

async function main() {
  const fixtureArg = argValue(process.argv, "--fixture");
  let releases;

  if (fixtureArg) {
    // 仅 selftest 用：把「API 会返回的数组」从文件灌进来，网络与凭证都不参与。
    const abs = resolve(resolve(argValue(process.argv, "--root") ?? process.cwd()), fixtureArg);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (error) {
      console.error(`[release-hygiene] 结构错误：读不到 fixture ${abs}（${error.code ?? error.message}）`);
      process.exit(1);
    }
    try {
      releases = JSON.parse(text);
    } catch (error) {
      console.error(`[release-hygiene] 结构错误：fixture 不是合法 JSON（${abs}）——${error.message.split("\n")[0]}`);
      process.exit(1);
    }
  } else {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

    if (!repo) {
      console.error(
        "[release-hygiene] 需要 GITHUB_REPOSITORY（CI 自动注入；本地运行请 GITHUB_REPOSITORY=owner/repo）",
      );
      process.exit(2);
    }

    const effectiveToken = token || readTokenFromGhConfig();
    if (!effectiveToken) {
      console.error("[release-hygiene] 本地未取到 token（gh keyring 加密存储不可脚本读）——请 GITHUB_TOKEN=... 运行或仅在 CI 跑");
      process.exit(2);
    }

    releases = await fetchReleases(repo, effectiveToken);
  }

  const { errors, violations, counts } = auditReleases(releases);

  if (errors.length > 0) {
    console.error("[release-hygiene] 结构错误（判据不可信，先修取数/形状，再谈违规）：");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(`[release-hygiene] 发现 ${violations.length} 处违规：`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(
    `[release-hygiene] OK：${counts.releases} 个 Release 对象，无 Draft 遗留 / 无 tag 重复 / 无 Latest 竞争`,
  );
}

if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    await main();
  }
}
