/**
 * TypeORM 1.x null-in-where 源码守卫（回归锁）。
 *
 * 背景：bb0a872f 把 typeorm 从 ^0.3 升到 ^1.1.1。TypeORM 1.x 新增
 * `invalidWhereValuesBehavior`，把 null 与 undefined **默认都设为 "throw"**
 * ——where 里的 null 字面量不再编译成 `IS NULL`，而是直接抛
 * `Null value encountered in property '<Entity>.<field>' of a where condition`。
 * 本仓库未配置该选项，故抛错默认生效。
 *
 * 这个破坏性变更在本仓库**连续命中三处**，且每处都只在真机路径暴露
 * （单测把仓储 mock 掉了，所以全绿）：
 *   1. event-subscriptions/event-subscription.service.ts  `{ userId: null }`
 *      → 普通用户拉订阅列表恒 500（e2e-full case 40 抓到）
 *   2. application/app-deployment.service.ts  `gitCommit: app.gitCommit ?? null`
 *      → **整个应用部署推送到执行器失败**（selftests 抓到；
 *        statusMessage 原文可见该报错）
 *   3. application/application.service.ts  `sourceDeploymentId: null`
 *      → 上传应用包时的版本快照去重查找抛错
 *
 * 排查这三处的代价很高（需要真机/CI 才能看见），所以用本守卫把整类问题
 * 钉死在源码层：禁止 `find/findOne/findAndCount/count/update/delete/
 * findBy/createQueryBuilder...where()` 的 where 对象里出现 null 字面量，
 * 必须改用 `IsNull()`。
 *
 * 为什么是源码扫描而不是行为测试：行为测试需要一个真实 DB，而本项目大量
 * 单测走 mock 仓储（正是这些缺陷漏网的原因）。源码守卫在**推送前本地**即可
 * 判定，与 CI 无关，且对本类「写法即缺陷」的问题足够精确。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// 本文件位于 src/common/utils/__tests__/，故 src 根在其上三级。
// （首版误写成两级 -> 实际只扫了 src/common，守卫对 src/modules/** 恒不生效
//   却"通过"，属最隐蔽的空转；下方用「已扫描文件数」断言把它钉死。）
const SRC_ROOT = join(__dirname, "..", "..", "..");

/** 递归收集 src 下的 .ts（排除测试与迁移）。 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      collectSources(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (/\.spec\.ts$|\.test\.ts$|\.d\.ts$/.test(entry)) continue;
    // 迁移是裸 SQL，不经过 TypeORM 的 where 编译，不受该破坏性变更影响。
    if (full.includes(`${sep}migrations${sep}`)) continue;
    out.push(full);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * 用**花括号深度**跟踪对象字面量作用域：只有当 `null` 所在的这一层对象
 * 是由 `where:` / `.where(` 打开的，才算违规。这样就能把合法的写入
 * （`create({ gitCommit: x ?? null })`、`save`、`.set({...})`）与违规的
 * 条件（`where: {...}`）区分开——只做"附近有没有 where"的窗口匹配会把前者
 * 误判，也会漏判（见下方反证用例钉住的两种形态）。
 */
function findNullInWhere(file: string): Violation[] {
  return scanText(readFileSync(file, "utf8"), file);
}

/** 对任意源码文本执行检测（守卫本体；文件扫描与反证用例共用同一条路径）。 */
function scanText(text: string, file = "<inline>"): Violation[] {
  const lines = text.split(/\r?\n/);
  const found: Violation[] = [];

  // where 作用域用「待进入」标记表示：见到 `where:` / `.where(` 后，下一个
  // 出现的 `{` 或 `[` 即视为该 where 值的起点，其存活期内出现的 null 均判为
  // 违规。关键点：作用域按**起点所在层**配平退出，而不是"遇到第一个 }"就退出
  // ——`where: [{ userId: id }, { userId: null }]` 里第一个 `}` 只是数组元素
  // 的结束，此刻仍在 where 作用域内（这是本守卫首版漏判的形态）。
  // 这样同时覆盖三种真实写法：
  //   where: { a: null }              （当行）
  //   where: [{ a: null }]            （当行，数组内，可含多个元素）
  //   where: {\n  a: null,\n}         （多行）
  // 而 create({...}) / save / .set({...}) 这类写入对象不在 where 作用域内，
  // 因此不会被误报。
  let depth = 0;
  let whereScopeDepth = -1; // where 值起点所在的外层 depth；-1 = 不在 where 内
  let pendingWhere = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/\bwhere\b\s*:/.test(line) || /\.where\s*\(/.test(line)) {
      pendingWhere = true;
    }

    for (let c = 0; c < line.length; c++) {
      const ch = line[c];

      if (ch === "{" || ch === "[") {
        if (pendingWhere) {
          // where 值的起点：记录其外层 depth，直到该层配平才退出作用域。
          whereScopeDepth = depth;
          pendingWhere = false;
        }
        depth++;
        continue;
      }
      if (ch === "}" || ch === "]") {
        depth = Math.max(0, depth - 1);
        if (whereScopeDepth >= 0 && depth === whereScopeDepth) {
          whereScopeDepth = -1;
        }
        continue;
      }
      // 命中形如 `: null` 或 `: x ?? null` 的值位置。
      if (ch === ":") {
        const rest = line.slice(c + 1);
        if (
          /^\s*(null|[A-Za-z_$][\w$.?[\]]*\s*\?\?\s*null)\s*(,|\}|\]|$)/.test(
            rest,
          )
        ) {
          if (whereScopeDepth >= 0 || pendingWhere) {
            found.push({ file, line: i + 1, text: line.trim() });
          }
        }
      }
    }
  }
  return found;
}

