/**
 * SEC-02 续：secrets 键名闸门的**三端对等性**。
 *
 * 同一个键名必须让三端给出**同一个结论**：
 *   ① admin-api 的 DTO 校验器（写路径，给用户可读的 400）；
 *   ② executor-node 的 `isInjectableSecretName`（执行器侧兜底）；
 *   ③ executor-python 的 `is_injectable_secret_name`（执行器侧兜底，对等物）。
 *
 * 为什么要专门钉对等性：admin-api 与两个执行器是**独立可发布**的包，没有共享
 * 运行时依赖（admin-api 不能 import executor-node 的源码），所以规则在三处
 * **重述**。重述就会漂移——若 admin 放行 `FOO-BAR` 而执行器静默丢弃它，用户
 * 看到"保存成功"却永远拿不到凭据；若 admin 拒绝而执行器本可接受，则是个
 * 假阳性拦截。两种分叉都比"三端一致地不支持"更难排查。
 *
 * 本文件读**另两端的源码文本**做断言，而不是 import 它们：跨包 import 会让
 * admin-api 的测试依赖 executor-node 的构建产物，且两个执行器分别是 TS 与
 * Python（后者根本无法 import）。源码守卫是这里唯一可行且足够的手段——
 * 任何一侧改了规则集合，本测试转红。
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  describeSecretKeyProblem,
  isInjectableSecretKey,
} from "../secret-key-map.constraint";

/**
 * 向上找仓库根（与 protocol-version-consistency.spec.ts 同款）：jest 的
 * rootDir 是 apps/admin-api，故 `__dirname` 的相对层级会随 jest 配置变化，
 * 用标记文件定位比数 `..` 稳。
 */
function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, "packages", "executor-protocol"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`repo root not found above ${from}`);
}

const REPO_ROOT = findRepoRoot(__dirname);
const NODE_SECRET_ENV = path.join(
  REPO_ROOT,
  "apps/executor-node/src/secret-env.ts",
);
const NODE_ENV_WHITELIST = path.join(
  REPO_ROOT,
  "apps/executor-node/src/env-whitelist.ts",
);
const PY_SECRET_ENV = path.join(
  REPO_ROOT,
  "apps/executor-python/secret_env.py",
);

/**
 * 抽出 `new Set(...)` / `Set[str] = {...}` 字面量里的全部字符串条目。
 *
 * `from` 是集合声明的起始下标。**必须从 `=` 之后开始找括号**：python 侧的写法
 * 是 `_RESERVED_SECRET_NAMES: Set[str] = {`，`Set[str]` 里的 `[` 出现在 `{`
 * 之前，直接取"第一个括号"会截到类型标注 `[str]`（实测得到 0 个条目）。
 */
