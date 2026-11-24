/**
 * updatedApp 跨端 parity 守卫（零依赖）。
 *
 * 背景：后端 apps/admin-api/src/modules/application/dto/app-deployment-response.dto.ts
 * 的 SetCurrentVersionResponseDto / DeployVersionResponseDto 都有 @ApiProperty 必填
 * `updatedApp: ApplicationResponseDto`；openapi.json 与生成物 api-types.ts 也有该字段，
 * 但 admin-web 与 acf-cli 的手写响应接口曾把它丢弃——消费方读不到恢复后的应用状态。
 * 既有的 check-web-type-field-drift 包含度配对把结果 DTO 误配到请求 DTO（0.6 阈值），
 * CLI 又不在任何字段级守卫扫描面，故此处做四处 + 后端两处的显式对拍。
 *
 * 判据（六处全齐才绿）：
 *   ① 后端 SetCurrentVersionResponseDto 有 @ApiProperty 的 updatedApp 声明
 *   ② 后端 DeployVersionResponseDto   有 @ApiProperty 的 updatedApp 声明
 *   ③ web   SetCurrentVersionResult   有 updatedApp 字段
 *   ④ web   DeployVersionResult       有 updatedApp 字段
 *   ⑤ CLI   SetCurrentVersionResult   有 updatedApp 字段
 *   ⑥ CLI   DeployVersionResult       有 updatedApp 字段
 * 任一缺 ⇒ 红并点名 file:line；文件缺失/声明找不到/花括号不配平/定位数塌陷 ⇒ 结构红
 * （反永真：读不到事实时绝不静默绿）。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  expectExit,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

const SELF = fileURLToPath(import.meta.url);

export const DTO_REL =
  "apps/admin-api/src/modules/application/dto/app-deployment-response.dto.ts";
export const WEB_REL = "apps/admin-web/src/api/applications.ts";
export const CLI_REL = "packages/acf-cli/src/commands/apps.ts";

export const TARGETS = [
  { side: "backend", rel: DTO_REL, kind: "class", name: "SetCurrentVersionResponseDto" },
  { side: "backend", rel: DTO_REL, kind: "class", name: "DeployVersionResponseDto" },
  { side: "web", rel: WEB_REL, kind: "interface", name: "SetCurrentVersionResult" },
  { side: "web", rel: WEB_REL, kind: "interface", name: "DeployVersionResult" },
  { side: "cli", rel: CLI_REL, kind: "interface", name: "SetCurrentVersionResult" },
  { side: "cli", rel: CLI_REL, kind: "interface", name: "DeployVersionResult" },
];

/** 剥注释但保留换行与列位置：注释里写个 updatedApp 不算真字段（反永真）。 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote !== null) {
      out += c;
      if (c === "\\") {
        if (i + 1 < src.length) out += next;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 从 `{` 起做花括号配对，返回配对 `}` 所在行号（0-based）；失配返回 -1。 */