describe("TypeORM 1.x null-in-where 源码守卫", () => {
  it("src 下不得在 where 条件里使用 null 字面量（必须用 IsNull()）", () => {
    const files = collectSources(SRC_ROOT);

    // 防空转：守卫必须真的覆盖到 src/modules（三处已知缺陷都在那里）。
    // 若 SRC_ROOT 写错（首版就错了一级），扫描集会退化成 src/common 而
    // 断言依然"通过"——本断言让这种静默失效直接转红。
    expect(files.some((f) => f.includes(`${sep}modules${sep}`))).toBe(true);
    expect(files.some((f) => f.endsWith(`app-deployment.service.ts`))).toBe(
      true,
    );
    expect(files.length).toBeGreaterThan(200);

    const violations = files.flatMap(findNullInWhere);

    const pretty = violations
      .map((v) => `  ${relative(SRC_ROOT, v.file)}:${v.line}  ${v.text}`)
      .join("\n");

    expect(
      violations.length === 0
        ? ""
        : `发现 where 里的 null 字面量（TypeORM 1.x 会抛错，请改用 IsNull()）：\n${pretty}`,
    ).toBe("");
  });

  it("守卫自身有效：能抓出已知的 null-in-where 形态（反证）", () => {
    // 用真实检测器跑四种真实形态：两种必须红、两种必须绿。
    // 这些字符串就是本仓库实际出现过的代码形态（含造成部署全失败的那处）。
    const BAD_1 = [
      "class S {",
      "  async f(app: any, deployment: any) {",
      "    const existing = await this.versionRepo.findOne({",
      "      where: {",
      "        applicationId: app.id,",
      "        version: app.version,",
      "        gitCommit: app.gitCommit ?? null,",
      "        sourceDeploymentId: deployment.id,",
      "      },",
      "    });",
      "  }",
      "}",
    ].join("\n");

    const BAD_2 = [
      "class S {",
      "  async f(user: any) {",
      "    return this.subRepo.find({",
      "      where: [{ userId: user.id }, { userId: null }],",
      "      take: 500,",
      "    });",
      "  }",
      "}",
    ].join("\n");

    const GOOD_WRITE = [
      "class S {",
      "  async f(app: any) {",
      "    await this.versionRepo.save(",
      "      this.versionRepo.create({",
      "        applicationId: app.id,",
      "        gitCommit: app.gitCommit ?? null,",
      "      }),",
      "    );",
      "  }",
      "}",
    ].join("\n");

    const GOOD_FIXED = [
      "class S {",
      "  async f(app: any) {",
      "    return this.versionRepo.findOne({",
      "      where: {",
      "        applicationId: app.id,",
      "        gitCommit: app.gitCommit != null ? app.gitCommit : IsNull(),",
      "        sourceDeploymentId: IsNull(),",
      "      },",
      "    });",
      "  }",
      "}",
    ].join("\n");

    const scan = (text: string) => scanText(text);

    expect(scan(BAD_1)).toHaveLength(1);
    expect(scan(BAD_2)).toHaveLength(1);
    // 写入路径（create/save 的对象）不得误报。
    expect(scan(GOOD_WRITE)).toHaveLength(0);
    // 已修好的 IsNull() 形态不得误报。
    expect(scan(GOOD_FIXED)).toHaveLength(0);
  });
});
