import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import {
  APPLICATION_MISSING_PATTERN,
  EXECUTOR_OFFLINE_PATTERN,
  INTERPRETER_UNAVAILABLE_PATTERN,
  PACKAGE_FETCH_PATTERN,
  SANDBOX_UNAVAILABLE_PATTERN,
  SCRIPT_ERROR_PATTERN,
  TIMEOUT_PATTERN,
  classifyFailure,
} from "../failure-patterns";
import { ExecutionFailureReason } from "../../../modules/task/entities/task-execution.entity";
import { renderZh } from "../../errors/error-codes";

/**
 * **两条失败路径的归因等值 + 判据单一事实源**守卫（缺陷 H-1 / H-2 的防回归）。
 *
 * ## 背景：同一个概念曾在三个地方各写一遍
 *
 * 失败归因（`failureReason`）决定三件事：**是否烧重试预算**、**用户看到什么**、
 * **运维往哪个方向排障**。而它此前分散在：
 *
 *   · 回调失败路径 —— `task.service.ts::inferFailureReason`
 *   · 派发失败路径 —— `task.processor.ts::handle` 的 catch
 *   · 判据常量 —— 两处**各抄一份**，`task.processor.ts` 另有一份
 *     `SANDBOX_UNAVAILABLE_PATTERN` 的本地副本
 *
 * 漂移已实际发生两次（H-1 / H-2，见下），且方向都是**把"依赖没装上"说成
 * "你的脚本有错"或"执行器离线"**——两者都在**默认重试集**里，于是用户不仅被
 * 指错方向，还白烧重试预算。
 *
 * ## 本 spec 的两层防线
 *
 * ① **行为等值（主）**：同一批**真实文案**，按两条路径**各自的入参形状**各跑
 *    一遍，逐行断言归因等于预期值、且两条路径彼此相等。入参形状取自实现现场：
 *      · 派发：`{ errorMessage: errMsg, logs: errStack, errorCode }`——**无
 *        exitCode**（派发失败时进程根本没跑起来）；
 *      · 回调：`{ errorMessage, logs, exitCode }`——**无 errorCode**（回调另有
 *        `cb.failureReason` 优先采信）。
 *    等值断言本身会退化成"同一个函数调两次"（两条路径现已共用 `classifyFailure`），
 *    所以真正的钉子是与**预期值的逐行比对**；等值断言留作"两侧入参形状不得分叉"
 *    的护栏。
 * ② **结构（辅）**：判据只能有一份物理定义，两个消费者不得再手抄正则。行为断言
 *    只能证明"今天一致"，挡不住"明天有人又抄一份"；结构断言挡的是**分叉这个
 *    动作本身**。
 *
 * ## 这个 spec 抓到过什么（不是假想）
 *
 *  · **H-2**（存量 P1，本轮实修）：`EXECUTOR_OFFLINE_PATTERN` 里的裸子串
 *    `enotfound` 命中 Python 的 `ModuleNotFoundError`（小写后含 `...lenotfound...`）
 *    ⇒ 依赖缺失被判成「执行器离线」。加 `\b` 词边界后修复。
 *  · **H-1 的第二半**：`PACKAGE_FETCH_PATTERN` 原只写了**空格分隔**的
 *    `module not found`，而 Python 原文是**连写**的 `modulenotfounderror` ——
 *    只写前者**根本接不住这一类**。补 `modulenotfounderror` / `no module named` 后修复。
 *
 * 注：派发路径的**端到端**行为（真实 `TaskProcessor.handle` + 落库 `failureReason`）
 * 由 `modules/task/__tests__/task.processor.spec.ts` 的 `LANG-ZH-01` 表覆盖。
 */
