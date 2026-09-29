/**
 * cron 规范化（写边界等价改写）：把调度器（node-cron）不接受、但 POSIX/Vixie
 * 语义合法的「裸 n/step」写法（如 `12/20`）改写为 node-cron 可注册的等价
 * 显式范围形式 `n-max/step`（如 `12-59/20`）。
 *
 * ## 为什么存在（cron UX 统一）
 *
 * 用户从 Linux crontab / Quartz 等方言迁移时天然会写 `12/20`（POSIX/Vixie
 * 语义：n..max 步进 step，vixie-cron 源码即如此展开；本仓 maintenance-window
 * util 的 parseField 与前端预览器同语义）。此前 DTO 门直接按 nodeCron.validate
 * 拒绝 → 「能预览、存不进」。现在在**写边界**做等价改写：用户语法不打折，
 * 存储始终是调度器可注册的规范式，调度/维护窗口/展示全链路零特判。
 *
 * `n/step ≡ n-max/step` 是展开语义上的严格等价（两者展开集合完全一致），
 * 不是近似替换——单测会以 node-cron 实际触发时刻验证。
 *
 * ## 只改形态、不判语义
 *
 * 本工具只做**结构规范化**，不做越界/合法性判定（那是 DTO 门 +
 * nodeCron.validate 的职责）：越界/倒序/步进 0 的部分原样透传或返回 null
 * （结构不可解析时），由上层校验统一拒绝——避免第二套口径。
 * 规范化是幂等的：规范式输入原样返回。
 */

/** 各字段上限（分 时 日 月 周），裸 n/step 改写为显式范围时使用 */
const FIELD_MAXES = [59, 23, 31, 12, 7] as const;

/** 各字段合法取值区间（与上限同源；分钟/小时下界 0，日/月 1） */
const FIELD_BOUNDS: Array<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** 单部分结构：`*`、数字、范围、步进的自由组合（与预览器/窗口同款字符集） */
const FIELD_PART_RE = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

/**
 * 逐字段**界内守卫**：数值部分必须落在字段区间内且范围不倒序、步进 ≥1。
 *
 * 为什么必须有这一道：node-cron v4 的 validate 对**越界/倒序范围**放行——
 * `70-59/20 * * * *`（分钟越界+倒序）与 `12-5 * * * *`（倒序）validate 均
 * 返回 true、schedule 不抛错，但**永不触发**（静默失效）；单值越界
 * （`70 * * * *`）它才拒绝。前端预览器与维护窗口 parseField 对这两种形态
 * 都拒绝（越界/lo>hi → null）。本守卫使判定与那两方同口径，闭环
 * 「可保存 ⇒ 调度器真实可触发 ⇒ 预览可解析」，堵住存量门的静默失效洞。
 *
 * 输入应是**规范化后**的表达式（裸 n/step 已改写为显式范围）。
 */
export function isCron5FieldInBounds(expr: string): boolean {
  const fields = expr.trim().replace(/\s+/g, " ").split(" ");
  if (fields.length !== FIELD_MAXES.length) return false;
  for (let i = 0; i < fields.length; i++) {
    const [min, max] = FIELD_BOUNDS[i];
    for (const part of fields[i].split(",")) {
      const m = FIELD_PART_RE.exec(part);
      if (!m) return false;
      if (m[3] !== undefined && parseInt(m[3], 10) < 1) return false;
      if (m[1] === "*") continue;
      const lo = parseInt(m[1], 10);
      const hi = m[2] !== undefined ? parseInt(m[2], 10) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
      if (lo < min || hi > max || lo > hi) return false;
    }
  }
  return true;
}

/**
 * 规范化 5 字段 cron 表达式。
 * 返回 null 的情形：非字符串/空串、字段数 ≠ 5、出现结构不可解析的部分
 * （非数字字符集、步进 0 等）——即「没法等价改写」的情形，由上层拒绝。
 */
export function normalizeCron5Field(expr: unknown): string | null {
  if (typeof expr !== "string") return null;
  const trimmed = expr.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  const fields = trimmed.split(" ");
  if (fields.length !== FIELD_MAXES.length) return null;

  let changed = false;
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const parts = fields[i].split(",");
    const rewritten: string[] = [];
    for (const part of parts) {
      const m = FIELD_PART_RE.exec(part);
      if (!m) return null;
      if (m[1] !== "*" && m[2] === undefined && m[3] !== undefined) {
        // 裸 n/step → n-max/step（POSIX n..max/step 的显式范围形式）
        const step = parseInt(m[3], 10);
        if (!Number.isInteger(step) || step < 1) return null;
        changed = true;
        rewritten.push(`${m[1]}-${FIELD_MAXES[i]}/${step}`);
        continue;
      }
      rewritten.push(part);
    }
    out.push(rewritten.join(","));
  }
  return changed ? out.join(" ") : trimmed;
}
