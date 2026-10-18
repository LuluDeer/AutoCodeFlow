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
 *   2. 同 tag 重复：同一 tagName 存在多个 Release 对象；
 *   3. Latest 竞争面：tag 以 v 开头（主仓/Python 四库）的非 draft Release
 *      未标 prerelease——desktop-v* 例外（它们就是桌面更新源，必须可被
 *      /releases/latest 命中）。
 *
 * 用法：GITHUB_TOKEN=<token> GITHUB_REPOSITORY=owner/repo node scripts/check-release-hygiene.mjs
 * （CI 里 GITHUB_TOKEN/GITHUB_REPOSITORY 由 Actions 自动注入。）
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

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

async function ghApi(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
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

const releases = [];
let page = 1;
for (;;) {
  const batch = await ghApi(
    `/repos/${repo}/releases?per_page=100&page=${page}`,
  );
  releases.push(...batch);
  if (batch.length < 100) break;
  page += 1;
}

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const violations = [];

// 1) Draft 遗留（>7 天）
for (const r of releases) {
  if (r.draft && NOW - new Date(r.created_at).getTime() > 7 * DAY) {
    violations.push(
      `[draft-遗留] ${r.tag_name}（${r.name || "无标题"}）draft 已超 7 天（创建 ${r.created_at}）——publish 或删除`,
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

if (violations.length > 0) {
  console.error(`[release-hygiene] 发现 ${violations.length} 处违规：`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(
  `[release-hygiene] OK：${releases.length} 个 Release 对象，无 Draft 遗留 / 无 tag 重复 / 无 Latest 竞争`,
);