describe("派发路径 vs 回调路径：归因等值（H-1 / H-2 防回归）", () => {
  /**
   * 派发路径入参形状（`task.processor.ts::handle` 的 catch）。
   * 真实现传的是 `err.stack`——这里给一段**形状真实**的栈，不用空串，
   * 因为"栈里出现某个词"本身就是历史误判的触发条件之一。
   */
  const dispatchVerdict = (errMsg: string): ExecutionFailureReason =>
    classifyFailure({
      errorMessage: errMsg,
      logs: `Error: ${errMsg}\n    at TaskProcessor.handle (task.processor.ts:424:13)`,
      errorCode: null,
    });

  /** 回调路径入参形状（`task.service.ts::inferFailureReason`）。 */
  const callbackVerdict = (text: string): ExecutionFailureReason =>
    classifyFailure({ errorMessage: text, logs: null, exitCode: null });

  // 中台自产文案走**错误码表渲染**（文案或判据任一侧漂移 → 立刻红）；执行器侧
  // 原文（Python / npm / uv / bwrap）按实际抛出的字符串原样入表。
  const pinnedOfflineZh = renderZh("PINNED_EXECUTOR_OFFLINE", {
    appName: "executor-python-e2e",
    executorId: "8a7e160b-80e5-4dff-b88a-b414908fc9c8",
  });

  /** [文案, 期望归因] —— 两条路径都必须落到这个期望值。 */
  const table: Array<[string, ExecutionFailureReason]> = [
    // ── H-1 / H-2 本体：依赖没装上 ───────────────────────────────────
    ["Cannot find module 'foo'", ExecutionFailureReason.PACKAGE_FETCH_FAILED],
    [
      "Error: Cannot find module '/app/node_modules/left-pad/index.js'",
      ExecutionFailureReason.PACKAGE_FETCH_FAILED,
    ],
    [
      // Python 原文是**连写**的 `ModuleNotFoundError`：这条同时钉住
      // ① 裸子串 `enotfound` 不得命中（H-2）、② 连写形态必须被拉包判据接住。
      "ModuleNotFoundError: No module named 'pandas'",
      ExecutionFailureReason.PACKAGE_FETCH_FAILED,
    ],
    [
      "Traceback (most recent call last):\n  File \"main.py\", line 1\nModuleNotFoundError: No module named 'requests'",
      ExecutionFailureReason.PACKAGE_FETCH_FAILED,
    ],
    [
      "npm install failed with exit code 1",
      ExecutionFailureReason.PACKAGE_FETCH_FAILED,
    ],
    ["git clone 失败：认证被拒绝", ExecutionFailureReason.PACKAGE_FETCH_FAILED],
    ["依赖安装失败：pip install 返回非零", ExecutionFailureReason.PACKAGE_FETCH_FAILED],
    // ── 规则顺序的偏序（改顺序 = 改语义，见 failure-patterns 头注） ────
    [
      "uv venv failed: No interpreter found for Python 3.7",
      ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
    ],
    [
      "interpreter download timeout after 300s",
      ExecutionFailureReason.INTERPRETER_UNAVAILABLE,
    ],
    [
      "bwrap: setting up uid map: Permission denied",
      ExecutionFailureReason.SANDBOX_UNAVAILABLE,
    ],
    [
      "Cannot resolve packageUrl for application 0b7c1f2e not found",
      ExecutionFailureReason.APPLICATION_MISSING,
    ],
    [pinnedOfflineZh, ExecutionFailureReason.EXECUTOR_OFFLINE],
    ["execution timed out after 300s", ExecutionFailureReason.TIMEOUT],
    ["任务执行超时，已强制终止", ExecutionFailureReason.TIMEOUT],
    // ── 真正的脚本错误 / 兜底 ────────────────────────────────────────
    [
      "Traceback (most recent call last): SyntaxError: invalid syntax",
      ExecutionFailureReason.SCRIPT_ERROR,
    ],
    ["脚本错误：命令执行失败", ExecutionFailureReason.SCRIPT_ERROR],
    ["something nobody has classified yet", ExecutionFailureReason.UNKNOWN],
  ];

  for (const [text, expected] of table) {
    it(`同归因：「${text.slice(0, 48)}」→ ${expected}`, () => {
      const fromDispatch = dispatchVerdict(text);
      const fromCallback = callbackVerdict(text);
      // 先各自对齐期望（失败时能直接看出是哪一侧漏了判据），再断言两侧相等。
      expect(fromDispatch).toBe(expected);
      expect(fromCallback).toBe(expected);
      expect(fromDispatch).toBe(fromCallback);
    });
  }

  /**
   * **反向**断言：修 H-2 不能把真正的 DNS / 连接失败一起弄丢。
   * `executor_offline` 的 `\benotfound\b` / `\beconnrefused\b` 词边界必须仍能
   * 命中真实的执行器不可达文案——否则「执行器离线」会整类退化成 UNKNOWN。
   */
  it("反向：真实 DNS/连接失败仍归 EXECUTOR_OFFLINE（词边界不得误伤）", () => {
    for (const text of [
      "getaddrinfo ENOTFOUND registry.npmjs.org",
      "Error: connect ECONNREFUSED 127.0.0.1:8000",
    ]) {
      expect(dispatchVerdict(text)).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
      expect(callbackVerdict(text)).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
    }
  });

  /**
   * H-2 的**直接否定式**钉子：`ModuleNotFoundError` 不得命中离线判据。
   * 这条断言与归因链解耦（只问判据本身），避免"归因表恰好对上了"掩盖判据过宽。
   */
  it("H-2：ModuleNotFoundError 不得命中 EXECUTOR_OFFLINE 判据", () => {
    expect(EXECUTOR_OFFLINE_PATTERN.test("modulenotfounderror: no module named 'x'")).toBe(
      false,
    );
    expect(PACKAGE_FETCH_PATTERN.test("ModuleNotFoundError")).toBe(true);
    // 词边界不能把真实的 ENOTFOUND 也挡掉。
    expect(EXECUTOR_OFFLINE_PATTERN.test("getaddrinfo ENOTFOUND host")).toBe(true);
  });

  /**
   * 回调路径有一条派发路径**刻意没有**的分支：`exitCode`。
   *
   * 派发失败时进程根本没跑起来，拿不到退出码；回调路径的「非 0 退出码 ⇒
   * script_error」是执行器已经跑完才有的事实。把这条**已知不对称**钉成规格，
   * 避免有人把它当"漂移"顺手抹平，也解释上面的等值表为什么统一不带 `exitCode`。
   */
  it("已知不对称：exitCode 是回调路径独有的兜底证据（派发路径无退出码）", () => {
    expect(classifyFailure({ errorMessage: "boom", exitCode: 1 })).toBe(
      ExecutionFailureReason.SCRIPT_ERROR,
    );
    expect(classifyFailure({ errorMessage: "boom" })).toBe(
      ExecutionFailureReason.UNKNOWN,
    );
  });

  /**
   * 码化优先通道（派发路径的 `errorCode`）：命中码表即**确定性归因**，不看文案。
   * 派发路径在 catch 里传 `errorCode`，回调路径不传——第二条已知、刻意的形状差异。
   */
  it("派发路径的码化优先：命中码表即确定性归因，文案不得翻案", () => {
    expect(
      classifyFailure({
        // 文案本身会被 TIMEOUT 规则命中——码表必须赢。
        errorMessage: "任务执行超时，已强制终止",
        errorCode: "PINNED_EXECUTOR_OFFLINE",
      }),
    ).toBe(ExecutionFailureReason.EXECUTOR_OFFLINE);
  });
});

