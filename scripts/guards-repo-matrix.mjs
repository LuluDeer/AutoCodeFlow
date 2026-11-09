#!/usr/bin/env node
/**
 * R21（2026-11-05）：`test:guards:repo` 的**可观测性入口** —— 运行期解析 + 逐条报告 + 失败点名。
 *
 * ## 为什么需要它（R02 只解决了"不撒谎"，没解决"说不清"）
 *
 * `test:guards:repo` 是一条 **89 段扁平 `&&` 链**。任何一段失败时：
 * · 你只看到**链尾**兜底 banner（R02 加了 `guard-chain-fail.mjs`；**R22 起该脚本已退役**，职责并入本脚本）；
 * · 但**没人告诉你第几段挂了** —— 89 段里靠人肉往上翻，长日志里极难定位。
 *
 * ## 本脚本做什么（只加可观测性，**不动链结构**）
 *
 * 1. **运行期解析**：从 `package.json` 的 `test:guards:repo` **当场切分**出各段，
 *    **不维护手写列表**（手写列表就是漂移源：链改了它不改，判据静默少跑）。
 * 2. **逐条执行 + 逐条报告**：`[k/N] <cmd> => exit N`，一眼看出谁慢谁挂。
 * 3. **失败即停 + 点名 + 原样传播退出码**：`✘ 第 k/N 条失败：<cmd>（exit N）`，然后 `exit N`
 *    —— 不吞退出码、也不继续往后跑（后半程依赖前面的产物，继续跑只会制造二次噪声）。
 * 4. **等量性断言（防少跑）**：执行序列必须与解析序列**逐条相等**，并打印
 *    `解析 N 段 / 执行 N 段 / diff 空`。任何"跳过一段"都会在这里红。
 *
 * ## 与旧链的关系
 *
 * **并存**：`test:guards:repo`（旧链）行为本轮**一个字不改**；
 * 本入口是 `test:guards:repo:matrix`。等 89/89 等量验证过、下一轮再由 ADR/状态卡决定是否替换。
 *
 * ## 用法
 *
 *   node scripts/guards-repo-matrix.mjs            # 逐段执行并报告
 *   node scripts/guards-repo-matrix.mjs --list     # 只解析并打印段清单（不执行，秒级）
 *   node scripts/guards-repo-matrix.mjs --from=40  # 从第 40 段开始（断点续跑/调试用）
 *
 * ## R153：失败报文补「这一段自己说了什么」（stderr/stdout 尾部）
 *
 * 旧的失败报文只有三行：段号 + 命令 + 退出码。实际排障时**不够**——本轮实测两次链红
 * （第 6/102 段 `check:ssrf-parity`）都只能看到「第 6 段 exit 1」，原因（并发互踩的
 * ENOENT）在上方几十段输出里，得人肉往上翻几百行。守卫的真正诊断信息在**它自己的
 * stderr** 里。
 *
 * 改法：把该段子进程的 stdout/stderr **边跑边透传**（保留原有的实时可见性，不牺牲
 * 长段的进度感），同时用**环形缓冲**留最近 `TAIL_LINES` 行；失败时把这**两段尾部**
 * 原样回放进失败报文。这样「红在哪一段」与「这一段为什么红」在同一处出现。
 *
 * 不变的语义：仍然 fail-fast、仍然原样传播退出码、仍然逐段打印 `[k/N] … => exit N`。
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// R22：链定义搬进内部键 `test:guards:chain`（`test:guards:repo` 现在指向本脚本，不能再当链读）。
// 兼容：若 `test:guards:chain` 不存在（旧提交/分支），回落到 `test:guards:repo` 且**要求它含 `&&`**，
// 否则说明它已经是指针了 ⇒ fail-closed（绝不把单段命令当成"89 段链"去执行）。
const CHAIN_SCRIPT = "test:guards:chain";
const LEGACY_SCRIPT = "test:guards:repo";

/** 从 package.json 解析出各段命令（**唯一事实源**：链本身）。 */
export function parseChain(root = ROOT) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  let raw = scripts[CHAIN_SCRIPT];
  let source = CHAIN_SCRIPT;
  if (typeof raw !== "string" || raw.trim() === "") {
    raw = scripts[LEGACY_SCRIPT];
    source = LEGACY_SCRIPT;
    if (typeof raw === "string" && !raw.includes("&&")) {
      throw new Error(
        `${CHAIN_SCRIPT} 缺失，且 ${LEGACY_SCRIPT} 已不是链（不含 "&&"）—— ` +
          `拒绝把单段命令当成链执行（fail-closed）`,
      );
    }
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`package.json 里既没有 ${CHAIN_SCRIPT} 也没有可用的 ${LEGACY_SCRIPT}`);
  }
  void source;
  // 链尾兜底（R02 的 `|| node scripts/guard-chain-fail.mjs $?`，R22 已退役）不是"一段守卫"，
  // 兼容旧分支仍把它剥掉；若 `||` 出现在别的位置 ⇒ 结构超出解析器理解范围，**fail-closed**（宁可红）。
  const orParts = raw.split("||");
  if (orParts.length > 2) {
    throw new Error(`链里出现 ${orParts.length - 1} 个 "||" —— 结构超出解析器理解范围，拒绝猜测`);
  }
  const body = orParts[0];
  const segments = body
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (segments.length === 0) throw new Error("解析出 0 段 —— 解析器失效（不是链为空）");
  return { segments, fallback: orParts[1]?.trim() ?? null };
}

