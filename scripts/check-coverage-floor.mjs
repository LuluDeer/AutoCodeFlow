#!/usr/bin/env node
/**
 * R137（2026-11-07）：**覆盖率下限棘轮**（`check:coverage-floor`）。
 *
 * ## 为什么
 * 仓库此前只有「尺寸棘轮」（`source-size-baseline.json` + `check:size-caps`），
 * **没有任何守卫阻止覆盖率下滑** —— `docs/health-baseline.md` 只是记录，掉下去也没人红。
 *
 * ## 判据
 * 基线 `scripts/coverage-floor-baseline.json` 的 `ends.<端>.floor` 与**实测**比较：
 * · 实测 **<** floor ⇒ **红**，报文含「实测 vs 基线 vs 差多少」+ 两条改法（补测试 / 下调基线并写 why + 批准）；
 * · 实测 **>** floor ⇒ 绿，并**提示可上调**（棘轮只往紧的方向走）；
 * · **拿不到数据**（`docs/health-baseline.json` 缺该端或 `coveragePct` 为 null）⇒ **红**并教怎么跑 —— 不许静默绿；
 * · **测量本身失败**（该 step 的 `code !== 0` 或 `signal` 非空）⇒ **红**，报文点名「pct 不可信」。
 *   R138 实测到的真缺陷：旧实现只取 `summary.coveragePct` 看数字，**从不看 `step.code`** ⇒ 测试套件
 *   跑挂（甚至被 SIGTERM 杀）时，只要台账里留着上次数值就照样判绿 —— 那是「拿一次失败的测量去
 *   证明覆盖率没掉」。现在先判测量是否成立，再判数字。
 *
 * ## R140（2026-11-07）：**数据新鲜度**判据（`maxAgeDays`）
 * 缺口（R138 评估 `artifacts/autonomy/R138/assess-coverage.md` §5 + PLAYBOOK §7.0 `coverage-floor-freshness`）：
 * 本守卫此前**只读数字、不看数据多旧**。`docs/health-baseline.json` 里有 `generatedAt`
 * （由 `scripts/health-snapshot.mjs` 写入），但**没有任何守卫读它** ⇒ 拿一份几周前的旧基线照样判绿。
 * R138 把棘轮扩到 executor-node（单端刷新 17–18s）后，再扩 admin-api（180–310s）/ web（774s）就是
 * **5–13min/端** ⇒「跑完整条链才能刷一次基线」会逼着人复用旧快照，棘轮就长期拿旧数字判绿 ——
 * 那正是它要防的那件事。
 *
 * 判据：`scripts/coverage-floor-baseline.json` 的 `ends.<端>.maxAgeDays`（**可选**，正整数，粒度=自然日）。
 * · **声明了** ⇒ 先读 `generatedAt` 判新鲜度，再判覆盖率：
 *   - `generatedAt` 缺失 / 不可解析 ⇒ **红**：「基线没有生成时间，无法判断新鲜度」（不静默绿）；
 *   - `今天 - generatedAt` > `maxAgeDays` ⇒ **红**：「实测数据已过期 N 天（上限 M 天）⇒ 数字不可信」，
 *     并按端教刷新命令；此时**不判覆盖率高低**（过期数据的高/低都无意义），过期这一条仍作为 error 列出；
 *   - 没超期 ⇒ 走 R137/R138 那套（测量是否成立 → 与 floor 比）。
 * · **未声明** ⇒ 保持 R137/R138 现状：**不因新鲜度红**。这正是本判据的**盲区**：
 *   不声明的端，数据放多久都只按数字判 —— 逐端声明是唯一解法，新增端时要一并声明。
 *
 * **粒度为什么是天、不是小时**：`generatedAt` 由 `health-snapshot.mjs` 的 `localDateString()` 写成
 * `YYYY-MM-DD`（本地日历日，**没有时刻**）⇒ 只能按自然日比较；做小时级判断等于凭空造一个不存在的时间点。
 * 故字段名是 `maxAgeDays`（整数天），过期判据 = `天数 > maxAgeDays`。
 * **不要**改 `health-snapshot.mjs` 的 `generatedAt` 口径（生成物语义，改了历史基线不可比），
 * 也**不要**手改 `docs/health-baseline.json` 的 `generatedAt`。
 *
 * 其它口径（都不许静默）：
 * · `maxAgeDays` 写成非正整数（含字符串 `"14"`）⇒ **结构红**（声明了就必须真能判）；
 * · `generatedAt` 晚于今天（跨时区 / 时钟回拨）⇒ 按 **0 天**算且**不**判红（否则 UTC 机器跑会天天误红），
 *   但会在输出里点名这一事实（不静默）；
 * · 过期 / 无时间戳的端，连「测量失败 / 拿不到数据」也不再重复报 —— 当前动作只有一个：**刷新数据**。
 *
 * 已知盲区（R140 遗留）：
 * · `npm run health:snapshot -- --skip-heavy` 会前移 `generatedAt` 却**不重跑**四端全量 ⇒ 它能消红但
 *   并不能证明数据是新的（本守卫只能看日期，看不出「日期前移了、数字没动」）；
 * · 反过来，单端刷新（`npm run coverage:node`）只改该步的 `coveragePct`、**不动** `generatedAt` ⇒
 *   真把某一端跑新了也**解不了红**。两个方向都指向同一个根治：per-step 时间戳（生成物语义，本轮按指令不动）。
 *
 * 用法：node scripts/check-coverage-floor.mjs [--root=<dir>] [--selftest]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
export const BASELINE_REL = "scripts/coverage-floor-baseline.json";
export const HEALTH_REL = "docs/health-baseline.json";
/** 基线端名 → `docs/health-baseline.json` 里的 step label 关键词。 */
export const END_LABEL_HINTS = {
  "executor-python": "executor-python",
  // R138：executor-node 是第二条接进棘轮的端（此前只有 python 一端有 floor ⇒ 棘轮半只眼）
  "executor-node": "executor-node",
  // R142：admin-api 是第三条。
  //
  // ⚠ **为什么这端的 hint 必须特异到「默认环境」这一层**：`docs/health-baseline.json` 里有**两个**
  // 含 "admin-api" 的 step —— ①「admin-api 全量（默认环境，`npm test -- --maxWorkers=2`）」与
  // ②「admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态）」。它们是**两套环境变量下的两次测量**
  // （后者跳过 .env 夹具），数字不同、口径不同。旧规则 `steps.find(s => label.includes(hint))`
  // 只取**第一个命中**：此刻碰巧取对了，但那是**数组顺序**的巧合 —— 一次重排、一个新增同名步，
  // 就会静默把另一套环境变量的数字当成「默认环境」的值来判棘轮。
  // 故这里用足够特异的子串「admin-api 全量（默认环境」定位默认环境那步，并配合
  // `END_LABEL_EXCLUDES` 显式排除 SELFTEST 那步（双保险：两边都指向同一个结论）。
  "admin-api": "admin-api 全量（默认环境",
};

