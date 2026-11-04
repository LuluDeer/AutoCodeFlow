#!/usr/bin/env node
/**
 * 守卫链失败终端（`test:guards:repo` 的 `||` 兜底）。
 *
 * ## 为什么存在
 *
 * `test:guards:repo` 是 **85 段 `&&` 链**。某一段失败时 `&&` 语义是**对**的
 * （后面的守卫确实不跑、npm 退出码确实非零 —— 2026-11-05 R02 实测 `exit=1`），
 * 但**报告面是错的**：失败段的输出不是链路输出的结尾，`sh` 不会替你说「链断了」。
 *
 * 实测（R02，`artifacts/autonomy/R02/before-test-docs.log`）：
 * `test:docs` 因孤儿文档失败时 exit=1，但它自己的报告里失败项排在中段
 * （`check-docs.mjs` 旧 `main()` 按 CHECKS 声明顺序打印），随后 3 条通过的判据
 * 继续打 `✔` —— 于是整条链可见的最后 4 行**全是 ✔**。人读尾部判绿，agent 读
 * 尾部判绿。退出码是唯一的真话，而没人读退出码。
 *
 * 兜底判据：**链只要非零退出，最后说出口的话必须是 ✘**。
 * `test:guards:repo` 末尾挂 `|| node scripts/guard-chain-fail.mjs $?`，
 * 全部通过时本脚本不执行，语义零影响。
 *
 * ## 退出码
 *
 * 原样传播链的退出码（`$?` 传入），传不进来时退化为 1。**绝不返回 0**：
 * 这个脚本存在的前提就是「链已经失败了」，返回 0 会把失败洗成成功。
 */

const raw = process.argv[2];
const code = Number.parseInt(String(raw ?? ""), 10);
const finalCode = Number.isInteger(code) && code !== 0 ? code : 1;

const line = "─".repeat(72);
console.error("");
console.error(line);
console.error("✘ 守卫链中断：test:guards:repo 非零退出（exit " + finalCode + "）");
console.error("  · 后面的守卫**没有跑**，这不是「全部通过」，也不是「只差一点」；");
console.error("  · 真实原因在上方最后一条 ✘ / 非零退出的子命令里；");
console.error("  · 需要逐条计数时跑：npm run test:guards:repo:report");
console.error(line);
console.error("");

process.exit(finalCode);