function braceBlockEnd(lines, openLine, openAt) {
  let depth = 0;
  for (let i = openLine; i < lines.length; i += 1) {
    for (let j = i === openLine ? openAt : 0; j < lines[i].length; j += 1) {
      if (lines[i][j] === "{") depth += 1;
      else if (lines[i][j] === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

/** 定位 `class|interface NAME { … }`；失败返回带原因的 error（结构红）。 */
function locate(lines, keyword, name) {
  const re = new RegExp(`\\b${keyword}\\s+${name}\\s*\\{`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const openAt = m.index + m[0].length - 1;
    const end = braceBlockEnd(lines, i, openAt);
    if (end < 0) {
      return { error: `第 ${i + 1} 行 ${name} 花括号不配平（源码被截断）` };
    }
    return { start: i, end, body: lines.slice(i, end + 1) };
  }
  return { error: `找不到 ${keyword} ${name} 声明（扫描面塌陷）` };
}

export function check(root) {
  const structural = [];
  const missing = [];
  const facts = [];
  let located = 0;
  const cache = new Map();

  for (const t of TARGETS) {
    let lines = cache.get(t.rel);
    if (lines === undefined) {
      const abs = resolve(root, t.rel);
      if (!existsSync(abs)) {
        structural.push(`结构错误：${t.rel} 不存在（扫描面塌陷）`);
        continue;
      }
      let src;
      try {
        src = readFileSync(abs, "utf8");
      } catch (err) {
        structural.push(`结构错误：${t.rel} 读取失败（${err?.message ?? err}）`);
        continue;
      }
      lines = stripComments(src).split("\n");
      if (lines.join("").trim().length < 40) {
        structural.push(`结构错误：${t.rel} 为空/几乎为空（扫描面塌陷）`);
        continue;
      }
      cache.set(t.rel, lines);
    }

    const block = locate(lines, t.kind, t.name);
    if (block.error) {
      structural.push(`结构错误：${t.rel} ${block.error}`);
      continue;
    }
    located += 1; // 块定位成功；字段缺失是「漂移红」，不能算成「扫描面塌陷」

    if (t.side === "backend") {
      const fi = block.body.findIndex((line) =>
        /^\s*updatedApp\s*:\s*ApplicationResponseDto\s*;/.test(line),
      );
      if (fi < 0) {
        missing.push(
          `${t.rel}:${block.start + 1} ${t.name} 缺 updatedApp 字段（后端必填响应字段）`,
        );
        continue;
      }
      const above = block.body.slice(Math.max(0, fi - 8), fi).join("\n");
      if (!/@ApiProperty\s*\(/.test(above)) {
        missing.push(
          `${t.rel}:${block.start + fi + 1} ${t.name}.updatedApp 缺 @ApiProperty 必填声明`,
        );
        continue;
      }
    } else {
      const fi = block.body.findIndex((line) => /^\s*updatedApp\s*:/.test(line));
      if (fi < 0) {
        missing.push(
          `${t.rel}:${block.start + 1} ${t.name} 缺 updatedApp 字段（消费方读不到恢复后的应用状态）`,
        );
        continue;
      }
    }
    facts.push(`${t.rel}:${block.start + 1} ${t.name}.updatedApp ✓`);
  }

  if (structural.length === 0 && located !== TARGETS.length) {
    structural.push(
      `结构错误：仅定位到 ${located}/${TARGETS.length} 个目标块（扫描面塌陷，反永真）`,
    );
  }
  return { structural, missing, facts };
}

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : null;
}

function report({ structural, missing, facts }) {
  if (structural.length > 0) {
    process.stdout.write("\n✘ updatedApp parity：判据面不可信（结构红）\n\n");
    for (const s of structural) process.stdout.write(`  · ${s}\n`);
    process.stdout.write(
      "\n  这不是「字段齐了」，是**本守卫读不到事实** ⇒ 修事实源或修解析口径（别把判据改成跳过）。\n",
    );
    return 1;
  }
  if (missing.length > 0) {
    process.stdout.write(`\n✘ updatedApp 跨端漂移 ${missing.length} 处：\n\n`);
    for (const m of missing) process.stdout.write(`  · ${m}\n`);
    process.stdout.write(
      "\n  后端 @ApiProperty 必填字段必须同时落到 web 与 CLI 的手写响应接口，否则恢复后的应用状态被丢弃。\n",
    );
    return 1;
  }
  process.stdout.write(
    `✔ updatedApp 跨端对齐：后端 2 个响应 DTO + web 2 个接口 + CLI 2 个接口，${facts.length}/${TARGETS.length} 齐备\n`,
  );
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    runSelftest();
    return;
  }
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") {
      i += 1; // 吃掉 --root 的取值
      continue;
    }
    if (a.startsWith("--root=")) continue;
    unknown.push(a);
  }
  if (unknown.length > 0) {
    process.stderr.write(`未知参数：${unknown.join(", ")}（只认 --root / --selftest）\n`);
    process.exitCode = 2;
    return;
  }
  const rootArg = argValue(argv, "--root");
  const root = resolve(rootArg ?? REPO_ROOT);
  process.exitCode = report(check(root));
}

// ── selftest：临时夹具 + 真子进程（退出码 + 关键文本）─────────────────────────
const DTO_GOOD = `
import { ApiProperty } from "@nestjs/swagger";
export class SetCurrentVersionResponseDto {
  @ApiProperty()
  ok: boolean;
  @ApiProperty({
    type: ApplicationResponseDto,
    description: "恢复后的应用行（已掩码）",
  })
  updatedApp: ApplicationResponseDto;
}
export class DeployVersionResponseDto {
  @ApiProperty()
  ok: boolean;
  @ApiProperty({ type: ApplicationResponseDto })
  updatedApp: ApplicationResponseDto;
}
`;

const WEB_GOOD = `
export interface SetCurrentVersionResult {
  ok: boolean;
  versionId: string;
  updatedApp: components['schemas']['SetCurrentVersionResponseDto']['updatedApp'];
}
export interface DeployVersionResult {
  ok: boolean;
  versionId: string;
  updatedApp: components['schemas']['DeployVersionResponseDto']['updatedApp'];
}
`;

const CLI_GOOD = `
interface SetCurrentVersionResult {
  ok: boolean;
  // set-current 恢复后的应用行
  updatedApp: UpdatedApp;
}
interface DeployVersionResult {
  ok: boolean;
  // deploy 恢复后的应用行
  updatedApp: UpdatedApp;
}
`;

const fixtureTree = ({ dto = DTO_GOOD, web = WEB_GOOD, cli = CLI_GOOD, dropCli = false } = {}) => ({
  [DTO_REL]: dto,
  [WEB_REL]: web,
  ...(dropCli ? {} : { [CLI_REL]: cli }),
});

function runSelftest() {
  printCoverageBanner(import.meta.url, "subprocess");
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "updatedapp-parity-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 5000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("① 四处齐全（后端 2 + web 2 + CLI 2）⇒ 绿", fixtureTree(), {
    code: 0,
    contains: ["updatedApp 跨端对齐", "6/6"],
    absent: ["结构错误", "跨端漂移"],
  });

  subprocess(
    "② web 缺 set-current-version 的 updatedApp ⇒ 红且点名 file:line",
    fixtureTree({
      web: WEB_GOOD.replace(
        "  updatedApp: components['schemas']['SetCurrentVersionResponseDto']['updatedApp'];\n",
        "",
      ),
    }),
    {
      code: 1,
      contains: ["跨端漂移", WEB_REL, "SetCurrentVersionResult 缺 updatedApp"],
      absent: ["updatedApp 跨端对齐"],
    },
  );

  subprocess(
    "③ CLI 缺 deploy-version 的 updatedApp ⇒ 红且点名 file:line",
    fixtureTree({
      cli: CLI_GOOD.replace("  // deploy 恢复后的应用行\n  updatedApp: UpdatedApp;\n", ""),
    }),
    {
      code: 1,
      contains: ["跨端漂移", CLI_REL, "DeployVersionResult 缺 updatedApp"],
      absent: ["updatedApp 跨端对齐"],
    },
  );

  subprocess(
    "④ 后端 DTO 的 @ApiProperty updatedApp 被删 ⇒ 红（事实源也要对拍）",
    fixtureTree({
      dto: DTO_GOOD.replace(
        "  @ApiProperty({\n    type: ApplicationResponseDto,\n    description: \"恢复后的应用行（已掩码）\",\n  })\n  updatedApp: ApplicationResponseDto;\n",
        "",
      ),
    }),
    { code: 1, contains: ["跨端漂移", DTO_REL, "SetCurrentVersionResponseDto 缺 updatedApp"] },
  );

  subprocess(
    "⑤ updatedApp 只写在注释里 ⇒ 红（剥注释后字段不在，反永真）",
    fixtureTree({
      web: WEB_GOOD.replace(
        "  updatedApp: components['schemas']['SetCurrentVersionResponseDto']['updatedApp'];\n",
        "  // updatedApp: components['schemas']['SetCurrentVersionResponseDto']['updatedApp'];\n",
      ),
    }),
    { code: 1, contains: ["跨端漂移", WEB_REL, "SetCurrentVersionResult 缺 updatedApp"] },
  );

  subprocess("⑥ CLI 整份文件被搬走 ⇒ 结构红（扫描面塌陷）", fixtureTree({ dropCli: true }), {
    code: 1,
    contains: ["结构错误", CLI_REL],
    absent: ["updatedApp 跨端对齐"],
  });

  const failed = reportCases(cases, { title: "check-updatedapp-parity selftest" });
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
