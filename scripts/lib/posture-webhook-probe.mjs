/**
 * R75：**webhook 面决策层的真跑探针**（不建模、不复刻判定逻辑）。
 *
 * ## 为什么用子进程 + `--experimental-strip-types`
 * 被测函数是 **TypeScript**（`apps/admin-api/src/common/utils/outbound-posture.util.ts`，W3 在 `3b72ba52` 抽出的零依赖纯函数）。
 * 本守卫是 `.mjs`，直接 `import` `.ts` 需要 loader；Node 24 的 `--experimental-strip-types` 子进程是**零依赖**方案
 * （无需 `tsx`/`ts-node`），且**真的执行实现**（不是读源码文本）。
 *
 * ## 测试接缝
 * `POSTURE_UTIL_SRC=<path>` 可指向实现副本（红→绿验证用，**不改 `apps/**`**）。
 *
 * ## 边界（如实）
 * 只判**决策层**：`given risk × metadata × allowPrivateNetwork ⇒ allowed?`。
 * 「地址 → risk」那一步仍带 Nest 依赖（W3 遗留①），**本探针不覆盖**（由 `check-posture-matrix-tables` 的地址字面量面兜住"不硬编码"）。
 */
import { spawnSync } from "node:child_process";

const DEFAULT_UTIL = "apps/admin-api/src/common/utils/outbound-posture.util.ts";

/**
 * 真跑一批输入，返回与 inputs **同序**的 verdict 数组。
 * @param {{risk:string, metadata:boolean, allowPrivateNetwork:boolean}[]} inputs
 * @param {{root:string}} opts
 */
export function probeWebhookVerdicts(inputs, { root }) {
  const rel = process.env.POSTURE_UTIL_SRC ?? DEFAULT_UTIL;
  const script = `
import { pathToFileURL } from "node:url";
const utilPath = process.env.PROBE_UTIL;
const inputs = JSON.parse(process.env.PROBE_INPUTS);
const m = await import(pathToFileURL(utilPath).href);
const out = inputs.map((i) =>
  m.evaluateOutboundPosture({ ...i, posture: "webhook" }),
);
process.stdout.write(JSON.stringify(out));
`;
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PROBE_UTIL: `${root}/${rel}`, PROBE_INPUTS: JSON.stringify(inputs) },
    },
  );
  if (r.status !== 0) {
    return { error: `真跑失败（exit ${r.status ?? "?"}）：${String(r.stderr ?? "").split("\n")[0]}` };
  }
  const line = String(r.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    return { verdicts: JSON.parse(line) };
  } catch {
    return { error: `真跑输出不是 JSON：${line.slice(0, 120)}` };
  }
}
