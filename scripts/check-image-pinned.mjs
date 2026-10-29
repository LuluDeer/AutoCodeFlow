#!/usr/bin/env node
/**
 * CIR-05（第二步）：compose / Dockerfile 里的第三方镜像必须固定到 **manifest list digest**。
 *
 * 为什么这是供应链问题而不是风格问题：`image: postgres:16-alpine` 里的 tag 是**可变引用**。
 * 上游重推同名 tag（发版流程事故、维护者账号被盗、仓库被接管，或只是重建了一次 CI 缓存）
 * 之后，同一份 compose、同一个 commit，`docker compose up` 拉下来的是**另一份字节**——
 * 而 CI 与生产这边没有任何变更、也没有任何信号。「tag 是什么」由别人的注册表决定，
 * 「digest 是什么」由内容决定：`sha256:…` 指到哪就是哪，不可漂移。
 *
 * 判据（逐行扫**仓库根的** `docker-compose*.yml|yaml`、仓库根 `Dockerfile*`
 * **以及 `apps/<app>/Dockerfile*`**）：
 *   每个 `image:` / `FROM` 的取值必须命中以下之一——
 *     ① 固定：`<repo>:<tag>@sha256:<64 位小写 hex>`（保留 tag 便于人读，digest 才是判据）；
 *           也接受无 tag 的 `<repo>@sha256:…`；
 *     ② 本地构建豁免：compose 里**同一个服务块**内有 `build:`（镜像由本仓 Dockerfile 产出，
 *           没有上游 manifest 可固定）；
 *     ③ 显式 `ALLOW_UNPINNED: <理由>`（同一行行尾注释，或该行之前的 3 行注释内），理由必须
 *           ≥ MIN_ALLOW_REASON 个字符——`ALLOW_UNPINNED` 光秃秃出现等于「关掉判据」，红。
 *   其余一律红：可变 tag、`latest`、只钉了 tag 没钉 digest、`${VAR}` 变量插值（静态判不出）、
 *   以及 digest 位数不对（40 位是 commit SHA、63/65 位是抄错）。
 *
 * 两条反漂移判据：
 *   ① 「解析不到就保留原样」——**绝不猜 digest**。猜出来的 digest 要么拉不动（pull 直接失败），
 *      要么指向我们没审过的内容，比 tag 更糟。resolver 解析失败时值原样留在 compose 里，
 *      由 `ALLOW_UNPINNED: <理由>` 显式登记 + 报告列出，让「有未固定项」始终可见。
 *   ② 扫描面下界：compose 文件数 ≥ MIN_COMPOSE_FILES、镜像条目数 ≥ MIN_IMAGE_ENTRIES、
 *      Dockerfile 文件数 ≥ MIN_DOCKERFILE_FILES、Dockerfile `FROM` 条目数 ≥
 *      MIN_DOCKERFILE_FROM_ENTRIES。目录改名 / 正则失配 / cwd 不对时，「0 处违规」
 *      不是「全固定」而是「一处都没判」。
 *
 * ## 为什么必须自己剥注释与判服务块（历史假绿形态）
 *
 *   · **整篇 includes 即算**：`# image: postgres:16-alpine` 是说明文字。注释掉的镜像不能替
 *     真镜像顶包，真镜像也不能因为注释里有 `@sha256:` 就变绿——所以 `image:` 只在**剥注释后
 *     的代码部分**匹配。
 *   · **`build:` 全局豁免**：只要文件里出现过 `build:` 就整份豁免，等于把「本地构建」这条
 *     豁免变成一个全局开关（本仓 compose 里就有 5 处 `build:`）。现在豁免的作用域是**服务块**
 *     （`build:` 与 `image:` 必须在同一个 `^  <name>:` 块内）。
 *   · **`ALLOW_UNPINNED` 无理由**：豁免必须带理由，否则它只是「判据的关灯键」。理由长度
 *     也判——`ALLOW_UNPINNED: todo` 这种不算。
 *   · **读不到 = 跳过**：旧形态 `catch { continue }` 会把权限/目录/编码问题的文件整份跳过，
 *     于是「0 处违规」= 假绿。现在读失败、缺 `services:` 一律**结构红**。
 *   · **只测函数不测闸门**：`--selftest` 跑**真子进程**（`--root` 指向临时 fixture 树），
 *     逐条断言**退出码 + 点名文本（file:line）**——把末尾 `process.exit(1)` 删掉、或让
 *     扫描面塌成 0 条，用例都会红。
 *
 * ## 已知边界（写清楚比假装没有）
 *
 *   · 扫描面覆盖 `apps/<app>/Dockerfile*`（CIR-05 收尾后，5 个 app 的 10 条 `FROM`
 *     都在判据内）。仅限 `apps/` 的**一层**子目录：更深的 Dockerfile（例如将来的
 *     `apps/x/deploy/Dockerfile`）不在这条判据的视野里——真出现这类文件，应把下界
 *     与遍历一起改，而不是让它们「没被扫到所以没违规」。
 *   · compose 的 `image: ${VAR}` 形态静态判不出，按违规处理（需要 `ALLOW_UNPINNED` 或改成
 *     字面量）。本仓当前无此形态。
 *   · 不做网络解析。digest 的正确性（= 上游此刻的 manifest list）靠 CIR-05 第一步的
 *     resolver 与人工复核，本守卫只判「有没有钉、钉的位数对不对」。这样它是**离线秒级**的，
 *     能进 `test:guards:repo` 与 CI 的每个 PR。
 *
 * 用法：
 *   node scripts/check-image-pinned.mjs                # 扫本仓
 *   node scripts/check-image-pinned.mjs --selftest     # 只验判据本身（真子进程，12 条用例）
 *   node scripts/check-image-pinned.mjs --root <dir>   # 把该目录当仓库根（selftest 专用）
 * 退出码：0 = 全部固定（可能有豁免）；1 = 有未固定镜像，**或判据本身不可信**
 *         （扫描面塌到下界以下 / 事实源读不到 / compose 不是 compose）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = resolve(HERE, "..");

/**
 * 扫描面下界：compose 文件 ≥ 4。
 *
 * 本仓当前 5 个（`docker-compose.yml` + demo/ha/staging/secure）。取 4 而不是 5：
 * 这条钉的是「目录/命名/glob 还能不能读出 compose」，不是「当前恰好有几个文件」——
 * 少一个 overlay 不该判红，但塌到 1~2 个（改名、被挪进子目录、cwd 不对）必须红。
 */