/**
 * 结构守卫：判据只有**一份物理定义**，消费者不得再手抄副本。
 *
 * ## 判据为什么这么选（误报率优先）
 *
 * ① **常量定义处唯一**：`PACKAGE_FETCH_PATTERN` 等 7 个名字在 `src/` 下只能被
 *    `failure-patterns.ts` **定义**（`const NAME`）。消费者只能 `import`/`re-export`。
 *    这一条与实现细节解耦：判据内部措辞随便改，断言不动。
 * ② **消费者必须走唯一入口**：`task.processor.ts` / `task.service.ts` 必须 import
 *    `classifyFailure`，且**不得**再定义上述常量。
 * ③ **判据令牌零出现**：两个消费者源码里不得出现判别性字串（见 `TOKENS` 注释）。
 *    ②挡"起个新名字再抄一份"，③挡"匿名正则直接内联"。
 *
 * 刻意**不**纳入的脆弱判据：整段正则字面量比对（措辞一改就红）、行号/格式匹配、
 * 注释措辞。已知盲区：抄一条支路且恰用 `TOKENS` 之外的词——那种情况由上面的
 * 行为等值表兜住（两侧结果一旦不同就红）。
 */
describe("结构守卫：判据单一事实源（consumer 不得再手抄）", () => {
  const SRC_ROOT = join(__dirname, "../../..");
  const SHARED_FILE = "common/failure-classification/failure-patterns.ts";
  const PATTERN_NAMES = [
    "INTERPRETER_UNAVAILABLE_PATTERN",
    "EXECUTOR_OFFLINE_PATTERN",
    "SANDBOX_UNAVAILABLE_PATTERN",
    "APPLICATION_MISSING_PATTERN",
    "TIMEOUT_PATTERN",
    "PACKAGE_FETCH_PATTERN",
    "SCRIPT_ERROR_PATTERN",
  ];

  /**
   * 判别性令牌 —— 只可能出现在**分类正则**里的多词 ASCII 字串（日常注释不会
   * 自然写到）。刻意排除 `git clone` / `pip install` / `bwrap` / `requirements`
   * / `超时` 等词：它们在两个消费者的说明性注释里合法出现（讲判据为什么这么写），
   * 纳入就成了"改注释即红"的脆弱断言。
   */
  const TOKENS = [
    "module not found",
    "cannot find module",
    "modulenotfounderror",
    "no module named",
    "pull package",
    "download package",
    "socket hang up",
    "traceback",
    "syntaxerror",
    "referenceerror",
    "command failed",
  ];

  const consumers = [
    {
      file: "task.processor.ts（派发失败路径）",
      path: join(SRC_ROOT, "modules/task/task.processor.ts"),
    },
    {
      file: "task.service.ts（回调失败路径）",
      path: join(SRC_ROOT, "modules/task/task.service.ts"),
    },
  ];

  for (const { file, path } of consumers) {
    it(`${file} 走唯一入口（import classifyFailure）且不再定义判据常量`, () => {
      const source = readFileSync(path, "utf8");
      expect(source).toContain(
        'from "../../common/failure-classification/failure-patterns"',
      );
      expect(source).toContain("classifyFailure");
      for (const name of PATTERN_NAMES) {
        // `const NAME` / `export const NAME` 才算"定义"；re-export 与 import 不算。
        expect(new RegExp(`\\bconst\\s+${name}\\b`).test(source)).toBe(false);
      }
    });

    it(`${file} 内没有内联的分类正则副本（0 处判据令牌）`, () => {
      const source = readFileSync(path, "utf8").toLowerCase();
      // 失败信息带出命中的令牌，便于直接定位"又抄了一份"的位置。
      expect(TOKENS.filter((token) => source.includes(token))).toEqual([]);
    });
  }

  it(`全 src/ 只有 ${SHARED_FILE} 定义这些判据常量`, () => {
    const definers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // dist/ 是构建产物（在 src 之外，但保持防御）；spec 不看。
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) {
          continue;
        }
        const rel = full.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");
        const source = readFileSync(full, "utf8");
        if (PATTERN_NAMES.some((name) => new RegExp(`\\bconst\\s+${name}\\b`).test(source))) {
          definers.push(rel);
        }
      }
    };
    walk(SRC_ROOT);
    expect(definers).toEqual([SHARED_FILE]);
  });

  /**
   * 判据自身的完整性：本轮修好的两条**原文**必须永远在 PACKAGE_FETCH 里，且
   * SCRIPT_ERROR 不得吞掉它们（H-1 的根因就是"依赖缺失"被判成"脚本错误"）。
   */
  it("共享判据包含依赖缺失的三种原文形态（含 Python 连写）", () => {
    for (const text of [
      "cannot find module 'foo'", // Node
      "module not found", // 带空格的历史形态
      "ModuleNotFoundError", // Python 连写（H-2 修复点）
      "No module named 'x'", // Python 原文的另一半
    ]) {
      expect(PACKAGE_FETCH_PATTERN.test(text)).toBe(true);
      expect(SCRIPT_ERROR_PATTERN.test(text)).toBe(false);
    }
    // 其余判据仍在位（防"删掉一条支路"式重构）。
    expect(TIMEOUT_PATTERN.test("timed out")).toBe(true);
    expect(EXECUTOR_OFFLINE_PATTERN.test("no available executor")).toBe(true);
    expect(INTERPRETER_UNAVAILABLE_PATTERN.test("no interpreter found")).toBe(true);
    expect(SANDBOX_UNAVAILABLE_PATTERN.test("bwrap")).toBe(true);
    expect(APPLICATION_MISSING_PATTERN.test("cannot resolve packageurl")).toBe(true);
  });
});