/** 环形缓冲：只留最近 N 行（失败回放用；不改变实时透传）。 */
function makeTail(n) {
  const lines = [];
  return {
    push(chunk) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() === "") continue;
        lines.push(line);
        if (lines.length > n) lines.shift();
      }
    },
    text() {
      return lines.join("\n");
    },
    size() {
      return lines.length;
    },
  };
}

/** 失败回放的行数上限（够看清守卫的报错，又不至于把整份日志再刷一遍）。 */
const TAIL_LINES = 20;

/**
 * 跑一段命令：stdout/stderr **实时透传**给当前进程，同时各留一个尾部环形缓冲。
 * 用异步 `spawn` 而不是 `spawnSync` 的原因：`spawnSync` 要么 `inherit`（拿不到内容）、
 * 要么 `pipe`（整段跑完才一次性吐出来，长段会失去进度感）。
 */
function runSegment(cmd) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd: ROOT });
    const outTail = makeTail(TAIL_LINES);
    const errTail = makeTail(TAIL_LINES);
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      outTail.push(d);
    });
    child.stderr.on("data", (d) => {
      process.stderr.write(d);
      errTail.push(d);
    });
    child.on("error", (err) => {
      resolve({ code: 1, signal: null, outTail: outTail.text(), errTail: `spawn 失败：${err.message}` });
    });
    child.on("close", (code, signal) => {
      // 被信号杀死时 `code` 为 null ⇒ 用 1（非零即失败），并把信号名记进报文
      resolve({ code: code ?? 1, signal, outTail: outTail.text(), errTail: errTail.text() });
    });
  });
}