export const MIN_COMPOSE_FILES = 4;

/**
 * 扫描面下界：镜像条目 ≥ 10（compose `image:` + Dockerfile `FROM` 合计）。
 *
 * 本仓当前 15 条（13 个 distinct 镜像，postgres 复用 3 次）。取 10 留出余量：
 * 目录改名 / 正则因 YAML 风格变化失配时，条目数会塌到个位数——那种「0 处违规」
 * 是判据瞎了，不是树干净了。
 */
export const MIN_IMAGE_ENTRIES = 10;

/**
 * 扫描面下界：Dockerfile 文件数 ≥ 4（仓库根 `Dockerfile*` + `apps/<app>/Dockerfile*` 合计）。
 *
 * 本仓当前 5 个，全在 `apps/` 下（admin-api / admin-web / executor-node /
 * executor-python / registry-pypi）。取 4 而不是 5：这条钉的是「还能不能把
 * Dockerfile 读出来」，少一个 app 不该判红；但塌到 1~2 个（目录被挪、`apps` 改名、
 * 遍历写错路径）必须红——那种情况下 `apps` 的 10 条 `FROM` 一条都没判。
 */
export const MIN_DOCKERFILE_FILES = 4;

/**
 * 扫描面下界：Dockerfile 的 `FROM` 条目数 ≥ 8。
 *
 * 本仓当前 10 条（每个 Dockerfile 都是 2 阶段：builder + runtime）。取 8 留余量，
 * 但踩住「多阶段解析没把第二条 `FROM` 读出来」（旧假绿的典型：只判首行 FROM，
 * runtime 阶段的可变 tag 溜进镜像）。
 */
export const MIN_DOCKERFILE_FROM_ENTRIES = 8;

/** `ALLOW_UNPINNED` 理由的最小长度：短于此的等于没写理由（`todo` / `later` / `x`）。 */
export const MIN_ALLOW_REASON = 8;

/** digest 判据：64 位**小写** hex（大写不是合法 OCI digest 文本形态，40 位是 commit SHA）。 */
export const DIGEST_RE = /@sha256:[0-9a-f]{64}(?![0-9a-fA-F])/;

const COMPOSE_FILE_RE = /^docker-compose.*\.ya?ml$/;
const DOCKERFILE_RE = /^Dockerfile(\..*)?$/;
const SERVICE_RE = /^ {2}([A-Za-z0-9_.-]+)\s*:\s*$/;
const IMAGE_RE = /^\s+image\s*:\s*(.+)$/;
const BUILD_RE = /^\s+build\s*:/;
const FROM_RE = /^FROM\s+(.+)$/i;