/**
 * 与 `END_LABEL_HINTS` 配对的**排除**子串：label 里含它 ⇒ 该 step **不是**本端要比较的那一步。
 *
 * 为什么需要（双 step 陷阱）：admin-api 有「默认环境」与「`SELFTEST_SKIP_ENV_FILE=1` 夹具干净态」两条测量；
 * 棘轮只能比较**其中一条**（默认环境 = 常态部署口径）。若只靠 hint 的 `find` 取第一个，
 * 选中的就是「碰巧排在前面那条」而不是「规则判定那条」—— 这在重排/新增后会静默漂移。
 */
export const END_LABEL_EXCLUDES = {
  "admin-api": ["SELFTEST_SKIP_ENV_FILE"],
};

/**
 * 按 `{ hint, exclude }` **确定性**选出该端要比较的 step（返回全部候选，调用方断唯一性）。
 *
 * 与 `scripts/coverage-snapshot.mjs` 的 `selectStep` **同一套规则**（写步与读步必须指向同一步，
 * 否则「写进去的数字」和「判棘轮读的数字」不是同一个东西 —— 那是最难查的一种假绿）。
 *
 * 命中 0 步 ⇒ 读不到数据（红）；命中 >1 步 ⇒ 判据面有歧义（红，拒绝猜）。
 */
export function selectStep(steps, hint, exclude = []) {
  return (Array.isArray(steps) ? steps : []).filter((s) => {
    const label = String(s?.label ?? "");
    return label.includes(hint) && !exclude.some((x) => label.includes(x));
  });
}

/**
 * 基线端名 → 「该端的实测数据怎么来」的跑法（报文里教人的那一条，**按端取**）。
 *
 * R138 修的是旧报文的错教：以前所有端共用一句 `cd apps/executor-python && python3 -m pytest --cov`，
 * 对 node 端那是**跑不通的药方**（node 端没有 pytest）。缺一条就退到全量体检，绝不硬塞别端的命令。
 */
