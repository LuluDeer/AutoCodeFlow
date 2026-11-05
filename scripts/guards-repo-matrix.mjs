#!/usr/bin/env node
/**
 * R21（2026-11-05）：`test:guards:repo` 的**可观测性入口** —— 运行期解析 + 逐条报告 + 失败点名。
 *
 * ## 为什么需要它（R02 只解决了"不撒谎"，没解决"说不清"）
 *
 * `test:guards:repo` 是一条 **89 段扁平 `&&` 链**。任何一段失败时：
 * · 你只看到**链尾** `guard-chain-fail.mjs` 的兜底 banner（R02 的成果：不再以 ✔ 收尾）；
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
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_NAME = "test:guards:repo";

/** 从 package.json 解析出各段命令（**唯一事实源**：链本身）。 */
export function parseChain(root = ROOT) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const raw = pkg.scripts?.[SCRIPT_NAME];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`package.json 里没有 ${SCRIPT_NAME}`);
  }
  // 链尾兜底 `|| node scripts/guard-chain-fail.mjs $?` 是 R02 的失败收尾器，不是"一段守卫"，
  // 必须剥掉；若 `||` 出现在别的位置 ⇒ 结构超出本解析器的理解范围，**fail-closed**（宁可红）。
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

function main(argv) {
  const listOnly = argv.includes("--list");
  const fromArg = argv.find((a) => a.startsWith("--from="));
  const from = fromArg ? Math.max(1, Number(fromArg.slice(7)) || 1) : 1;

  const { segments, fallback } = parseChain();
  const total = segments.length;
  if (listOnly) {
    segments.forEach((cmd, i) => console.log(`[${i + 1}/${total}] ${cmd}`));
    console.log(`\n解析 ${total} 段${fallback ? `（链尾兜底已剥离：${fallback}）` : ""}`);
    return 0;
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
  for (let i = from - 1; i < total; i += 1) {
    const cmd = segments[i];
    if (executed.length > 0 || i === from - 1) executed.push(cmd);
    const r = spawnSync("sh", ["-c", cmd], { cwd: ROOT, stdio: "inherit" });
    const code = r.status ?? 1;
    console.log(`[${i + 1}/${total}] ${cmd.slice(0, 100)} => exit ${code}`);
    if (code !== 0) {
      console.error("");
      console.error(`✘ 第 ${i + 1}/${total} 条失败：${cmd}`);
      console.error(`  退出码 ${code}（原样传播，不吞；后续 ${total - i - 1} 段未执行）`);
      return code;
    }
  }

  // ── 等量性断言（防少跑）：执行序列 == **独立重新解析**出的序列 ──
  // 关键：这里必须**重新从 package.json 解析一次**，不能拿本次运行用的 `segments` 自比——
  // 否则「把解析换成硬编码列表并少一条」这种缺陷会自比自洽、静默少跑（反向验证会绿）。
  const expected = parseChain().segments.slice(from - 1);
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
      `${from > 1 ? `（本次从第 ${from} 段开始，属断点续跑）` : `（与 ${SCRIPT_NAME} 的 && 切分逐条一致）`}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`✘ 守卫矩阵入口失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