/**
 * 把一行拆成「代码部分」与「注释部分」（`#` 前是行首或空白，且不在引号内才算注释）。
 * 与 `check-workflow-actions-pinned.mjs` 的 splitCode 同规则，独立一份以免守卫间耦合。
 */
export function splitCode(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

const commentOf = (line) => line.slice(splitCode(line).length);

/** 去引号 + 去行尾空白（compose 允许 `image: "postgres:16"`）。 */
function unquote(value) {
  const s = value.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** 从一段文本里抽 `ALLOW_UNPINNED` 及其理由；没有标记返回 null。 */
export function parseAllowMarker(text) {
  const m = /ALLOW_UNPINNED\b(.*)$/.exec(String(text ?? ""));
  if (!m) return null;
  const reason = m[1].replace(/^[\s:：\-—–=]+/, "").trim();
  return { raw: m[0], reason, ok: reason.length >= MIN_ALLOW_REASON };
}

/**
 * 解析 compose 文本 → 镜像条目。按**服务块**切分，因此 `build:` 的豁免作用域是块内。
 *
 * @param {string} text
 * @returns {{entries: Array<object>}}
 */
export function parseComposeText(text) {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let section = null;
  let block = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = splitCode(raw);
    // 顶层键（缩进 0）切换 section：services / networks / volumes / x-*
    if (code.trim() && /^\S/.test(code) && /^[A-Za-z0-9_.-]+\s*:/.test(code)) {
      section = code.split(":")[0].trim();
      block = null;
    } else if (section === "services" && SERVICE_RE.test(code)) {
      block = { name: code.trim().replace(/:\s*$/, ""), lines: [] };
      blocks.push(block);
    }
    if (block) block.lines.push({ lineNo: i + 1, raw, code });
  }

  const entries = [];
  for (const b of blocks) {
    const hasBuild = b.lines.some((l) => BUILD_RE.test(l.code));
    for (const l of b.lines) {
      const m = IMAGE_RE.exec(l.code);
      if (!m) continue;
      const image = unquote(m[1]);
      if (!image) continue;
      // 豁免标记：本行行尾注释优先，其次往上最多 3 行（含纯注释行）。
      let allow = parseAllowMarker(commentOf(l.raw));
      if (!allow) {
        const idx = b.lines.findIndex((x) => x.lineNo === l.lineNo);
        for (let k = idx - 1; k >= 0 && k >= idx - 3; k--) {
          const candidate = parseAllowMarker(b.lines[k].raw);
          if (candidate) {
            allow = candidate;
            break;
          }
        }
      }
      entries.push({ kind: "compose", service: b.name, line: l.lineNo, image, hasBuild, allow });
    }
  }
  return { entries };
}

/**
 * 解析 Dockerfile 文本 → FROM 条目。
 *
 * 跳过：`scratch`（空镜像，没有 manifest）、前置 stage 别名引用（`FROM builder`，指向本
 * Dockerfile 内已定义的 stage，不是第三方镜像）、含 `$` 的 build ARG 形态（静态判不出）。
 *
 * @param {string} text
 * @returns {{entries: Array<object>, skipped: Array<object>}}
 */
export function parseDockerfileText(text) {
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  const skipped = [];
  const stages = new Set();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = splitCode(raw).trim();
    const m = FROM_RE.exec(code);
    if (!m) continue;

    let rest = m[1].trim();
    // 去掉 `--platform=...` 之类的前置 flag
    while (rest.startsWith("--")) {
      const sp = rest.indexOf(" ");
      if (sp === -1) {
        rest = "";
        break;
      }
      rest = rest.slice(sp + 1).trim();
    }
    if (!rest) continue;
    const parts = rest.split(/\s+/);
    const ref = parts[0];
    const aliasIdx = parts.findIndex((p) => /^as$/i.test(p));
    const alias = aliasIdx !== -1 ? parts[aliasIdx + 1] : undefined;
    const allow = parseAllowMarker(commentOf(raw)) ?? parseAllowMarker(lines[i - 1] ?? "");
    const base = { kind: "dockerfile", line: i + 1, image: ref, allow };

    if (/^scratch$/i.test(ref)) {
      skipped.push({ ...base, why: "scratch（空基础镜像，无 manifest）" });
    } else if (stages.has(ref)) {
      skipped.push({ ...base, why: `本 Dockerfile 内 stage 引用（${ref}）` });
    } else if (ref.includes("$")) {
      entries.push({ ...base, variable: true });
    } else {
      entries.push(base);
    }
    if (alias) stages.add(alias);
  }
  return { entries, skipped };
}