export const END_RUN_HINTS = {
  "executor-python": "`cd apps/executor-python && python3 -m pytest --cov`",
  "executor-node": "`npm run coverage:node`（真跑 `npx jest --coverage --coverageReporters=json-summary` 并回写 `coveragePct`）",
  "admin-api": "`npm run coverage:api`（真跑 `npx jest --coverage --coverageReporters=json-summary --maxWorkers=2` 并回写 `coveragePct`）",
};

const runHint = (end) => END_RUN_HINTS[end] ?? "该端尚无单端快照脚本（见 `scripts/health-snapshot.mjs` 对应步）";

/**
 * R140：**今天的本地日历日**（`YYYY-MM-DD`）。
 *
 * 与 `scripts/health-snapshot.mjs` 的 `localDateString()` **同口径**（`sv-SE` + 显式时区 ⇒ 直接是
 * `YYYY-MM-DD`，按本机时区、可被 `HEALTH_TZ` 覆盖）。刻意**不** import 那个模块：它是生成器，
 * 顶层就会跑体检；为 6 行格式化去 import 等于引入一次副作用（R45/R46 教训）。
 * 也不许用 `toISOString().slice(0,10)`：那是 UTC 日期，UTC+8 的凌晨会差一天（`health-snapshot.mjs` 记过这条）。
 */
export function todayDateOnly(now = new Date(), timeZone = process.env.HEALTH_TZ ?? undefined) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(now);
}

/**
 * 严格解析 `YYYY-MM-DD` ⇒ 该日历日 00:00 的 **UTC 毫秒**（只当「同一历法下的日差标尺」用，不代表真实时刻）。
 *
 * 为什么严格：`Date.parse("2026-02-31")` 会被静默归一化成 3-03 ⇒ 一个**写错的日期**看起来新鲜。
 * 为什么回环校验：只有回环能识别归一化。不可解析一律返回 `null`（调用方据此判红，不许猜）。
 */