async function main(argv) {
  const listOnly = argv.includes("--list");
  // R50：单段执行能力（便于在"链上下文"里复现某一段；默认行为不变）
  //   --only <k>     只跑第 k 段（等价于 --start-at k 且只跑一段）
  //   --start-at <k> 从第 k 段开始跑到底（与 --from=<k> 同义，保留两个名字因为立项里这么叫）
  const takeNum = (flag) => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const at = argv.indexOf(flag);
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  };
  const onlyRaw = takeNum("--only");
  const startAtRaw = takeNum("--start-at");
  const fromArg = argv.find((a) => a.startsWith("--from="));
  const fromRaw = startAtRaw ?? (fromArg ? fromArg.slice(7) : null);
  const from = fromRaw ? Math.max(1, Number(fromRaw) || 1) : 1;
  const only = onlyRaw ? Number(onlyRaw) : null;

  const { segments, fallback } = parseChain();
  const total = segments.length;
  if (listOnly) {
    segments.forEach((cmd, i) => console.log(`[${i + 1}/${total}] ${cmd}`));
    console.log(`\n解析 ${total} 段${fallback ? `（链尾兜底已剥离：${fallback}）` : ""}`);
    return 0;
  }

  // R50：单段参数校验（越界/非法 ⇒ 明确报错 + exit≠0，绝不"忽略参数跑全链"）
  for (const [flag, val] of [["--only", onlyRaw], ["--start-at", startAtRaw]]) {
    if (val === null) continue;
    const n = Number(val);
    if (!Number.isInteger(n)) {
      console.error(`✘ ${flag} 需要一个整数段号，收到：${val}`);
      return 2;
    }
    if (n < 1 || n > total) {
      console.error(
        `✘ ${flag} 越界：第 ${n} 段不存在（本链共 ${total} 段，合法区间 1..${total}）`,
      );
      return 2;
    }
  }
  if (only !== null && onlyRaw !== null && !Number.isInteger(only)) {
    console.error(`✘ --only 需要一个整数段号，收到：${onlyRaw}`);
    return 2;
  }

  // fail-fast：本次要跑的段数必须与独立解析一致（少跑/多跑都在开跑前红）
  const truthAll = parseChain().segments;
  if (truthAll.length !== total) {
    console.error(
      `✘ 解析结果与 package.json 不一致：本次持有 ${total} 段 / 独立解析 ${truthAll.length} 段`,
    );
    return 1;
  }

  const executed = [];
  const endIdx = only !== null ? only : total; // --only k ⇒ 只跑第 k 段（1-based）
  const startIdx = only !== null ? only - 1 : from - 1;
  for (let i = startIdx; i < endIdx; i += 1) {
    const cmd = segments[i];
    executed.push(cmd);
    const r = await runSegment(cmd);
    const code = r.code;
    console.log(`[${i + 1}/${total}] ${cmd.slice(0, 100)} => exit ${code}`);
    if (code !== 0) {
      console.error("");
      console.error(`✘ 第 ${i + 1}/${total} 条失败：${cmd}`);
      console.error(
        `  退出码 ${code}${r.signal ? `（signal ${r.signal}）` : ""}（原样传播，不吞；后续 ${total - i - 1} 段未执行）`,
      );
      // R153：把**这一段自己**的 stderr / stdout 尾部回放出来。传统上它们已经实时出现在
      // 上方输出里，但一次链跑动辄几千行 ⇒ 「原因」与「结论」被拉开几十屏。这里重放一份，
      // 让「红在哪一段」和「这一段为什么红」落在同一处。
      const tailBlocks = [
        ["stderr 尾部", r.errTail],
        ["stdout 尾部", r.outTail],
      ];
      for (const [label, body] of tailBlocks) {
        if (!body) continue;
        console.error(`  ── ${label}（最近 ${TAIL_LINES} 行）──`);
        for (const line of body.split("\n")) console.error(`  │ ${line}`);
      }
      if (!r.errTail && !r.outTail) {
        console.error("  （该段没有任何输出 ⇒ 大概率是 exit code 自己就是信号：看上面的退出码/signal）");
      }
      return code;
    }
  }

  // ── 等量性断言（防少跑）：执行序列 == **独立重新解析**出的序列 ──
  // 关键：这里必须**重新从 package.json 解析一次**，不能拿本次运行用的 `segments` 自比——
  // 否则「把解析换成硬编码列表并少一条」这种缺陷会自比自洽、静默少跑（反向验证会绿）。
  const expected =
    only !== null
      ? parseChain().segments.slice(only - 1, only)
      : parseChain().segments.slice(from - 1);
  const sameLength = executed.length === expected.length;
  const firstDiff = expected.findIndex((c, idx) => c !== executed[idx]);
  if (!sameLength || firstDiff !== -1) {
    console.error("");
    console.error("✘ 等量性断言失败：执行序列与解析序列不一致（疑似跳过/篡改了某段）");
    console.error(`  解析 ${expected.length} 段 / 执行 ${executed.length} 段`);
    if (firstDiff !== -1) {
      console.error(`  首个差异在第 ${firstDiff + 1} 段：解析=${expected[firstDiff]}`);
      console.error(`                        执行=${executed[firstDiff]}`);
    }
    return 1;
  }
  console.log("");
  console.log(
    `✔ 全链通过：解析 ${expected.length} 段 / 执行 ${expected.length} 段 / diff 空` +
      `${only !== null ? `（本次仅执行第 ${only} 段 / 共 ${total} 段，属单段复现模式）` : from > 1 ? `（本次从第 ${from} 段开始，属断点续跑）` : `（与 ${CHAIN_SCRIPT} 的 && 切分逐条一致）`}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`✘ 守卫矩阵入口失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