function extractSetLiteral(src: string, from: number): string[] {
  const eq = src.indexOf("=", from);
  const searchFrom = eq >= 0 ? eq + 1 : from;
  const openBracket = src.indexOf("[", searchFrom);
  const openBrace = src.indexOf("{", searchFrom);
  let start: number;
  let open: string;
  let close: string;
  if (openBrace >= 0 && (openBracket < 0 || openBrace < openBracket)) {
    start = openBrace;
    open = "{";
    close = "}";
  } else if (openBracket >= 0) {
    start = openBracket;
    open = "[";
    close = "]";
  } else {
    return [];
  }
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const body = src.slice(start + 1, end);
  const names: string[] = [];
  const re = /['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) names.push(m[1]);
  return names;
}

/** executor-node 的保留名集合（含 `...ENV_WHITELIST` 展开）。 */
function nodeReservedNames(): Set<string> {
  const src = readFileSync(NODE_SECRET_ENV, "utf-8");
  const decl = src.indexOf("RESERVED_SECRET_NAMES");
  expect(decl).toBeGreaterThan(-1);
  const names = extractSetLiteral(src, decl);
  // 白名单是以展开语法引用的（`...ENV_WHITELIST`），字符串条目里看不见——
  // 必须单独读 env-whitelist.ts 并把它的条目并进来，否则本测试会以为
  // PATH/HOME 这些"没被 node 拒绝"，从而漏掉真正的漂移。
  const usesSpread = src.slice(decl, decl + 800).includes("...ENV_WHITELIST");
  if (usesSpread) {
    const wlSrc = readFileSync(NODE_ENV_WHITELIST, "utf-8");
    names.push(...extractSetLiteral(wlSrc, wlSrc.indexOf("ENV_WHITELIST")));
  }
  return new Set(names.map((n) => n.toUpperCase()));
}

/** executor-python 的保留名集合。 */
function pythonReservedNames(): Set<string> {
  const src = readFileSync(PY_SECRET_ENV, "utf-8");
  const decl = src.indexOf("_RESERVED_SECRET_NAMES");
  expect(decl).toBeGreaterThan(-1);
  return new Set(extractSetLiteral(src, decl).map((n) => n.toUpperCase()));
}

describe("SEC-02 续: secrets 键名闸门的三端对等性", () => {
  const nodeSrc = readFileSync(NODE_SECRET_ENV, "utf-8");
  const pySrc = readFileSync(PY_SECRET_ENV, "utf-8");

  /**
   * 对等样本：每一条都是"某一端曾写对/写错"的真实形状。断言三端结论一致，
   * 而不是断言某个具体值——具体值由各自的单元测试覆盖，这里只钉"不分叉"。
   */
  const PARITY_SAMPLES = [
    // 合法（第三方 SDK 认的规范名）
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "AWS_ACCESS_KEY_ID",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "MY_KEY_1",
    "_private",
    "lowercase_ok",
    // 非法形状
    "",
    "KEY=VALUE",
    "MY KEY",
    "MY-KEY",
    "my.key",
    "1KEY",
    "A/B",
    // 保留名
    "PATH",
    "Path",
    "HOME",
    "TMPDIR",
    "TASK_ID",
    "EXECUTION_ID",
    "EXECUTOR_SHARED_TOKEN",
    "EXECUTION_CALLBACK_SECRET",
    // 前缀规则
    "AUTOFLOW_FOO",
    "PYTHONIOENCODING",
    "PYTHONUTF8",
    "PYTHONPATH",
  ];

  it("解析出的保留名集合非空（反永真：解析器本身没坏）", () => {
    expect(nodeReservedNames().size).toBeGreaterThan(15);
    expect(pythonReservedNames().size).toBeGreaterThan(15);
  });

  it("admin-api 与 executor-node 的判定完全一致", () => {
    const nodeReserved = nodeReservedNames();
    for (const sample of PARITY_SAMPLES) {
      const adminSays = isInjectableSecretKey(sample);
      // node 侧规则重建（与其 isInjectableSecretName 同序：形状 → 保留名 →
      // AUTOFLOW_ → PYTHON）
      const shapeOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sample);
      const upper = sample.toUpperCase();
      const nodeSays =
        shapeOk &&
        !nodeReserved.has(upper) &&
        !upper.startsWith("AUTOFLOW_") &&
        !upper.startsWith("PYTHON");
      expect({ sample, adminSays }).toEqual({ sample, adminSays: nodeSays });
    }
  });

  it("admin-api 与 executor-python 的判定完全一致", () => {
    const pyReserved = pythonReservedNames();
    for (const sample of PARITY_SAMPLES) {
      const adminSays = isInjectableSecretKey(sample);
      const shapeOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sample);
      const upper = sample.toUpperCase();
      const pySays =
        shapeOk &&
        !pyReserved.has(upper) &&
        !upper.startsWith("AUTOFLOW_") &&
        !upper.startsWith("PYTHON");
      expect({ sample, adminSays }).toEqual({ sample, adminSays: pySays });
    }
  });

  it("两个执行器的保留名集合内容相同", () => {
    const nodeReserved = nodeReservedNames();
    const pyReserved = pythonReservedNames();
    // node 侧展开 ENV_WHITELIST，python 侧逐条写死——内容必须同集
    expect([...nodeReserved].sort()).toEqual([...pyReserved].sort());
  });

  it("三端都拒绝 PYTHON* 前缀（I18N-01 的编码开关必须被独占）", () => {
    // 两处修复的交叉点：I18N-01 靠 PYTHONIOENCODING 保证中文日志可读，而
    // SEC-02 的原名注入让用户能设置任意变量名——任一端漏了这条，一个名为
    // PYTHONIOENCODING 的 secret 就能让乱码故障复发。
    expect(nodeSrc).toMatch(/startsWith\('PYTHON'\)/);
    expect(pySrc).toMatch(/startswith\('PYTHON'\)/);
    for (const name of ["PYTHONIOENCODING", "PYTHONUTF8", "PYTHONPATH"]) {
      expect(isInjectableSecretKey(name)).toBe(false);
    }
  });

  it("三端都拒绝 AUTOFLOW_ 前缀（params 命名空间不得被占用）", () => {
    expect(nodeSrc).toMatch(/startsWith\('AUTOFLOW_'\)/);
    expect(pySrc).toMatch(/startswith\('AUTOFLOW_'\)/);
    expect(isInjectableSecretKey("AUTOFLOW_ANYTHING")).toBe(false);
  });

  it("三端都用同一套合法名正则 [A-Za-z_][A-Za-z0-9_]*", () => {
    // 逐字符一致：admin 与 node 同为 TS 正则字面量，python 侧为 r'' 原文串
    expect(nodeSrc).toMatch(
      /SAFE_SECRET_NAME_RE\s*=\s*\/\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$\/;/,
    );
    expect(pySrc).toMatch(/r'\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$'/);
  });

  it("三端都对保留名做大小写归一（npm_config_cache 类陷阱）", () => {
    // 实测教训：ENV_WHITELIST 里有 `npm_config_cache` 这类小写条目，判定用
    // toUpperCase() 而集合未归一 → 大写形态会绕过闸门（executor-node 的
    // `环境白名单里的宿主变量一律拒绝` 实测抓出）。三端都必须归一，只是手段
    // 不同：node/admin 是集合构建时 `.map(n => n.toUpperCase())`，python 是
    // 集合字面量**逐条预大写**——下面断言这一点。
    expect(nodeSrc).toMatch(/\.map\(\(n\) => n\.toUpperCase\(\)\)/);
    const pyEntries = extractSetLiteral(
      pySrc,
      pySrc.indexOf("_RESERVED_SECRET_NAMES"),
    );
    expect(pyEntries.length).toBeGreaterThan(15);
    expect(pyEntries.filter((n) => n !== n.toUpperCase())).toEqual([]);

    // 行为断言：小写形态必须与大写形态同结论
    expect(isInjectableSecretKey("path")).toBe(false);
    expect(isInjectableSecretKey("PATH")).toBe(false);
    expect(isInjectableSecretKey("Npm_Config_Cache")).toBe(false);
    expect(isInjectableSecretKey("npm_config_cache")).toBe(false);
  });

  it("describeSecretKeyProblem 对合法名返回 null、对非法名返回可读原因", () => {
    expect(describeSecretKeyProblem("FEISHU_APP_ID")).toBeNull();
    expect(describeSecretKeyProblem("MY-KEY")).toMatch(/合法的环境变量名/);
    expect(describeSecretKeyProblem("PATH")).toMatch(/保留/);
    expect(describeSecretKeyProblem("AUTOFLOW_X")).toMatch(/AUTOFLOW_/);
    expect(describeSecretKeyProblem("PYTHONUTF8")).toMatch(/PYTHON/);
  });
});