export function parseDateOnly(raw) {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/**
 * `generatedAt` 距今多少个**自然日**（`generatedAt` 新 ⇒ 正数；晚于今天 ⇒ 负数；任一侧不可解析 ⇒ `null`）。
 *
 * 两侧都锚到 UTC 00:00 再相减 ⇒ 只差整数天，不受 DST / 时区偏移影响（不做小时级判断，见头注）。
 */
export function ageInDays(generatedAt, today = todayDateOnly()) {
  const g = parseDateOnly(generatedAt);
  const t = parseDateOnly(today);
  if (g === null || t === null || !Number.isFinite(g) || !Number.isFinite(t)) return null;
  return Math.round((t - g) / 86_400_000);
}

/**
 * 判**一端**的新鲜度（只在该端声明了 `maxAgeDays` 时调用）。
 *
 * 返回 `{ expired, error?, hint? }`：
 * · 判不了（缺时间戳 / 不可解析）也是一种「不新鲜到无法判断」⇒ `expired: true` + 报错（不静默绿）；
 * · `expired: true` 时调用方**不再比 floor**（过期数据的高/低都没意义）；
 * · `hint` 是该端「日期晚于今天」时的可见提示（不红，只点名）。
 */
export function judgeFreshness(end, maxAgeDays, generatedAt, today = todayDateOnly()) {
  const parsed = parseDateOnly(generatedAt);
  if (parsed === null) {
    return {
      expired: true,
      error:
        `${end}：**基线没有生成时间，无法判断新鲜度**（\`${HEALTH_REL}\` 的 \`generatedAt\` = ` +
        `${JSON.stringify(generatedAt)}，不可解析为 \`YYYY-MM-DD\`）⇒ 声明了 \`maxAgeDays\` 的端` +
        `**不许在「不知道数据多旧」的情况下判绿**。刷新：\`npm run health:snapshot\`（全量体检，会重写 generatedAt）`,
    };
  }
  const age = ageInDays(generatedAt, today);
  if (age === null) {
    // 到不了这里（两侧已校验过）；留着是为了错误不被 `null > n` 静默吃掉。
    return {
      expired: true,
      error: `${end}：无法计算新鲜度（generatedAt=${JSON.stringify(generatedAt)}，今天=${today}）⇒ 不许静默绿`,
    };
  }
  if (age < 0) {
    return {
      expired: false,
      hint:
        `${end}：\`generatedAt\`（${generatedAt}）**晚于**今天（${today}）⇒ 按 0 天算、不判红` +
        `（跨时区 / 时钟回拨会这样；若确认是手写未来日期，请当成「没有可信时间戳」处理）`,
    };
  }
  if (age > maxAgeDays) {
    return {
      expired: true,
      error:
        `${end}：**实测数据已过期 ${age} 天（上限 ${maxAgeDays} 天）⇒ 数字不可信**` +
        `（\`${HEALTH_REL}\` 的 \`generatedAt\`=${generatedAt}，今天 ${today}；粒度=自然日，因为 generatedAt 只有日期没有时刻）⇒ ` +
        `本次**不判覆盖率高低**（过期数据的高/低都没意义）。刷新：①按端重测 ${runHint(end)}；` +
        `②把数字落回基线并前移 \`generatedAt\`：\`npm run health:snapshot\`（全量体检 30–40min，` +
        `是目前唯一会重写 generatedAt 的那条）`,
    };
  }
  return { expired: false };
}

/** 过期时只提示一次的那条「洗白路径」警告（`--skip-heavy` 会前移日期但不重跑全量）。 */
const SKIP_HEAVY_WARNING =
  "⚠ `npm run health:snapshot -- --skip-heavy` 只前移 generatedAt、**不重跑**四端全量 ⇒ " +
  "拿它消红等于把旧数字洗成新日期（R140 遗留①，本守卫只看日期，看不出来）";

export function check(root = REPO_ROOT) {
  const errors = [];
  const hints = [];
  const baselinePath = join(root, BASELINE_REL);
  if (!existsSync(baselinePath)) return [`读不到基线 ${BASELINE_REL} —— 覆盖率棘轮失去对象（先按模板建一份）`];
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (e) {
    return [`${BASELINE_REL} 不是合法 JSON：${e.message}`];
  }
  const ends = baseline.ends ?? {};
  if (Object.keys(ends).length === 0) return [`${BASELINE_REL} 的 ends 为空 —— 判据面塌方`];

  const healthPath = join(root, HEALTH_REL);
  if (!existsSync(healthPath)) {
    return [
      `读不到 ${HEALTH_REL}（覆盖率实测来源）⇒ **不许静默绿**。` +
        `跑法：\`npm run health:snapshot\`（全量体检，各端步会产出 coveragePct）或该端的单端快照脚本（见下）`,
    ];
  }
  let health;
  try {
    health = JSON.parse(readFileSync(healthPath, "utf8"));
  } catch (e) {
    return [`${HEALTH_REL} 不是合法 JSON：${e.message}`];
  }
  const steps = health.steps ?? [];
  const today = todayDateOnly();
  // R140 计数：判了新鲜度的端 / 过期的端 / 没声明 maxAgeDays 的端（最后一个必须可见 —— 那是盲区，不许静默）。
  let freshJudged = 0;
  let freshExpired = 0;
  let freshUndeclared = 0;
  let skipHeavyWarned = false;

  for (const [end, cfg] of Object.entries(ends)) {
    const floor = Number(cfg.floor);
    if (!Number.isFinite(floor)) {
      errors.push(`${BASELINE_REL} 的 \`ends.${end}.floor\` 不是数字：${cfg.floor}`);
      continue;
    }
    // R140 结构判据：`maxAgeDays` 若声明，必须是**正整数**（粒度=自然日）。
    // 写成 `"14"` / `0` / `-1` 都红：声明了新鲜度却判不了，比没声明更坏（看起来已经守住了）。
    const declaresFreshness = cfg.maxAgeDays !== undefined && cfg.maxAgeDays !== null;
    let maxAgeDays = null;
    if (declaresFreshness) {
      if (typeof cfg.maxAgeDays !== "number" || !Number.isInteger(cfg.maxAgeDays) || cfg.maxAgeDays <= 0) {
        errors.push(
          `${BASELINE_REL} 的 \`ends.${end}.maxAgeDays\` 不是正整数：${JSON.stringify(cfg.maxAgeDays)}` +
            `（粒度=自然日；声明了新鲜度就必须能真判 —— 要么写 14 这样的整数，要么整条删掉）`,
        );
        continue;
      }
      maxAgeDays = cfg.maxAgeDays;
    }
    // R140 新判据：**数据新鲜度先于覆盖率高低**。过期 / 无时间戳 ⇒ 数字不可信 ⇒ 不再拿它跟 floor 比；
    // 连「测量失败 / 拿不到数据」也不再重复报（当前动作只有一个：刷新数据），但过期这一条会作为 error 列出。
    if (maxAgeDays !== null) {
      const fresh = judgeFreshness(end, maxAgeDays, health.generatedAt, today);
      if (fresh.hint) hints.push(fresh.hint);
      if (fresh.expired) {
        freshExpired += 1;
        errors.push(fresh.error);
        if (!skipHeavyWarned) {
          hints.push(SKIP_HEAVY_WARNING);
          skipHeavyWarned = true;
        }
        continue;
      }
      freshJudged += 1;
    } else {
      freshUndeclared += 1;
    }
    const hint = END_LABEL_HINTS[end] ?? end;
    const exclude = END_LABEL_EXCLUDES[end] ?? [];
    // R142：**确定性选步**（不再是 `steps.find(...)` 取第一个命中）。
    // admin-api 有两条含 "admin-api" 的测量（默认环境 / SELFTEST_SKIP_ENV_FILE 夹具干净态），
    // 「取第一个」只是碰巧对；这里按「含特异子串 且 不含排除子串」挑，并要求**命中唯一**。
    const candidates = selectStep(steps, hint, exclude);
    if (candidates.length > 1) {
      errors.push(
        `${end}：**选步命中 ${candidates.length} 条 step，拒绝比较**（提示词「${hint}」/ 排除「${exclude.join("、") || "无"}」）⇒ ` +
          `选哪条都是猜：` +
          candidates.map((c) => `「${String(c?.label ?? "")}」`).join("、") +
          `。修法：把默认环境那步的 label 改得更特异，或把另一条也加进 \`END_LABEL_EXCLUDES.${end}\``,
      );
      continue;
    }
    const step = candidates[0];
    // R138 新判据：**先判测量成立，再判数字**。step 在但 code≠0（或被信号杀）⇒ pct 不可信。
    // 旧实现只看 pct ⇒ 「套件跑挂 + 台账留着上次数值」照样绿，那是最贵的一种假绿。
    const stepCode = step?.code;
    const stepFailed =
      Boolean(step && step.signal) ||
      (stepCode !== undefined && stepCode !== null && Number(stepCode) !== 0);
    if (stepFailed) {
      errors.push(
        `${end}：**测量本身失败，pct 不可信**（\`${HEALTH_REL}\` 的 step「${step.label}」实测 exit ${stepCode}` +
          `${step.signal ? ` / signal ${step.signal}` : ""}）⇒ 覆盖率门不许在测试套件挂着的时候判绿。` +
          `跑法：${runHint(end)}（先把该端测试跑到 exit 0，再谈覆盖率）`,
      );
      continue;
    }
    const actual = Number(step?.summary?.coveragePct);
    if (!step || !Number.isFinite(actual)) {
      errors.push(
        `${end}：**拿不到覆盖率数据**（\`${HEALTH_REL}\` 里没有含「${hint}」且带 \`coveragePct\` 的 step）⇒ 不许静默绿。` +
          `跑法：${runHint(end)}；或 \`npm run health:snapshot\`（全量体检）`,
      );
      continue;
    }
    if (actual < floor) {
      errors.push(
        `${end} 覆盖率**低于基线**：实测 ${actual}% < 基线 ${floor}%（差 ${(floor - actual).toFixed(2)}pt）⇒ ` +
          `改法①补测试把覆盖率补回去；改法②确需下调 ⇒ 改 \`${BASELINE_REL}\` 的 floor 并写 \`why\` + 谁批准（下调=放宽棘轮，需评审可见）`,
      );
    } else if (actual > floor) {
      hints.push(`${end} 实测 ${actual}% > 基线 ${floor}% ⇒ **可上调基线**（棘轮只往紧的方向走）：把 floor 改成 ${actual}`);
    }
  }
  console.log(
    `（覆盖率棘轮：比较 ${Object.keys(ends).length} 端；新鲜度：判 ${freshJudged} 端` +
      `${freshExpired ? `（过期 ${freshExpired}）` : ""} / 未声明 maxAgeDays ${freshUndeclared} 端；` +
      `实测来源 ${HEALTH_REL}；今天 ${today}）`,
  );
  for (const h of hints) console.log(`   · ${h}`);
  errors.meta = { ends: Object.keys(ends).length, hints: hints.length, freshJudged, freshExpired, freshUndeclared };
  return errors;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });
  const tree = (floor, actual) => ({
    [BASELINE_REL]: JSON.stringify({ ends: { "executor-python": { floor } } }, null, 2),
    [HEALTH_REL]: JSON.stringify(
      { generatedAt: "2026-11-07", steps: [{ label: "executor-python 全量（`python3 -m pytest`）", code: 0, signal: null, summary: { coveragePct: actual } }] },
      null,
      2,
    ),
  });
  push("正例：实测 == 基线 ⇒ exit 0", () => {
    const repo = makeFixtureRepo(tree(87.45, 87.45));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally { repo.cleanup(); }
  });
  push("反例①：实测低于基线 ⇒ exit 1 且点名差值", () => {
    const repo = makeFixtureRepo(tree(87.95, 87.45));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["低于基线", "差 0.50pt"], withinMs: 20000, label: "低于基线",
      });
    } finally { repo.cleanup(); }
  });
  push("反例②：拿不到覆盖率数据 ⇒ exit 1 且教怎么跑", () => {
    const repo = makeFixtureRepo({
      [BASELINE_REL]: JSON.stringify({ ends: { "executor-python": { floor: 87.45 } } }),
      [HEALTH_REL]: JSON.stringify({ steps: [{ label: "admin-api", summary: {} }] }),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["拿不到覆盖率数据", "health:snapshot"], withinMs: 20000, label: "无数据",
      });
    } finally { repo.cleanup(); }
  });
  push("反例③：实测高于基线 ⇒ exit 0 且提示可上调", () => {
    const repo = makeFixtureRepo(tree(87.0, 87.45));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "可上调" });
    } finally { repo.cleanup(); }
  });
  // R138 新增三条：① 测量本身失败（code≠0）⇒ 红；② 两端都达标 ⇒ 绿且报「比较 2 端」；③ 缺 node 数据 ⇒ 红。
  const twoEnds = ({ pyFloor = 87.45, nodeFloor = 88.88, pyPct = 87.45, nodePct = 88.88, nodeCode = 0, nodeSignal = null } = {}) => ({
    [BASELINE_REL]: JSON.stringify(
      { ends: { "executor-python": { floor: pyFloor }, "executor-node": { floor: nodeFloor } } },
      null,
      2,
    ),
    [HEALTH_REL]: JSON.stringify(
      {
        generatedAt: "2026-11-07",
        steps: [
          { label: "executor-python 全量（`python3 -m pytest`）", code: 0, signal: null, summary: { coveragePct: pyPct } },
          { label: "executor-node 全量（`npm test -- --coverage`）", code: nodeCode, signal: nodeSignal, summary: { coveragePct: nodePct } },
        ],
      },
      null,
      2,
    ),
  });
  push("反例④：step.code≠0（测量本身失败）⇒ exit 1 且点名「pct 不可信」", () => {
    const repo = makeFixtureRepo(twoEnds({ nodeCode: 1 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["测量本身失败", "pct 不可信", "executor-node"], withinMs: 20000, label: "测量失败",
      });
    } finally { repo.cleanup(); }
  });
  push("正例②：两端（python+node）各一档且均 ≥ floor ⇒ exit 0 且打印「比较 2 端」", () => {
    const repo = makeFixtureRepo(twoEnds());
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0, contains: ["比较 2 端"], withinMs: 20000, label: "两端达标",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑤：缺 node 数据（只有 python 步）⇒ exit 1 且点名 executor-node + 教 `npm run coverage:node`", () => {
    const repo = makeFixtureRepo({
      [BASELINE_REL]: JSON.stringify({ ends: { "executor-node": { floor: 88.88 } } }),
      [HEALTH_REL]: JSON.stringify({ steps: [{ label: "executor-python 全量（`python3 -m pytest`）", code: 0, signal: null, summary: { coveragePct: 87.45 } }] }),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["executor-node", "拿不到覆盖率数据", "coverage:node"], withinMs: 20000, label: "缺 node 数据",
      });
    } finally { repo.cleanup(); }
  });
  // R140 新增六条（数据新鲜度）：① 过期 ⇒ 红且**不判**覆盖率高低；② generatedAt 缺失 ⇒ 红；
  // ③ generatedAt 不可解析 ⇒ 红；④ 新鲜 ⇒ 绿（证明不会天天误红）；⑤ 未声明 maxAgeDays 的端 + 极旧数据 ⇒
  // 绿（兼容 R137/R138 口径）；⑥ maxAgeDays 非正整数 ⇒ 结构红（声明了却判不了，比没声明更坏）。
  /** 相对今天的 `YYYY-MM-DD`（按 UTC 日差算，不经 DST ⇒ 结果稳定，与时区无关）。 */
  const shiftDays = (offset) => {
    const d = new Date(parseDateOnly(todayDateOnly()) + offset * 86_400_000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const oneEnd = ({ floor = 87.45, pct = 87.45, generatedAt, maxAgeDays } = {}) => {
    const end = { floor };
    if (maxAgeDays !== undefined) end.maxAgeDays = maxAgeDays;
    const health = {
      steps: [
        { label: "executor-python 全量（`python3 -m pytest`）", code: 0, signal: null, summary: { coveragePct: pct } },
      ],
    };
    if (generatedAt !== undefined) health.generatedAt = generatedAt;
    return {
      [BASELINE_REL]: JSON.stringify({ ends: { "executor-python": end } }, null, 2),
      [HEALTH_REL]: JSON.stringify(health, null, 2),
    };
  };
  push("反例⑥：数据过期（30 天 > 上限 14）⇒ exit 1 且点名「过期」，**不判覆盖率高低**", () => {
    // pct 故意低于 floor：若判据顺序错了，会多报一条「低于基线」；这里用 absent 反证顺序。
    const repo = makeFixtureRepo(oneEnd({ floor: 87.95, pct: 87.45, generatedAt: shiftDays(-30), maxAgeDays: 14 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["已过期 30 天", "上限 14 天", "不判覆盖率高低", "health:snapshot"],
        absent: ["低于基线", "可上调基线"],
        withinMs: 20000,
        label: "数据过期",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑦：`generatedAt` 缺失 ⇒ exit 1 且点名「无法判断新鲜度」", () => {
    const repo = makeFixtureRepo(oneEnd({ maxAgeDays: 14 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["无法判断新鲜度", "没有生成时间"], withinMs: 20000, label: "generatedAt 缺失",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑧：`generatedAt` 不可解析 ⇒ exit 1 且点名「无法判断新鲜度」", () => {
    const repo = makeFixtureRepo(oneEnd({ generatedAt: "上周三", maxAgeDays: 14 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["无法判断新鲜度", "不可解析"], withinMs: 20000, label: "generatedAt 不可解析",
      });
    } finally { repo.cleanup(); }
  });
  push("正例③：数据新鲜（1 天 ≤ 上限 14）⇒ exit 0 且真的判了新鲜度", () => {
    const repo = makeFixtureRepo(oneEnd({ generatedAt: shiftDays(-1), maxAgeDays: 14 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0, contains: ["新鲜度：判 1 端"], absent: ["过期", "无法判断新鲜度"], withinMs: 20000, label: "新鲜",
      });
    } finally { repo.cleanup(); }
  });
  push("正例④（兼容）：未声明 maxAgeDays 的端 + 400 天前的数据 ⇒ exit 0（不因新鲜度红）", () => {
    const repo = makeFixtureRepo(oneEnd({ generatedAt: shiftDays(-400) }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0, contains: ["未声明 maxAgeDays 1 端"], absent: ["过期", "无法判断新鲜度"], withinMs: 20000, label: "未声明不红",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑨：`maxAgeDays` 不是正整数（字符串 \"14\"）⇒ exit 1 结构红", () => {
    const repo = makeFixtureRepo(oneEnd({ generatedAt: shiftDays(-1), maxAgeDays: "14" }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["maxAgeDays", "正整数"], withinMs: 20000, label: "maxAgeDays 非法",
      });
    } finally { repo.cleanup(); }
  });
  // ── R142 新增（admin-api 第三端 + **双 step 陷阱**）────────────────────────
  // 夹具刻意复刻 `docs/health-baseline.json` 的真实形态：**两条**含 "admin-api" 的 step ——
  //   ①「admin-api 全量（默认环境，`npm test -- --maxWorkers=2`）」（默认环境那步，棘轮要比的就是它）
  //   ②「admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态）」（另一套环境变量下的另一次测量）
  // 两条的 pct **故意不同**（default 低于 floor、selftest 高于 floor）⇒ 若实现取错步，结论就会翻转，
  // 断言因此「有本事失败」。
  const adminApiTree = ({
    floor = 88.0,
    defaultPct = 88.0,
    selftestPct = 99.5,
    defaultCode = 0,
    dropDefaultPct = false,
    dropSelftestStep = false,
  } = {}) => {
    const steps = [];
    if (!dropSelftestStep) {
      steps.push({
        label: "admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态）",
        code: 0,
        signal: null,
        summary: { coveragePct: selftestPct },
      });
    }
    const defaultStep = {
      label: "admin-api 全量（默认环境，`npm test -- --maxWorkers=2`）",
      code: defaultCode,
      signal: null,
      summary: {},
    };
    if (!dropDefaultPct) defaultStep.summary.coveragePct = defaultPct;
    steps.push(defaultStep);
    return {
      [BASELINE_REL]: JSON.stringify({ ends: { "admin-api": { floor } } }, null, 2),
      [HEALTH_REL]: JSON.stringify({ generatedAt: "2026-11-07", steps }, null, 2),
    };
  };
  push("正例⑤（R142）：双 step 场景下**必须选默认环境那步** ⇒ 按默认环境的 pct 判，不被 SELFTEST 那步带偏", () => {
    // floor 88.0；默认环境 pct = 88.0（恰好达标 ⇒ 不提示任何高低）；SELFTEST 那步 pct = 99.5。
    // 若实现取错步（SELFTEST），它 99.5 > 88 ⇒ 会打出「可上调基线」⇒ 本例用 absent 断言把它钉死。
    const repo = makeFixtureRepo(adminApiTree({ floor: 88.0, defaultPct: 88.0, selftestPct: 99.5 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0, contains: ["比较 1 端"], absent: ["可上调基线", "低于基线", "拿不到覆盖率数据"], withinMs: 20000, label: "双 step 取默认环境",
      });
    } finally { repo.cleanup(); }
  });
  push("正例⑥（R142）：双 step 场景下默认环境那步达标 ⇒ exit 0（再次钉住「取默认环境、不取 SELFTEST」）", () => {
    const repo = makeFixtureRepo(adminApiTree({ floor: 88.0, defaultPct: 90.0, selftestPct: 70.0 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0, contains: ["比较 1 端"], absent: ["低于基线", "拿不到覆盖率数据"], withinMs: 20000, label: "双 step 取默认环境②",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑩（R142）：admin-api **默认环境**那步低于 floor ⇒ exit 1 且点名差值（不是拿 SELFTEST 那步的数字来比）", () => {
    // 默认环境 86.5 < floor 88.0（差 1.50pt）；SELFTEST 那步 99.5 ⇒ 若实现取错步就会判绿。
    const repo = makeFixtureRepo(adminApiTree({ floor: 88.0, defaultPct: 86.5, selftestPct: 99.5 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["admin-api 覆盖率**低于基线**", "实测 86.5% < 基线 88%", "差 1.50pt"], withinMs: 20000, label: "admin-api 低于 floor",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑪（R142）：默认环境步**没有 coveragePct**、只有 SELFTEST 那步有 ⇒ 必须判「拿不到覆盖率数据」（不许拿错步的数字顶替）", () => {
    const repo = makeFixtureRepo(adminApiTree({ floor: 88.0, dropDefaultPct: true, selftestPct: 99.5 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["admin-api", "拿不到覆盖率数据", "coverage:api"], absent: ["可上调基线"], withinMs: 20000, label: "默认环境步无 pct",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑫（R142）：默认环境步 code≠0（测量本身失败）⇒ exit 1 且点名「pct 不可信」", () => {
    const repo = makeFixtureRepo(adminApiTree({ floor: 88.0, defaultPct: 99.9, defaultCode: 1 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["admin-api", "测量本身失败", "pct 不可信"], withinMs: 20000, label: "admin-api 测量失败",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑬（R142）：只有 SELFTEST 那步、完全没有默认环境步 ⇒ 判「拿不到覆盖率数据」（不许回退去取 SELFTEST）", () => {
    // 只有 SELFTEST 步（pct 99.5）⇒ 若实现「找不到默认环境步就随便挑一条」就会拿 99.5 判绿。
    const fixture = {
      [BASELINE_REL]: JSON.stringify({ ends: { "admin-api": { floor: 88.0 } } }, null, 2),
      [HEALTH_REL]: JSON.stringify({
        generatedAt: "2026-11-07",
        steps: [{ label: "admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态）", code: 0, signal: null, summary: { coveragePct: 99.5 } }],
      }, null, 2),
    };
    const repo = makeFixtureRepo(fixture);
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["admin-api", "拿不到覆盖率数据"], absent: ["可上调基线"], withinMs: 20000, label: "只有 SELFTEST 步",
      });
    } finally { repo.cleanup(); }
  });
  const failed = reportCases(cases, { title: "check-coverage-floor selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const errors = check(eq ? resolve(eq.slice("--root=".length)) : REPO_ROOT);
  if (errors.length === 0) {
    console.log(
      `✔ 覆盖率下限通过（${errors.meta?.ends ?? 0} 端；新鲜度判 ${errors.meta?.freshJudged ?? 0} 端 / ` +
        `未声明 ${errors.meta?.freshUndeclared ?? 0} 端；可上调 ${errors.meta?.hints ?? 0} 处）。`,
    );
    return 0;
  }
  console.error(`✘ 覆盖率下限：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
