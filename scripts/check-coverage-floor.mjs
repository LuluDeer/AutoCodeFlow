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
 * · **声明了** ⇒ 先判新鲜度，再判覆盖率：
 *   - 时间戳缺失 / 不可解析 ⇒ **红**：「基线没有生成时间，无法判断新鲜度」（不静默绿）；
 *   - 年龄 > 上限 ⇒ **红**：「实测数据已过期 N ⇒ 数字不可信」，并按端教刷新命令；
 *     此时**不判覆盖率高低**（过期数据的高/低都无意义），过期这一条仍作为 error 列出；
 *   - 没超期 ⇒ 走 R137/R138 那套（测量是否成立 → 与 floor 比）。
 * · **未声明** ⇒ 保持 R137/R138 现状：**不因新鲜度红**。这正是本判据的**盲区**：
 *   不声明的端，数据放多久都只按数字判 —— 逐端声明是唯一解法，新增端时要一并声明。
 *
 * ## R144（2026-11-07）：新鲜度改为**优先读 per-step `measuredAt`**（小时级）+ 保留 `generatedAt` 回落
 *
 * R140 的两个方向性缺陷（`--skip-heavy` 能消红、单端真刷不能解红）根子都在「**只有一个文件级日期**」：
 * ① `npm run health:snapshot -- --skip-heavy` 前移 `generatedAt` 却**一步全量都不跑** ⇒ 文件看着新鲜，
 *   step 的数字还是上次的 ⇒ 棘轮拿「上次的覆盖率 + 今天的日子」判绿（假绿）；
 * ② 反过来 `npm run coverage:node` **真跑了**测试并写回 `coveragePct`，却**不动** `generatedAt` ⇒ 真刷了数据
 *   反而**解不了红**（假红）。
 *
 * 修法（**新增字段，不改 `generatedAt` 的既有语义** —— 它是「文件生成日期」，多处引用，改语义会让
 * 历史基线一夜失效）：
 * · `docs/health-baseline.json` 的每个 step 新增 `measuredAt`（ISO 8601 **带时刻**，如 `2026-11-06T21:55:28Z`）
 *   = **这一步的测量实际发生的时间**。写点只有两个，且都是「真跑完」的那一刻：
 *   `scripts/health-snapshot.mjs`（跑完该 step）与 `scripts/coverage-snapshot.mjs`（单端快照真跑完）。
 *   **沿用**的 step 原样带着旧 `measuredAt`（沿用不是重测）；`--skip-heavy` **不写**任何 step 的 `measuredAt`。
 * · 本守卫的判据顺序：**有 `measuredAt` ⇒ 用它**（小时级年龄）；**没有** ⇒ 回落到文件级 `generatedAt`
 *   （天级，向后兼容：历史基线与手写 step 不会一夜全红）；**两者都没有** ⇒ 红「无法判断新鲜度」。
 *   报文**必须点名来源**（per-step / 回落文件级）与具体数字，否则「这个绿是怎么来的」不可审计。
 *
 * ### `maxAgeHours` vs `maxAgeDays`：**两个都保留，取更严者**（本轮的选择 + 理由）
 * · `maxAgeDays`（**天**）继续作为**对外口径**：它是 R140 起对外承诺的窗口（14 天 = 两周体检节奏），
 *   历史基线、`why` 文本、评审记录都按天说话；突然把它换成小时会让「14 天」这个数字在历史上不可比。
 * · `maxAgeHours`（**小时**，可选）是**更细的同一件事**：per-step 时间戳带了时刻，才**第一次**有能力
 *   做小时级判断；没有这个字段，小时级能力就只能停在「实现里能做、契约里没有」。
 * · **两者都声明时取更严者**（`min(maxAgeDays×24, maxAgeHours)`）：两个都写着却只认一个，等于让另一个
 *   变成没有判据面的装饰 —— 「取更严」把歧义压到零，也保证「收紧」永远是**单向**的（对棘轮友好）。
 * · 粒度**跟着来源走**：per-step 路径按**小时**判并按小时报；回落路径（只有日期）按**自然日**判并按天报
 *   —— 拿一个 `YYYY-MM-DD` 去做小时判断等于凭空造一个不存在的时刻（R140 已论证过）。
 *
 * 其它口径（都不许静默）：
 * · `maxAgeDays` / `maxAgeHours` 写成非正整数（含字符串 `"14"`）⇒ **结构红**（声明了就必须真能判）；
 * · `measuredAt` 写错形状（没有时区 / 不是 `YYYY-MM-DDTHH:MM[:SS]±HH:MM|Z` / 日期不存在）⇒ **红**
 *   「无法判断新鲜度」——**不**回落到 `generatedAt`：一个写坏的时间戳是「有人手改过」的信号，
 *   此时拿文件级日期顶上正好把它掩盖掉；
 * · 时间戳晚于当前时刻（跨时区 / 时钟回拨 / 手写未来）⇒ 按 **0** 算且**不**判红（否则 UTC 机器跑会
 *   天天误红），但输出里点名这一事实（不静默）；
 * · 过期 / 无时间戳的端，连「测量失败 / 拿不到数据」也不再重复报 —— 当前动作只有一个：**刷新数据**。
 *
 * 已知盲区（R144 之后仍存在，**如实登记**）：
 * · 有人**手改** `docs/health-baseline.json` 的 `measuredAt`（把手写时刻改成刚发生）⇒ 本守卫只能读字段，
 *   证明不了那一步真跑过 —— 与手改 `coveragePct` 同级，靠评审看「时间戳跳动却没有对应跑测记录」。
 * · 回落路径的天粒度意味着「今天早些时候测的」与「昨天很晚测的」在 14 天窗口边缘可能差一天（可接受：
 *   窗口是 14 天，边缘误差 1 天不影响结论；per-step 路径没有这个问题）。
 * · **没有 `measuredAt` 的旧 step** 会被 `--skip-heavy` 的「前移日期」骗过（回落路径只能看日期）。
 *   R152 已把这条从「全端盲区」收窄到**只对未声明 `maxAgeHours` 的端成立**（见下一节）：声明了
 *   小时级的端缺时间戳**直接红** —— 不再是盲区。
 *
 * ## R152（2026-11-07）：**两条口径的分界** —— 声明 `maxAgeHours` ⇒ 必须有 per-step 时间戳
 *
 * R144 留下的缺口（本轮修的）：回落口径**可被 `--skip-heavy` 骗过**。R144 落地时实测只有
 * executor-node 带 `measuredAt`，executor-python / admin-api 都缺 ⇒ 两端走文件级回落 ⇒
 * `npm run health:snapshot -- --skip-heavy`（前移 `generatedAt`、**一步全量都不跑**）就能让
 * 「几周没真测过」的端看起来「刚测过」。**回落口径就是那个洞**。
 *
 * 分界（**判据本体，两句话**）：
 * · **声明了 `maxAgeHours` = 承诺小时级新鲜度 ⇒ 该端 step 必须有 `measuredAt`**；缺失 ⇒ **红**，
 *   报文点名「该端没有 per-step 时间戳 ⇒ 新鲜度不可信（文件级 `generatedAt` 会被 `--skip-heavy` 前移）」
 *   并给出该端的刷新命令（`node scripts/health-snapshot.mjs --only="<step 关键字>"` / 单端快照脚本）。
 *   **不**回落到 `generatedAt`：回落正是要堵的那个口子；声明了小时级却靠天级日期判绿 =
 *   「契约里写着 A、实现里做 B」（R152 之前三端就是这个矛盾状态）。这与 R144 已有的
 *   「`measuredAt` 写坏 ⇒ 红且不回落」是同一条理由的**两个形态**：字段该在而缺失，不许用日期顶替。
 * · **未声明 `maxAgeHours`** ⇒ 保持 R144 的回落口径（`generatedAt`，天级）**并如实登记这是已知盲区**：
 *   `--skip-heavy` 前移日期即可让旧数据看着新鲜。要消盲区只有一条路 —— 给该端声明 `maxAgeHours`
 *   （声明它等于承诺必须有 per-step 时间戳）。**不要**留下「声明了小时级却走回落」的矛盾状态。
 *
 * 回填（**真跑，不许手写**）：三端各跑一次 `node scripts/health-snapshot.mjs --only="<step 关键字>"`
 * （真跑测试、写回 `coveragePct` + `measuredAt`；逐端耗时见
 * `artifacts/autonomy/R152/impl-freshness-tighten.md`）。回填后三端都在 per-step 口径上 ⇒
 * 报文里「回落文件级 `generatedAt` M 端」应为 **0**。
 *
 * 用法：node scripts/check-coverage-floor.mjs [--root=<dir>] [--selftest]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