/**
 * 列出 `apps/<app>/Dockerfile*`（一层子目录），返回相对路径（`apps/<app>/Dockerfile`）。
 *
 * 读不到 / 目录不存在一律记 **structure**（判据不可信），不静默返回空数组——
 * 「扫不到」与「全固定」在报告里必须是两件不同的事。
 *
 * @param {string} root 仓库根
 * @param {string[]} structure 结构问题收集器（就地追加）
 * @returns {string[]} 相对路径（已排序）
 */
export function listAppDockerfiles(root, structure) {
  const appsDir = join(root, "apps");
  if (!existsSync(appsDir)) {
    structure.push(
      `apps/ 目录不存在（${appsDir}）——apps/*/Dockerfile 的基础镜像一处都没判，「0 处违规」不是「已固定」`,
    );
    return [];
  }

  let appNames = [];
  try {
    appNames = readdirSync(appsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (error) {
    structure.push(`读不到 apps 目录（${error.code ?? error.message}）`);
    return [];
  }

  const found = [];
  for (const app of appNames) {
    let names = [];
    try {
      names = readdirSync(join(appsDir, app))
        .filter((n) => DOCKERFILE_RE.test(n))
        .sort();
    } catch (error) {
      structure.push(`读不到 app 目录：apps/${app}（${error.code ?? error.message}）`);
      continue;
    }
    for (const name of names) {
      const abs = join(appsDir, app, name);
      // 同名目录 / 断链：读下去只会抛错，先排除并让「文件数下界」说话。
      try {
        if (!statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      found.push(`apps/${app}/${name}`);
    }
  }

  if (found.length === 0) {
    structure.push(
      `apps/*/Dockerfile 一处都没找到（${appNames.length} 个 app 目录里没有 Dockerfile：目录结构变了 / 名字改了？）`,
    );
  }
  return found;
}

/**
 * 扫一个仓库根。
 *
 * @param {{root?: string}} [options]
 * @returns {{structure: string[], violations: Array<object>, exempt: Array<object>,
 *            warnings: string[], counts: object, entries: Array<object>}}
 */
export function checkImages({ root = DEFAULT_ROOT } = {}) {
  const structure = [];
  const violations = [];
  const exempt = [];
  const warnings = [];
  const counts = {
    composeFiles: 0,
    dockerfiles: 0,
    rootDockerfiles: 0,
    appDockerfiles: 0,
    dockerfileFromLines: 0,
    entries: 0,
    composeEntries: 0,
    dockerfileEntries: 0,
    pinned: 0,
    build: 0,
    allowed: 0,
  };

  if (!existsSync(root)) {
    return { structure: [`仓库根不存在：${root}`], violations, exempt, warnings, counts, entries: [] };
  }

  let names = [];
  try {
    names = readdirSync(root);
  } catch (error) {
    return {
      structure: [`读不到仓库根 ${root}（${error.code ?? error.message}）`],
      violations,
      exempt,
      warnings,
      counts,
      entries: [],
    };
  }

  const composeFiles = names.filter((n) => COMPOSE_FILE_RE.test(n)).sort();
  const rootDockerfiles = names.filter((n) => DOCKERFILE_RE.test(n)).sort();
  // 扫描面 = 仓库根 `Dockerfile*` + `apps/<app>/Dockerfile*`（CIR-05 收尾：app 镜像
  // 的基础镜像也在判据内了）。`apps` 缺失 / 读不到由 lister 记 structure 红。
  const appDockerfiles = listAppDockerfiles(root, structure);
  const dockerfiles = [...rootDockerfiles, ...appDockerfiles];
  counts.composeFiles = composeFiles.length;
  counts.dockerfiles = dockerfiles.length;
  counts.rootDockerfiles = rootDockerfiles.length;
  counts.appDockerfiles = appDockerfiles.length;

  if (composeFiles.length === 0) structure.push("未找到 docker-compose*.yml（目录改名 / cwd 不对？）");
  else if (composeFiles.length < MIN_COMPOSE_FILES) {
    structure.push(
      `compose 文件数 ${composeFiles.length} < 下界 ${MIN_COMPOSE_FILES}（扫描面塌方：0 处违规 ≠ 全部固定）`,
    );
  }

  if (dockerfiles.length < MIN_DOCKERFILE_FILES) {
    structure.push(
      `Dockerfile 文件数 ${dockerfiles.length} < 下界 ${MIN_DOCKERFILE_FILES}` +
        `（根 ${counts.rootDockerfiles} + apps ${counts.appDockerfiles}；扫描面塌方：FROM 一条都没判时不能报绿）`,
    );
  }

  const allEntries = [];

  for (const name of composeFiles) {
    let text;
    try {
      text = readFileSync(join(root, name), "utf8");
    } catch (error) {
      structure.push(`事实源不可读：${name}（${error.code ?? error.message}）`);
      continue;
    }
    // 不是 compose 却叫这个名（空文件 / 被覆盖成别的内容）：判据无从下手，结构红。
    if (!/^\s*services\s*:/m.test(text)) {
      structure.push(`${name} 缺顶层 services:（不是可解析的 compose，判据无法成立）`);
      continue;
    }
    const { entries } = parseComposeText(text);
    for (const e of entries) allEntries.push({ ...e, file: name });
  }

  for (const name of dockerfiles) {
    let text;
    try {
      text = readFileSync(join(root, name), "utf8");
    } catch (error) {
      structure.push(`事实源不可读：${name}（${error.code ?? error.message}）`);
      continue;
    }
    const { entries, skipped } = parseDockerfileText(text);
    // 下界钉的是「FROM 行读出来了没有」——跳过的 scratch / stage 引用也算读到了。
    counts.dockerfileFromLines += entries.length + skipped.length;
    for (const s of skipped) {
      exempt.push({ ...s, file: name, verdict: "build", why: s.why });
    }
    for (const e of entries) allEntries.push({ ...e, file: name });
  }

  counts.entries = allEntries.length;
  counts.composeEntries = allEntries.filter((e) => e.kind === "compose").length;
  counts.dockerfileEntries = allEntries.filter((e) => e.kind === "dockerfile").length;

  if (allEntries.length < MIN_IMAGE_ENTRIES) {
    structure.push(
      `镜像条目 ${allEntries.length} < 下界 ${MIN_IMAGE_ENTRIES}（扫描面塌方：正则读不出 image:/FROM 时不能报绿）`,
    );
  }

  if (counts.dockerfileFromLines < MIN_DOCKERFILE_FROM_ENTRIES) {
    structure.push(
      `Dockerfile FROM 条目 ${counts.dockerfileFromLines} < 下界 ${MIN_DOCKERFILE_FROM_ENTRIES}` +
        `（多阶段只读到首行 FROM / 读不出 FROM 时不能报绿）`,
    );
  }

  for (const e of allEntries) {
    if (DIGEST_RE.test(e.image)) {
      counts.pinned += 1;
      continue;
    }
    if (e.allow) {
      if (e.allow.ok) {
        counts.allowed += 1;
        exempt.push({ ...e, verdict: "allowed", why: e.allow.reason });
      } else {
        violations.push({
          ...e,
          why: `ALLOW_UNPINNED 缺理由（至少要 ${MIN_ALLOW_REASON} 个字符的说明，否则它只是判据的关灯键）`,
        });
      }
      continue;
    }
    if (e.kind === "compose" && e.hasBuild) {
      counts.build += 1;
      exempt.push({ ...e, verdict: "build", why: `同一服务块有 build:（本地构建，无上游 manifest 可固定）` });
      continue;
    }
    if (e.variable) {
      violations.push({ ...e, why: "含变量插值，静态判不出 digest（请改字面量或加 ALLOW_UNPINNED 理由）" });
      continue;
    }
    violations.push({
      ...e,
      why: "未固定 digest（要求 <repo>:<tag>@sha256:<64 位小写 hex>；只写 tag 是可变的）",
    });
  }

  return { structure, violations, exempt, warnings, counts, entries: allEntries };
}

/** 把一条条目渲染成 `file:line  service  image`。 */
function describeEntry(e) {
  const where = `${e.file}:${e.line}`;
  const svc = e.service ? ` [${e.service}]` : "";
  return `${where}${svc} ${e.image}`;
}

function runCli(root) {
  const { structure, violations, exempt, counts } = checkImages({ root });

  console.log(
    `[check-image-pinned] 扫描面：docker-compose*.yml ${counts.composeFiles} 个（下界 ${MIN_COMPOSE_FILES}）、` +
      `Dockerfile ${counts.dockerfiles} 个（根 ${counts.rootDockerfiles} + apps ${counts.appDockerfiles}，下界 ${MIN_DOCKERFILE_FILES}）；` +
      `镜像条目 ${counts.entries} 条（下界 ${MIN_IMAGE_ENTRIES}），其中 Dockerfile FROM ${counts.dockerfileFromLines} 条（下界 ${MIN_DOCKERFILE_FROM_ENTRIES}）`,
  );
  console.log(
    `[check-image-pinned] 判定：固定 ${counts.pinned} / 本地构建豁免 ${counts.build} / ` +
      `ALLOW_UNPINNED ${counts.allowed} / 未固定 ${violations.length}`,
  );

  for (const e of exempt) {
    console.log(`  · ${describeEntry(e)} —— 豁免：${e.verdict === "build" ? "本地构建" : "ALLOW_UNPINNED"}：${e.why}`);
  }

  if (structure.length > 0) {
    console.error(`\n✖ 结构：判据本身不可信（${structure.length} 条）——这里的「0 处违规」不算绿：`);
    for (const s of structure) console.error(`  ✖ ${s}`);
  }

  if (violations.length > 0) {
    console.error(`\n✖ ${violations.length} 处镜像没有固定到 digest：`);
    for (const v of violations) console.error(`  ✘ ${describeEntry(v)}\n      ${v.why}`);
    console.error(
      "\n修法：解析 manifest list digest 后写成 `image: <repo>:<tag>@sha256:<64hex>`" +
        "（保留 tag 便于人读）；解析不到就**保留原样** + 该行加 `# ALLOW_UNPINNED: <理由>` 并在报告里列出，绝不猜 digest。",
    );
  }

  if (structure.length === 0 && violations.length === 0) {
    console.log(
      `\n✔ image pinning：${counts.entries} 条镜像引用全部固定到 manifest list digest 或已显式豁免` +
        `（固定 ${counts.pinned} 条；豁免 ${exempt.length} 条：本地构建 ${counts.build}、ALLOW_UNPINNED ${counts.allowed}）`,
    );
  }

  if (structure.length > 0 || violations.length > 0) {
    process.exitCode = 1;
    return 1;
  }
  return 0;
}

const HEX64 = "0".repeat(64);
const pin = (ref) => `${ref}@sha256:${HEX64}`;

/** 造一份 compose：每条 image 一个服务块。 */
function composeText(images, { extra = "" } = {}) {
  const lines = ["services:"];
  images.forEach((img, i) => {
    if (typeof img === "object") {
      lines.push(`  ${img.service ?? `svc${i}`}:`);
      if (img.build) lines.push(`    build: ${img.build}`);
      for (const c of img.comments ?? []) lines.push(`    ${c}`);
      lines.push(`    image: ${img.image}`);
      lines.push("    restart: unless-stopped");
    } else {
      lines.push(`  svc${i}:`, `    image: ${img}`, "    restart: unless-stopped");
    }
  });
  return lines.join("\n") + "\n" + extra;
}

/** 造 N 份 compose，每份 perFile 条已固定镜像（默认 4×3=12 条，过下界）。 */
function manyCompose({ files = 4, perFile = 3, mutate = {} } = {}) {
  const out = {};
  for (let f = 0; f < files; f++) {
    const name = f === 0 ? "docker-compose.yml" : `docker-compose.ov${f}.yml`;
    const images = mutate[name] ?? Array.from({ length: perFile }, (_, i) => pin(`postgres:16-alpine`));
    out[name] = composeText(images);
  }
  return out;
}

/**
 * 造 apps 树：apps 个 app，各 1 个 `Dockerfile`、`fromPerApp` 条已固定的 `FROM`。
 *
 * 默认 4×2=8 条 `FROM`，正好踩住 MIN_DOCKERFILE_FILES=4 / MIN_DOCKERFILE_FROM_ENTRIES=8
 * 两条下界——fixture 若不带 apps 树，任何「该绿」的用例都会被下界判红，于是这些
 * 用例就只能断言「有红」，绿的那一半再也测不到。
 */
function appsTree({ apps = 4, fromPerApp = 2 } = {}) {
  const names = ["admin-api", "admin-web", "executor-node", "executor-python", "registry-pypi"];
  const out = {};
  for (let i = 0; i < apps; i++) {
    const stages = [];
    for (let f = 0; f < fromPerApp; f++) {
      stages.push(f === 0 ? `FROM ${pin("node:24-alpine")} AS builder` : `FROM ${pin("node:24-alpine")}`);
      if (f === 0) stages.push("RUN npm ci");
    }
    out[`apps/${names[i % names.length]}/Dockerfile`] = stages.join("\n") + "\n";
  }
  return out;
}

/**
 * 自检：每条用例跑**真子进程**（`--root` 指向临时 fixture 树），断言退出码 + 关键文本。
 *
 * 反证过的历史假绿：注释里的 `image:` 算数、`build:` 变全局豁免、`ALLOW_UNPINNED`
 * 无理由也放行、读不到的文件被静默跳过、扫描面塌到 0 条仍报绿、Dockerfile 的多阶段
 * `FROM builder` / `FROM scratch` 被误判成未固定、`apps` 下的 Dockerfile 整片未被扫到
 * （扫描面只挂在仓库根）、以及「只测函数不测闸门」。
 */
export function selftest() {
  const script = fileURLToPath(import.meta.url);
  const cases = [];
  const withFixture = (files, fn) => () => {
    const repo = makeFixtureRepo(files, { prefix: "image-pinned-selftest-" });
    try {
      fn(repo);
    } finally {
      repo.cleanup();
    }
  };
  const run = (repo) =>
    runGuard(script, { args: ["--root", repo.dir] });
  /** 常规树：4 份 compose（12 条）+ apps 4 个 Dockerfile（8 条 FROM）。 */
  const tree = (extra = {}) => ({ ...manyCompose(), ...appsTree(), ...extra });

  cases.push({
    name: "全部固定 → 绿（4 份 compose / 20 条镜像全带 @sha256）",
    fn: withFixture(tree(), (repo) => {
      const r = expectExit(run(repo), {
        code: 0,
        contains: ["✔ image pinning", "镜像条目 20 条", "全部固定", "Dockerfile 4 个"],
        absent: ["✘", "✖ 结构"],
        label: "全固定",
      });
      expectExit(r, { code: 0, label: "全固定" });
    }),
  });

  cases.push({
    name: "少一个 digest → 红并点名 file:line + 镜像名",
    fn: withFixture(
      (() => {
        const files = tree();
        files["docker-compose.ov2.yml"] = composeText([
          pin("postgres:16-alpine"),
          pin("postgres:16-alpine"),
          "redis:7-alpine", // ← 未固定
        ]);
        return files;
      })(),
      (repo) => {
        const text = readFileSync(repo.pathOf("docker-compose.ov2.yml"), "utf8");
        const lineNo = text.split("\n").findIndex((l) => l.includes("redis:7-alpine")) + 1;
        expectExit(run(repo), {
          code: 1,
          contains: [`docker-compose.ov2.yml:${lineNo}`, "redis:7-alpine", "未固定 digest", "1 处镜像"],
          absent: ["✔ image pinning"],
          label: "少一个 digest",
        });
      },
    ),
  });

  cases.push({
    name: "`build:` 本地构建豁免 → 绿（且豁免作用域是服务块）",
    fn: withFixture(
      (() => {
        const files = tree();
        files["docker-compose.yml"] = composeText([
          { image: "autoflow/admin-api:dev", build: "./apps/admin-api" },
          pin("postgres:16-alpine"),
          pin("postgres:16-alpine"),
        ]);
        return files;
      })(),
      (repo) => {
        expectExit(run(repo), {
          code: 0,
          contains: ["本地构建", "autoflow/admin-api:dev", "✔ image pinning"],
          absent: ["✘"],
          label: "build 豁免",
        });
      },
    ),
  });

  cases.push({
    name: "`ALLOW_UNPINNED: <理由>` 命中 → 绿且理由进输出",
    fn: withFixture(
      (() => {
        const files = tree();
        files["docker-compose.yml"] = composeText([
          {
            image: "minio/minio:RELEASE.2024-10-13T13-34-11Z",
            comments: ["# ALLOW_UNPINNED: Docker Hub 仓库已下线，解析不到 manifest list digest"],
          },
          pin("postgres:16-alpine"),
          pin("postgres:16-alpine"),
        ]);
        return files;
      })(),
      (repo) => {
        expectExit(run(repo), {
          code: 0,
          contains: ["ALLOW_UNPINNED", "Docker Hub 仓库已下线", "minio/minio", "✔ image pinning"],
          absent: ["✘ "],
          label: "allowlist 命中",
        });
      },
    ),
  });

  cases.push({
    name: "`ALLOW_UNPINNED` 无理由 → 红（豁免不能是关灯键）",
    fn: withFixture(
      (() => {
        const files = tree();
        files["docker-compose.yml"] = composeText([
          { image: "whoami/whatever:latest", comments: ["# ALLOW_UNPINNED"] },
          pin("postgres:16-alpine"),
          pin("postgres:16-alpine"),
        ]);
        return files;
      })(),
      (repo) => {
        expectExit(run(repo), {
          code: 1,
          contains: ["ALLOW_UNPINNED 缺理由", "whoami/whatever:latest"],
          absent: ["✔ image pinning"],
          label: "allow 无理由",
        });
      },
    ),
  });

  cases.push({
    name: "compose 文件数塌到下界以下 → 结构红（0 处违规 ≠ 绿）",
    fn: withFixture({ ...manyCompose({ files: 2, perFile: 6 }), ...appsTree() }, (repo) => {
      expectExit(run(repo), {
        code: 1,
        contains: ["✖ 结构", "下界", "判据本身不可信"],
        absent: ["✔ image pinning"],
        label: "文件数下界",
      });
    }),
  });

  cases.push({
    name: "镜像条目数塌到下界以下 → 结构红（compose 无 image:，只靠 apps 的 8 条 FROM）",
    fn: withFixture({ ...manyCompose({ files: 4, perFile: 0 }), ...appsTree() }, (repo) => {
      expectExit(run(repo), {
        code: 1,
        contains: ["镜像条目 8 < 下界 10", "✖ 结构"],
        absent: ["✔ image pinning"],
        label: "条目下界",
      });
    }),
  });

  cases.push({
    name: "compose 读不到（同名目录）→ 结构红，不是静默跳过",
    fn: withFixture(tree(), (repo) => {
      mkdirSync(repo.pathOf("docker-compose.broken.yml"), { recursive: true });
      expectExit(run(repo), {
        code: 1,
        contains: ["✖ 结构", "事实源不可读", "docker-compose.broken.yml"],
        absent: ["✔ image pinning"],
        label: "读不到",
      });
    }),
  });

  cases.push({
    name: "Dockerfile `FROM` 未固定 → 红并点名 Dockerfile:line",
    fn: withFixture(
      tree({
        Dockerfile: ["FROM node:24-alpine", "WORKDIR /app", "COPY . .", `FROM ${pin("node:24-alpine")}`].join("\n"),
      }),
      (repo) => {
        expectExit(run(repo), {
          code: 1,
          contains: ["Dockerfile:1", "node:24-alpine", "未固定 digest"],
          absent: ["✔ image pinning"],
          label: "Dockerfile FROM",
        });
      },
    ),
  });

  cases.push({
    name: "Dockerfile 多阶段 stage 引用 / scratch 不误报 → 绿",
    fn: withFixture(
      tree({
        "Dockerfile.prod": [
          `FROM ${pin("node:24-alpine")} AS builder`,
          "RUN npm ci",
          "FROM builder AS test",
          "FROM scratch",
        ].join("\n"),
      }),
      (repo) => {
        expectExit(run(repo), {
          code: 0,
          contains: ["✔ image pinning", "stage 引用", "scratch"],
          absent: ["✘", "✖ 结构"],
          label: "stage/scratch",
        });
      },
    ),
  });

  // ——apps/*/Dockerfile 进入扫描面后新增的两条（CIR-05 收尾）——
  // 这条钉的是「扫描面扩到了 apps」本身：树与全绿用例只差一个 app 的 FROM，
  // 换成可变 tag。若扫描面退回仓库根，这条 FROM 根本读不到，用例会因为「没红」而失败。
  cases.push({
    name: "apps 下 Dockerfile 的 FROM 未固定 → 红并点名 apps/<app>/Dockerfile:line",
    fn: withFixture(
      tree({
        "apps/executor-node/Dockerfile": ["FROM redis:7-alpine", `FROM ${pin("node:24-alpine")}`].join("\n"),
      }),
      (repo) => {
        expectExit(run(repo), {
          code: 1,
          contains: ["apps/executor-node/Dockerfile:1", "redis:7-alpine", "未固定 digest", "1 处镜像"],
          absent: ["✔ image pinning"],
          label: "apps 未固定",
        });
      },
    ),
  });

  // 反证「apps 扫不到时不会静默报绿」：compose 侧全固定，唯独没有 apps 树。
  // 旧形态（只扫仓库根）在这棵树上会直接判绿——那正是这条用例要拦住的事。
  cases.push({
    name: "apps 目录不存在 → 结构红（apps 的 FROM 一处都没判，不算绿）",
    fn: withFixture(manyCompose(), (repo) => {
      expectExit(run(repo), {
        code: 1,
        contains: ["✖ 结构", "apps/ 目录不存在", "判据本身不可信", "Dockerfile 文件数 0 < 下界 4"],
        absent: ["✔ image pinning"],
        label: "apps 缺失",
      });
    }),
  });

  const failed = reportCases(cases, { title: "check-image-pinned selftest" });
  return failed;
}

// `--root` 只影响主跑的目标树；selftest 一律用自己的 fixture（避免误扫半成品树）。
const rootArgIndex = process.argv.indexOf("--root");
const root = rootArgIndex !== -1 && process.argv[rootArgIndex + 1] ? resolve(process.argv[rootArgIndex + 1]) : DEFAULT_ROOT;

if (process.argv.includes("--selftest")) {
  const failed = selftest();
  process.exit(failed > 0 ? 1 : 0);
} else {
  runCli(root);
}