export const BASELINE_REL = "scripts/coverage-floor-baseline.json";
export const HEALTH_REL = "docs/health-baseline.json";
/** 基线端名 → `docs/health-baseline.json` 里的 step label 关键词。 */
export const END_LABEL_HINTS = {
  "executor-python": "executor-python",
  // R138：executor-node 是第二条接进棘轮的端（此前只有 python 一端有 floor ⇒ 棘轮半只眼）
  "executor-node": "executor-node",
  // R158：admin-web 是第四条。
  //
  // admin-web 在 `docs/health-baseline.json` 里**只有一个**含 "admin-web" 的 step
  // ⇒ hint 不用特异（与 admin-api 的「双 step」不同），也不需要 excludes。
  "admin-web": "admin-web",
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
 *
 * R152 修的是**另一半**：药方必须能**解红** —— 即「跑完会把该 step 的 `coveragePct` + `measuredAt`
 * 写回基线」。python 端没有 `coverage-snapshot.mjs` 的 ENDS 条目（那个脚本只认 jest 的
 * json-summary 落点），故它的真跑入口就是 `health-snapshot.mjs --only=executor-python`；
 * 单跑 `python3 -m pytest --cov` **只打印覆盖率、不写基线** ⇒ 看着「刷过了」却解不了红。
 */
export const END_RUN_HINTS = {
  "executor-python":
    "`node scripts/health-snapshot.mjs --only=\"executor-python\"`（= 真跑 `python3 -m pytest`，并把该步的 `coveragePct` / `measuredAt` 写回 `docs/health-baseline.json`；**单跑** `cd apps/executor-python && python3 -m pytest --cov` 只打印数字、**不写基线**，解不了红）",
  "executor-node": "`npm run coverage:node`（真跑 `npx jest --coverage --coverageReporters=json-summary` 并回写 `coveragePct`）",
  "admin-api": "`npm run coverage:api`（真跑 `npx jest --coverage --coverageReporters=json-summary --maxWorkers=2` 并回写 `coveragePct`）",
  // R158：admin-web（vitest v8 插桩，全量 + coverage 约 250s —— 比前三端都贵，
  // 但它**确实能跑通**：R157 修掉两处真失败后实测 exit 0、lines 86.30%）。
  "admin-web": "`npm run coverage:web`（真跑 `npx vitest run --coverage --coverage.reporter=json-summary` 并回写 `coveragePct`）",
};

const runHint = (end) => END_RUN_HINTS[end] ?? "该端尚无单端快照脚本（见 `scripts/health-snapshot.mjs` 对应步）";

/**
 * R152：**刷新命令**的统一文案 —— 「单端快照脚本」与 `--only="<关键字>"` 是**同一条**时只报一次。
 *
 * python 端正是这种情形（它没有 jest 的 json-summary 落点，`scripts/coverage-snapshot.mjs` 的 `ENDS`
 * 里只有 node / admin-api），若把两处命令都印出来，读者会以为有两条不同的路可走 —— 实际只有一条。
 * 所以这里**先去重**：同一句话印两遍不是「更稳妥」，是让报文自相矛盾。
 */
export function refreshHint(end, onlyHint) {
  const onlyCmd = `node scripts/health-snapshot.mjs --only="${onlyHint}"`;
  const alt = runHint(end);
  return alt.includes(onlyCmd) ? alt : `① \`${onlyCmd}\` 或 ② ${alt}`;
}

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
 * 两侧都锚到 UTC 00:00 再相减 ⇒ 只差整数天，不受 DST / 时区偏移影响（**回落路径**专用：文件级
 * `generatedAt` 只有日期，做不了小时级判断；小时级走 per-step `measuredAt`，见 `ageInHours`）。
 */
export function ageInDays(generatedAt, today = todayDateOnly()) {
  const g = parseDateOnly(generatedAt);
  const t = parseDateOnly(today);
  if (g === null || t === null || !Number.isFinite(g) || !Number.isFinite(t)) return null;
  return Math.round((t - g) / 86_400_000);
}

/**
 * R144：per-step 时间戳的**严格**形状 —— `YYYY-MM-DDTHH:MM[:SS[.sss]]` + **必须带时区**（`Z` 或 `±HH:MM`）。
 *
 * 为什么强制时区：无时区的裸时刻会被 `Date.parse` 按**本机时区**解释 ⇒ 同一个字段在不同机器上算出不同年龄
 * （CI 是 UTC、开发机是 UTC+8 ⇒ 8 小时的分歧）。那是最隐蔽的一种误判：字段看着有，判据却随机器漂。
 * 为什么可选秒 / 毫秒：本仓两个写点都写秒精度，但手写/外部工具带毫秒也不该判红（能解析就够了）。
 */
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * R144：严格解析 ISO 8601 **带时刻**的时间戳 ⇒ UTC 毫秒；不可解析 ⇒ `null`（调用方据此判红，不猜）。
 *
 * 三道关：① 形状（正则，含时区）；② 日期的日历合法性（复用 `parseDateOnly` 的回环校验 ——
 * `2026-02-31T00:00:00Z` 会被 `Date.parse` 静默归一化成 3-03）；③ 时分秒范围 + `Date.parse` 可解析。
 * 空串 / `null` / 非字符串 ⇒ `null`（「没有字段」与「字段写坏了」由调用方区分）。
 */
export function parseInstant(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const m = INSTANT_RE.exec(text);
  if (!m) return null;
  if (parseDateOnly(`${m[1]}-${m[2]}-${m[3]}`) === null) return null;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** R144：`measuredAt`（UTC 毫秒）距今**小时数**（未来 ⇒ 负数）。判据只用差值，不做时区换算。 */
export function ageInHours(instantMs, nowMs = Date.now()) {
  return (nowMs - instantMs) / 3_600_000;
}

/**
 * R144：把两个「上限」压成**一个**小时上限 —— **取更严者**（`min(maxAgeDays×24, maxAgeHours)`）。
 *
 * 为什么不是「hours 优先 / days 优先」：两个都写着却只认一个，另一个就成了没有判据面的装饰，
 * 而「谁优先」这条暗规则正是本仓反复消灭的东西。取更严也顺带保证「收紧」永远是单向的。
 * 都没声明 ⇒ `null`（不判新鲜度，R137/R138 口径）。
 */
export function freshnessHoursLimit(maxAgeDays, maxAgeHours) {
  const candidates = [];
  if (typeof maxAgeDays === "number" && Number.isFinite(maxAgeDays)) candidates.push(maxAgeDays * 24);
  if (typeof maxAgeHours === "number" && Number.isFinite(maxAgeHours)) candidates.push(maxAgeHours);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** R144：报文案里那截「上限怎么来的」（把 maxAgeDays / maxAgeHours 两个来源都摊开，便于审计）。 */
export function describeLimits(maxAgeDays, maxAgeHours) {
  const parts = [];
  if (typeof maxAgeHours === "number") parts.push(`maxAgeHours=${maxAgeHours} 小时`);
  if (typeof maxAgeDays === "number") parts.push(`maxAgeDays=${maxAgeDays} 天（=${maxAgeDays * 24} 小时）`);
  return parts.length === 0 ? "未声明上限" : `${parts.join(" / ")} ⇒ 取更严者`;
}

/**
 * R144/R152：判**一端**的新鲜度（只在该端声明了 `maxAgeDays` / `maxAgeHours` 时调用）。
 *
 * 来源优先级（这就是判据本体）：
 * 0. **R152**：该端声明了 `maxAgeHours`（= 承诺小时级新鲜度）而 `measuredAt` 缺失 ⇒ **红**，
 *    **不回落到** `generatedAt`。理由：回落口径可被 `--skip-heavy`（前移日期、不重跑）骗过，
 *    声明了小时级就得有 per-step 时刻来**兑现**这个声明。
 * 1. **有** `measuredAt` ⇒ 按**小时**判（per-step，这一步的测量实际发生的时间）；
 * 2. **没有**（且未声明 `maxAgeHours`）⇒ 回落文件级 `generatedAt`，按**自然日**判
 *    （向后兼容：未声明小时级的端/历史基线不会一夜全红；这条口径是**已知盲区**，见下）；
 * 3. **两者都没有 / 都不可解析** ⇒ `expired: true` + 报错（不静默绿）。
 *
 * 返回 `{ expired, source, error?, hint? }`：
 * · `source`：`"per-step"` / `"file"` / `"none"` —— **报文必须说清用的是哪个**，否则「这个绿怎么来的」不可审计；
 *   `"none"` = 没有任何可信时刻（含 R152 的「该有却缺」）；
 * · `missingPerStep: true` ⇒ 调用方单列一条计数（「缺 per-step 时间戳 N 端」），让汇总行看得见这个失败面；
 * · `expired: true` 时调用方**不再比 floor**（过期数据的高/低都没意义）；
 * · `hint` 是「时间戳晚于现在」时的可见提示（不红，只点名）。
 */
export function judgeFreshness(
  end,
  {
    maxAgeDays = null,
    maxAgeHours = null,
    measuredAt,
    generatedAt,
    now = new Date(),
    // R152：声明了 `maxAgeHours` 的端 ⇒ per-step 时间戳是**硬要求**（缺失即红，不许回落）。
    requirePerStep = false,
    // R152：报文里教人刷新的关键字（`--only="<它>"`）与该 step 的 label（只用于点名，不参与判断）。
    onlyHint = null,
    stepLabel = null,
  } = {},
) {
  const limitHours = freshnessHoursLimit(maxAgeDays, maxAgeHours);
  if (limitHours === null) {
    // 调用方只在声明了上限时才进来；到不了这里，但别让 `null` 被当成「永不超期」静默掉。
    return { expired: true, source: "none", error: `${end}：新鲜度上限未声明 ⇒ 本函数不该被调用（拒绝猜）` };
  }
  const limits = describeLimits(maxAgeDays, maxAgeHours);
  const nowIso = (() => {
    try {
      return `${now.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
    } catch {
      return String(now);
    }
  })();
  const absent =
    measuredAt === undefined || measuredAt === null || (typeof measuredAt === "string" && measuredAt.trim() === "");

  // ── 来源⓪（R152）：声明了小时级新鲜度，却**没有** per-step 时间戳 ⇒ 红，**不**回落 ─────────
  //
  // 这是本轮收紧的那一条。为什么不能像 R144 那样「缺失就回落到 generatedAt」：
  // ① `--skip-heavy` 会前移 `generatedAt` 而**一步都不重跑** ⇒ 回落口径下「没测过」的端看起来「刚测过」；
  // ② 声明 `maxAgeHours` 的语义就是「本端的数字带得出 per-step 时刻」，缺失 = 承诺没兑现，
  //    此时判绿等于让契约与实现各说各话（R152 之前三端正是这个矛盾状态）。
  // 与 R144「`measuredAt` 写坏 ⇒ 红且不回落」同一条理由的另一个形态：**该在而缺失，不许拿日期顶替**。
  if (absent && requirePerStep) {
    const declText =
      typeof maxAgeHours === "number" ? `\`maxAgeHours=${maxAgeHours}\`` : `\`maxAgeDays=${maxAgeDays}\``;
    const where = stepLabel
      ? `该 step「${stepLabel}」`
      : `该端在 \`${HEALTH_REL}\` 里**根本没有**对应的 step（连 \`coveragePct\` 也无从谈起）`;
    return {
      expired: true,
      source: "none",
      missingPerStep: true,
      error:
        `${end}：**该端没有 per-step 时间戳 ⇒ 新鲜度不可信**（${where} 没有 \`measuredAt\`；而 ` +
        `\`${BASELINE_REL}\` 的 \`ends.${end}\` 声明了 ${declText} —— **声明小时级 = 承诺这个数字带得出 per-step 时刻**，` +
        `缺字段就是承诺没兑现）⇒ 不许判绿，**也**不许拿文件级 \`generatedAt\`（=${String(generatedAt)}）顶上：` +
        `文件级日期会被 \`npm run health:snapshot -- --skip-heavy\` **前移**，而它**一步都不重跑** ⇒ ` +
        `回落口径下「没测过」的端会看起来「刚测过」（这正是 R152 要堵的假绿）。` +
        `刷新（**会**写该 step 的 \`measuredAt\`，否则这条红解不掉）：${refreshHint(end, onlyHint ?? end)}`,
    };
  }

  // ── 来源①：per-step `measuredAt`（小时级）─────────────────────────────────
  if (!absent) {
    const instant = parseInstant(measuredAt);
    if (instant === null) {
      return {
        expired: true,
        source: "per-step",
        error:
          `${end}：**基线没有可解析的测量时刻，无法判断新鲜度**（该 step 的 \`measuredAt\` = ` +
          `${JSON.stringify(measuredAt)}，不是带时区的 ISO 8601 时刻）⇒ 不许在「不知道这一步多旧」的情况下判绿。` +
          `（**不**回落到文件级 \`generatedAt\`：字段在却写坏了 = 有人手改过，拿日期顶上正好把它掩盖掉）` +
          `刷新：按端重测 ${runHint(end)}（会重写该 step 的 \`measuredAt\`），或 \`npm run health:snapshot -- --only=<step 关键字>\``,
      };
    }
    const ageH = ageInHours(instant, now.getTime());
    if (ageH < 0) {
      return {
        expired: false,
        source: "per-step",
        hint:
          `${end}：该 step 的 \`measuredAt\`（${measuredAt}）**晚于**现在（${nowIso}）⇒ 按 0 小时算、不判红` +
          `（跨时区 / 时钟回拨会这样；若确认是手写未来时刻，请当成「没有可信时间戳」处理）`,
      };
    }
    if (ageH > limitHours) {
      return {
        expired: true,
        source: "per-step",
        error:
          `${end}：**实测数据已过期 ${Math.floor(ageH)} 小时（≈${(ageH / 24).toFixed(1)} 天；上限 ${limitHours} 小时 —— ${limits}）` +
          `⇒ 数字不可信**（**来源=该 step 的 per-step \`measuredAt\`**=${measuredAt}；现在 ${nowIso}；粒度=小时）⇒ ` +
          `本次**不判覆盖率高低**（过期数据的高/低都没意义）。刷新：①按端重测 ${runHint(end)}；` +
          `②或 \`npm run health:snapshot -- --only=<step 关键字>\`（两者都会写该 step 的 \`measuredAt\`；` +
          `**不要**用 \`--skip-heavy\`：它只前移文件级日期、不重测任何 step）`,
      };
    }
    return { expired: false, source: "per-step" };
  }

  // ── 来源②：回落文件级 `generatedAt`（天级；只有日期，不造时刻）─────────────
  // **R152：只有「未声明 maxAgeHours」的端能走到这里**（声明了的在来源⓪ 就红了）——
  // 故本段是**兼容面**，也是**已知盲区**（`--skip-heavy` 前移日期即可让旧数据看着新鲜）。
  const today = todayDateOnly(now);
  const parsed = parseDateOnly(generatedAt);
  if (parsed === null) {
    return {
      expired: true,
      source: "none",
      error:
        `${end}：**基线没有生成时间，无法判断新鲜度**（该 step **既没有** per-step \`measuredAt\`，` +
        `文件级 \`generatedAt\` = ${JSON.stringify(generatedAt)} 也不可解析为 \`YYYY-MM-DD\`）⇒ 声明了新鲜度上限的端` +
        `**不许在「不知道数据多旧」的情况下判绿**。刷新：按端重测 ${runHint(end)}（会写该 step 的 \`measuredAt\`），` +
        `或 \`npm run health:snapshot\`（全量体检，会重写 \`generatedAt\`）`,
    };
  }
  const age = ageInDays(generatedAt, today);
  if (age === null) {
    // 到不了这里（两侧已校验过）；留着是为了错误不被 `null > n` 静默吃掉。
    return {
      expired: true,
      source: "file",
      error: `${end}：无法计算新鲜度（generatedAt=${JSON.stringify(generatedAt)}，今天=${today}）⇒ 不许静默绿`,
    };
  }
  if (age < 0) {
    return {
      expired: false,
      source: "file",
      hint:
        `${end}：\`generatedAt\`（${generatedAt}）**晚于**今天（${today}）⇒ 按 0 天算、不判红` +
        `（跨时区 / 时钟回拨会这样；若确认是手写未来日期，请当成「没有可信时间戳」处理）`,
    };
  }
  // 天级来源与小时上限比较：`age×24 > limitHours`。对 maxAgeDays 而言与 R140 的 `age > maxAgeDays`
  // **完全等价**（两边同乘 24），所以既有语义一位没变；对「只声明 maxAgeHours」的端则是最保守的换算
  // （只有日期时，任何跨越自然日的旧数据都当作可能已超小时上限 —— 宁可红，不给假绿）。
  if (age * 24 > limitHours) {
    const limitText = typeof maxAgeDays === "number" ? `上限 ${maxAgeDays} 天` : `上限 ${limitHours} 小时`;
    return {
      expired: true,
      source: "file",
      error:
        `${end}：**实测数据已过期 ${age} 天（${limitText} —— ${limits}）⇒ 数字不可信**` +
        `（**来源=文件级 \`generatedAt\` 的回落**=${generatedAt}，今天 ${today}；该 step **没有** per-step \`measuredAt\`，` +
        `故只能按自然日比 —— 日期没有时刻，做小时判断等于凭空造一个时间点；本端**未**声明 \`maxAgeHours\` ⇒ 本段是**兼容面**）⇒ ` +
        `⚠ 这条口径是**已知盲区**：\`npm run health:snapshot -- --skip-heavy\` 会前移这段日期` +
        `（要消盲区就给本端声明 \`maxAgeHours\` = 承诺必须有 per-step 时刻）。` +
        `本次**不判覆盖率高低**（过期数据的高/低都没意义）。刷新：①按端重测 ${runHint(end)}` +
        `（真跑，并写该 step 的 \`measuredAt\`）；②或 \`npm run health:snapshot\`（全量体检 30–40 分钟，重写 \`generatedAt\`）`,
    };
  }
  return { expired: false, source: "file" };
}

/**
 * 过期时只提示一次的「洗白路径」警告。
 *
 * R152 更新：`--skip-heavy` 现在**洗不白任何**声明了 `maxAgeHours` 的端（那些端必须有 per-step
 * `measuredAt`，缺了直接红 —— 见 `judgeFreshness` 的来源⓪）。它只剩一点效力：**未声明** `maxAgeHours`
 * 的端走天级回落，前移日期仍能让旧数据看着新鲜。这就是本判据剩下的**已知盲区**，如实登记。
 */
const SKIP_HEAVY_WARNING =
  "⚠ `npm run health:snapshot -- --skip-heavy` 只前移**文件级** `generatedAt`、**不重跑**任何 step ⇒ " +
  "它**洗不白**任何声明了 `maxAgeHours` 的端（那些端必须有 per-step `measuredAt`，缺了直接红，R152）；" +
  "它只剩对**未声明** `maxAgeHours` 的端的「日期前移看着新鲜」那点效力 —— 这正是本判据的**已知盲区**。" +
  "彻底消红要真重跑：`node scripts/health-snapshot.mjs --only=\"<step 关键字>\"` 或该端单端快照脚本";

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
  // R140 计数：判了新鲜度的端 / 过期的端 / 没声明 maxAgeDays 的端（后者必须可见 —— 那是盲区，不许静默）。
  // R144 再加两个来源计数：**per-step `measuredAt`** 与**回落文件级 `generatedAt`** ——
  // 报文要能回答「这个绿的数字是哪一份数据、什么时候测的」，否则「来源」只是个形容词。
  // R152 再加一个失败面计数 `freshMissingStamp`：声明了 `maxAgeHours` 却**没有** per-step 时间戳的端
  // （那是本轮要堵的口子，必须能在汇总行一眼看到，不能只藏在 errors 里）。
  let freshJudged = 0;
  let freshExpired = 0;
  let freshUndeclared = 0;
  let freshPerStep = 0;
  let freshFallback = 0;
  let freshMissingStamp = 0;
  let freshHoursOnly = 0;
  let skipHeavyWarned = false;

  for (const [end, cfg] of Object.entries(ends)) {
    const floor = Number(cfg.floor);
    if (!Number.isFinite(floor)) {
      errors.push(`${BASELINE_REL} 的 \`ends.${end}.floor\` 不是数字：${cfg.floor}`);
      continue;
    }
    // R140/R144 结构判据：`maxAgeDays`（天）/ `maxAgeHours`（小时）若声明，必须是**正整数**。
    // 写成 `"14"` / `0` / `-1` 都红：声明了新鲜度却判不了，比没声明更坏（看起来已经守住了）。
    const declaresDays = cfg.maxAgeDays !== undefined && cfg.maxAgeDays !== null;
    const declaresHours = cfg.maxAgeHours !== undefined && cfg.maxAgeHours !== null;
    let maxAgeDays = null;
    let maxAgeHours = null;
    let structBad = false;
    if (declaresDays) {
      if (typeof cfg.maxAgeDays !== "number" || !Number.isInteger(cfg.maxAgeDays) || cfg.maxAgeDays <= 0) {
        errors.push(
          `${BASELINE_REL} 的 \`ends.${end}.maxAgeDays\` 不是正整数：${JSON.stringify(cfg.maxAgeDays)}` +
            `（粒度=自然日；声明了新鲜度就必须能真判 —— 要么写 14 这样的整数，要么整条删掉）`,
        );
        structBad = true;
      } else {
        maxAgeDays = cfg.maxAgeDays;
      }
    }
    if (declaresHours) {
      if (typeof cfg.maxAgeHours !== "number" || !Number.isInteger(cfg.maxAgeHours) || cfg.maxAgeHours <= 0) {
        errors.push(
          `${BASELINE_REL} 的 \`ends.${end}.maxAgeHours\` 不是正整数：${JSON.stringify(cfg.maxAgeHours)}` +
            `（粒度=小时；与 maxAgeDays 同时声明时**取更严者**，故它只能比 maxAgeDays×24 更严或相等）`,
        );
        structBad = true;
      } else {
        maxAgeHours = cfg.maxAgeHours;
      }
    }
    if (structBad) continue;
    const declaresFreshness = declaresDays || declaresHours;
    const hint = END_LABEL_HINTS[end] ?? end;
    const exclude = END_LABEL_EXCLUDES[end] ?? [];
    // R142：**确定性选步**（不再是 `steps.find(...)` 取第一个命中）。
    // admin-api 有两条含 "admin-api" 的测量（默认环境 / SELFTEST_SKIP_ENV_FILE 夹具干净态），
    // 「取第一个」只是碰巧对；这里按「含特异子串 且 不含排除子串」挑，并要求**命中唯一**。
    //
    // R144：选步提到新鲜度**之前** —— per-step `measuredAt` 长在 step 上，不先选步就不知道读哪个时刻。
    // （顺序变化对既有结论无影响：命中歧义时仍然只报这一条，且选步歧义本来就与「数据多旧」无关。）
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
    // R140/R144 判据：**数据新鲜度先于覆盖率高低**。过期 / 无时间戳 ⇒ 数字不可信 ⇒ 不再拿它跟 floor 比；
    // 连「测量失败 / 拿不到数据」也不再重复报（当前动作只有一个：刷新数据），但过期这一条会作为 error 列出。
    // 来源优先级（R152 收紧后）：per-step `measuredAt`（小时级）→【仅未声明 `maxAgeHours` 时】回落文件级
    // `generatedAt`（天级）→ 都没有 ⇒ 红。**声明了 `maxAgeHours` 却缺 `measuredAt` ⇒ 直接红、不回落。**
    if (declaresHours && !declaresDays) freshHoursOnly += 1;
    if (declaresFreshness) {
      const fresh = judgeFreshness(end, {
        maxAgeDays,
        maxAgeHours,
        measuredAt: step?.measuredAt,
        generatedAt: health.generatedAt,
        now: new Date(),
        // R152：声明了 `maxAgeHours` ⇒ 承诺小时级新鲜度 ⇒ per-step 时间戳是硬要求。
        requirePerStep: declaresHours,
        onlyHint: hint,
        stepLabel: step?.label,
      });
      if (fresh.hint) hints.push(fresh.hint);
      // 「判了」= 新鲜度**真的被计算过**（含过期的那一端）—— 过期不是「没判」，报「判 0 端（过期 1）」
      // 会让读者以为判据没跑。过期数单列在 `freshExpired` 里。
      freshJudged += 1;
      if (fresh.missingPerStep) freshMissingStamp += 1;
      if (fresh.source === "per-step") freshPerStep += 1;
      else if (fresh.source === "file") freshFallback += 1;
      if (fresh.expired) {
        freshExpired += 1;
        errors.push(fresh.error);
        if (!skipHeavyWarned) {
          hints.push(SKIP_HEAVY_WARNING);
          skipHeavyWarned = true;
        }
        continue;
      }
    } else {
      freshUndeclared += 1;
    }
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
    // R144：**数字要说清是哪一份状态的实测** —— 报文里点名该端数据的时间来源（per-step 还是回落文件级）。
    // R152：走到这里的端**一定**有 per-step `measuredAt`（声明了 `maxAgeHours` 而缺时间戳的已在上面红掉；
    // 未声明的端仍可能走回落，故保留三态文案）。
    const src = step?.measuredAt
      ? `该 step 的 per-step \`measuredAt\`=${step.measuredAt}`
      : `该 step 没有 per-step \`measuredAt\` ⇒ 回落**文件级** \`generatedAt\`=${String(health.generatedAt)}（天粒度；` +
        `本端**未**声明 \`maxAgeHours\` ⇒ 该回落是**已知盲区**，见头注 R152）`;
    if (declaresFreshness) hints.push(`${end} 实测 ${actual}%（数据来源：${src}）`);
  }
  console.log(
    `（覆盖率棘轮：比较 ${Object.keys(ends).length} 端；新鲜度：判 ${freshJudged} 端` +
      `（来源：per-step \`measuredAt\` ${freshPerStep} 端 / 回落文件级 \`generatedAt\` ${freshFallback} 端` +
      `${freshFallback ? "（回落只对未声明 maxAgeHours 的端成立）" : ""}）` +
      `${freshMissingStamp ? `（**缺 per-step 时间戳 ${freshMissingStamp} 端** ⇒ 红）` : ""}` +
      `${freshExpired ? `（过期 ${freshExpired}）` : ""} / 未声明 maxAgeDays ${freshUndeclared} 端` +
      `${freshHoursOnly ? ` / 仅声明 maxAgeHours ${freshHoursOnly} 端` : ""}；` +
      `实测来源 ${HEALTH_REL}；今天 ${today}）`,
  );
  for (const h of hints) console.log(`   · ${h}`);
  errors.meta = {
    ends: Object.keys(ends).length,
    hints: hints.length,
    freshJudged,
    freshExpired,
    freshUndeclared,
    freshPerStep,
    freshFallback,
    freshMissingStamp,
  };
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
  // ── R144 新增（per-step `measuredAt` 优先 / 回落文件级 / 无法判断 / 取更严者）────────────
  // 夹具里的 `measuredAt` 一律**相对现在**算（`Date.now() - N 小时`）⇒ 断言里的「N 小时」稳定，
  // 且不依赖「今天是哪一天」；天粒度那条回落路径继续复用上面的 `shiftDays`。
  const isoAgoHours = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  /**
   * 单端 + 单 step 的夹具。**关键**：`measuredAt` / `generatedAt` 都可独立缺省 ——
   * 「有哪个时间戳」正是本轮判据的自变量（缺字段 ≠ 字段为空串）。
   */
  const perStepTree = ({ floor = 87.95, pct = 87.45, measuredAt, generatedAt, maxAgeDays, maxAgeHours } = {}) => {
    const end = { floor };
    if (maxAgeDays !== undefined) end.maxAgeDays = maxAgeDays;
    if (maxAgeHours !== undefined) end.maxAgeHours = maxAgeHours;
    const step = { label: "executor-python 全量（`python3 -m pytest`）", code: 0, signal: null, summary: { coveragePct: pct } };
    if (measuredAt !== undefined) step.measuredAt = measuredAt;
    const health = { steps: [step] };
    if (generatedAt !== undefined) health.generatedAt = generatedAt;
    return {
      [BASELINE_REL]: JSON.stringify({ ends: { "executor-python": end } }, null, 2),
      [HEALTH_REL]: JSON.stringify(health, null, 2),
    };
  };
  push("反例⑭（R144）：step 有 `measuredAt` 且很旧（800 小时 > 上限 14 天=336 小时）⇒ exit 1，点名年龄/上限/per-step 来源", () => {
    // pct 故意低于 floor：过期时必须**不判**覆盖率高低（若判据顺序错了会多报「低于基线」）。
    const repo = makeFixtureRepo(
      perStepTree({ measuredAt: isoAgoHours(800), maxAgeDays: 14, generatedAt: shiftDays(0), pct: 87.45, floor: 87.95 }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["已过期 800 小时", "上限 336 小时", "per-step", "不判覆盖率高低"],
        absent: ["低于基线", "可上调基线"],
        withinMs: 20000,
        label: "per-step 过期",
      });
    } finally { repo.cleanup(); }
  });
  push("正例⑦（R144）：step 有 `measuredAt` 且很新（2 小时）**但** `generatedAt` 是 30 天前 ⇒ exit 0（per-step 优先，不被文件级旧日期带红）", () => {
    const repo = makeFixtureRepo(
      perStepTree({ measuredAt: isoAgoHours(2), maxAgeDays: 14, generatedAt: shiftDays(-30), pct: 87.45, floor: 87.45 }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0,
        contains: ["新鲜度：判 1 端", "来源：per-step `measuredAt` 1 端", "数据来源：该 step 的 per-step"],
        absent: ["已过期", "无法判断新鲜度", "低于基线"],
        withinMs: 20000,
        label: "per-step 新鲜",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑮（R144）：step **无** `measuredAt` 且 `generatedAt` 旧（30 天）⇒ exit 1 且报「回落文件级」（天粒度）", () => {
    const repo = makeFixtureRepo(perStepTree({ maxAgeDays: 14, generatedAt: shiftDays(-30), pct: 87.45, floor: 87.95 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["已过期 30 天", "上限 14 天", "回落", "文件级", "不判覆盖率高低"],
        absent: ["低于基线", "可上调基线"],
        withinMs: 20000,
        label: "回落过期",
      });
    } finally { repo.cleanup(); }
  });
  push("正例⑧（R144）：step **无** `measuredAt` 但 `generatedAt` 新（1 天）⇒ exit 0（回落口径可用，历史基线不一夜全红）", () => {
    const repo = makeFixtureRepo(perStepTree({ maxAgeDays: 14, generatedAt: shiftDays(-1), pct: 87.45, floor: 87.45 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0,
        contains: ["新鲜度：判 1 端", "回落文件级 `generatedAt` 1 端", "回落**文件级** `generatedAt`"],
        absent: ["已过期", "无法判断新鲜度", "低于基线"],
        withinMs: 20000,
        label: "回落新鲜",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑯（R144）：`measuredAt` 与 `generatedAt` **都缺** ⇒ exit 1 且点名「无法判断新鲜度」", () => {
    const repo = makeFixtureRepo(perStepTree({ maxAgeDays: 14, pct: 87.45, floor: 87.45 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["无法判断新鲜度", "没有生成时间", "measuredAt", "generatedAt"],
        withinMs: 20000,
        label: "两个时间戳都缺",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑰（R144）：`maxAgeHours` 比 `maxAgeDays` 更严 ⇒ 按更严者判红（30 小时 > 上限 6 小时）", () => {
    // maxAgeDays 14（=336 小时）本会判绿；声明 maxAgeHours=6 ⇒ 取更严者 6 小时 ⇒ 必红。
    const repo = makeFixtureRepo(
      perStepTree({ measuredAt: isoAgoHours(30), maxAgeDays: 14, maxAgeHours: 6, generatedAt: shiftDays(0) }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["已过期 30 小时", "上限 6 小时", "取更严者"],
        withinMs: 20000,
        label: "maxAgeHours 更严",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑱（R144）：`maxAgeHours` 不是正整数（字符串 \"6\"）⇒ exit 1 结构红", () => {
    const repo = makeFixtureRepo(
      perStepTree({ measuredAt: isoAgoHours(1), maxAgeDays: 14, maxAgeHours: "6", generatedAt: shiftDays(0) }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["maxAgeHours", "正整数"], withinMs: 20000, label: "maxAgeHours 非法",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑲（R144）：`measuredAt` 写坏（只有日期、没有时刻）⇒ exit 1「无法判断新鲜度」，**不**回落到新的 `generatedAt`", () => {
    // generatedAt 故意是「昨天」（本会判绿）⇒ 若实现「measuredAt 坏了就回落」，本例会静默变绿。
    const repo = makeFixtureRepo(
      perStepTree({ measuredAt: shiftDays(0), maxAgeDays: 14, generatedAt: shiftDays(-1) }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["无法判断新鲜度", "measuredAt", "**不**回落到文件级"],
        absent: ["回落文件级 `generatedAt` 1 端", "✔ 覆盖率下限通过"],
        withinMs: 20000,
        label: "measuredAt 不可解析",
      });
    } finally { repo.cleanup(); }
  });
  // ── R152 新增（**两条口径的分界**）────────────────────────────────────────────────────────
  // 判据本体：**声明了 `maxAgeHours`（承诺小时级新鲜度）⇒ 该 step 必须有 per-step `measuredAt`**，
  // 缺失 ⇒ 红且**不**回落；**未声明** ⇒ 保持回落文件级 `generatedAt`（天级，兼容面 / 已知盲区）。
  // 下面四条把分界两侧与两个"有本事失败"的方向都钉住：
  //   ⑳ 声明了小时级 + 缺时间戳 ⇒ 红（`generatedAt` 故意是**今天**且 pct 恰好等于 floor ⇒ 若实现偷偷回落就会绿）；
  //   ⑨ 声明了小时级 + 有时间戳（新）⇒ 绿（`generatedAt` 故意 30 天前 ⇒ 若实现错用文件级就会红）；
  //   ㉑ 只声明 `maxAgeDays`（**未**声明 `maxAgeHours`）+ 缺时间戳 ⇒ 绿（兼容面保留，回落照旧可用）；
  //   ㉒ 声明了小时级 + 缺时间戳 + `generatedAt` **极旧**（400 天）⇒ 红的理由是**缺时间戳**，
  //      不是「已过期 400 天」⇒ 证明新判据优先于回落判据（不会被旧日期带偏成另一条报文）。
  push("反例⑳（R152）：声明了 `maxAgeHours` 但 step **缺** `measuredAt` ⇒ exit 1，点名「没有 per-step 时间戳 ⇒ 新鲜度不可信」+ 给刷新命令", () => {
    const repo = makeFixtureRepo(
      perStepTree({ maxAgeDays: 14, maxAgeHours: 336, generatedAt: shiftDays(0), pct: 87.45, floor: 87.45 }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: [
          "没有 per-step 时间戳",
          "新鲜度不可信",
          "maxAgeHours=336",
          "skip-heavy",
          `--only="executor-python"`,
        ],
        absent: ["✔ 覆盖率下限通过", "低于基线", "可上调基线"],
        withinMs: 20000,
        label: "声明小时级却缺时间戳",
      });
    } finally { repo.cleanup(); }
  });
  push("正例⑨（R152）：声明 `maxAgeHours` 且 step **有** `measuredAt`（2 小时）⇒ exit 0，报文点名 per-step 来源（不被 30 天前的 `generatedAt` 带红）", () => {
    const repo = makeFixtureRepo(
      perStepTree({
        measuredAt: isoAgoHours(2),
        maxAgeDays: 14,
        maxAgeHours: 336,
        generatedAt: shiftDays(-30),
        pct: 87.45,
        floor: 87.45,
      }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0,
        contains: ["新鲜度：判 1 端", "来源：per-step `measuredAt` 1 端", "数据来源：该 step 的 per-step"],
        absent: ["没有 per-step 时间戳", "已过期", "无法判断新鲜度", "低于基线"],
        withinMs: 20000,
        label: "声明小时级且新鲜",
      });
    } finally { repo.cleanup(); }
  });
  push("正例⑩（R152）：**只**声明 `maxAgeDays`（未声明 `maxAgeHours`）+ 缺 `measuredAt` ⇒ exit 0（回落面保留）", () => {
    const repo = makeFixtureRepo(
      perStepTree({ maxAgeDays: 14, generatedAt: shiftDays(-1), pct: 87.45, floor: 87.45 }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0,
        contains: ["回落文件级 `generatedAt` 1 端", "回落**文件级** `generatedAt`"],
        absent: ["没有 per-step 时间戳", "已过期", "无法判断新鲜度"],
        withinMs: 20000,
        label: "未声明小时级仍可回落",
      });
    } finally { repo.cleanup(); }
  });
  push("反例㉑（R152）：声明了 `maxAgeHours` + 缺 `measuredAt` + `generatedAt` **极旧**（400 天）⇒ 红的理由必须是「缺 per-step 时间戳」，不是「已过期」", () => {
    const repo = makeFixtureRepo(
      perStepTree({ maxAgeDays: 14, maxAgeHours: 336, generatedAt: shiftDays(-400), pct: 87.45, floor: 87.45 }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["没有 per-step 时间戳", "maxAgeHours=336"],
        absent: ["已过期 400 天", "回落文件级 `generatedAt` 1 端"],
        withinMs: 20000,
        label: "缺时间戳优先于旧日期",
      });
    } finally { repo.cleanup(); }
  });
  push("正例⑪（R158）：**四端**（python/node/admin-api/admin-web）各带 floor 与 `measuredAt` ⇒ exit 0，且报文说「比较 4 端」", () => {
    // R158：admin-web 接入后的**端数**判据：光说「≥1 端」不够，必须钉住 4。
    const steps = [
      { label: "executor-python 全量（`python3 -m pytest`）", code: 0, signal: null, summary: { coveragePct: 87.45 }, measuredAt: "2026-11-07T00:00:00Z" },
      { label: "executor-node 全量（`npm test -- --coverage`）", code: 0, signal: null, summary: { coveragePct: 88.88 }, measuredAt: "2026-11-07T00:00:00Z" },
      { label: "admin-api 全量（默认环境，`npx jest --coverage`）", code: 0, signal: null, summary: { coveragePct: 92.76 }, measuredAt: "2026-11-07T00:00:00Z" },
      { label: "admin-web 全量（`npx vitest run --coverage`）", code: 0, signal: null, summary: { coveragePct: 86.3 }, measuredAt: "2026-11-07T00:00:00Z" },
    ];
    const repo = makeFixtureRepo({
      [BASELINE_REL]: JSON.stringify({
        ends: {
          "executor-python": { floor: 87.45, maxAgeHours: 336 },
          "executor-node": { floor: 88.88, maxAgeHours: 336 },
          "admin-api": { floor: 92.76, maxAgeHours: 336 },
          "admin-web": { floor: 86.3, maxAgeHours: 336 },
        },
      }, null, 2),
      [HEALTH_REL]: JSON.stringify({ generatedAt: "2026-11-07", steps }, null, 2),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0, contains: ["比较 4 端"], withinMs: 20000, label: "四端齐",
      });
    } finally { repo.cleanup(); }
  });
  push("反例㉒（R158）：admin-web 缺 `measuredAt` ⇒ exit 1，且**只**点名 admin-web（不是含糊的「某一端」）", () => {
    // admin-web 是 vitest 插桩、耗时最长的一端 ⇒ 它的缺时间戳必须**指名道姓**，
    // 否则运维不知道该重跑哪一端。
    const repo = makeFixtureRepo({
      [BASELINE_REL]: JSON.stringify({ ends: { "admin-web": { floor: 86.3, maxAgeHours: 336 } } }, null, 2),
      [HEALTH_REL]: JSON.stringify({
        generatedAt: "2026-11-07",
        steps: [{ label: "admin-web 全量（`npx vitest run --coverage`）", code: 0, signal: null, summary: { coveragePct: 86.3 } }],
      }, null, 2),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["admin-web", "没有 per-step 时间戳"], withinMs: 20000, label: "admin-web 缺时间戳",
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
      `✔ 覆盖率下限通过（${errors.meta?.ends ?? 0} 端；新鲜度判 ${errors.meta?.freshJudged ?? 0} 端` +
        `（per-step \`measuredAt\` ${errors.meta?.freshPerStep ?? 0} 端 / 回落文件级 \`generatedAt\` ${errors.meta?.freshFallback ?? 0} 端）/ ` +
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
