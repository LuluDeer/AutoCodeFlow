import { AppError } from "../errors/app-error";
import { isUuidShape } from "../decorators/is-uuid-shape.decorator";

/**
 * PLAN-BACKEND-ARCHITECTURE §2.1「游标分页」——**keyset 游标编解码纯函数**。
 *
 * ## 为什么它是纯函数、且单列一处
 *
 * 游标是**唯一跨请求携带的排序状态**：它一旦编解码不自洽，翻页就会漏行/重行，
 * 而这类缺陷在 UI 上表现为"偶发少了几条执行记录"——最难被用户准确描述、也最难
 * 从日志反推的一类生产故障。故编解码抽成无副作用的纯函数，由独立单测把
 * "round-trip / 非法输入 / 同一 createdAt 靠 id 决胜 / base64 变体"全部钉死，
 * 服务层只负责把结果拼进 SQL。
 *
 * ## 为什么编码 `createdAt|id` 而不是只编码 `id`
 *
 * 执行记录的排序键是 `(createdAt DESC, id DESC)`（task.service.getExecutions，
 * FIX-5.3 加的决胜键）。`createdAt` **非唯一**——批量触发/扇出会写出同一时刻的
 * 多行——所以单靠 id 无法定位"上一页最后一行在排序里的位置"：id 是随机 uuid，
 * 与 createdAt 无单调关系。两者必须成对出现，这就是 keyset 的元组比较
 * `(createdAt, id) < (cursorCreatedAt, cursorId)`。
 *
 * ## 为什么是 base64url 而不是 base64
 *
 * 游标要作为 query 参数出现在 URL 里。标准 base64 的 `+` 在 query string 中会被
 * 解码成空格、`/` 与 `=` 也有转义歧义（不同客户端/代理的处理并不一致）。本实现
 * 用 **base64url + 去 padding**（RFC 4648 §5），产物只含 `[A-Za-z0-9_-]`，任何
 * URL 编解码层都不会改写它。
 *
 * ## 为什么非法游标一律 400，绝不"从头开始"
 *
 * 静默回退到第一页会让客户端陷入**翻页死循环**：客户端带着游标请求，服务端
 * 悄悄返回第 1 页并下发新的第 1 页游标，客户端再请求仍然是第 1 页……循环没有
 * 终点，且每一轮都是 HTTP 200，监控上看不出任何异常。宁可 400——调用方能立刻
 * 知道自己传错了游标，且这个错误可被断言的错误码识别。
 *
 * 同理**绝不**把不可解析的游标当成 `null`：`null` 在服务层意味着"没有游标 →
 * 走 OFFSET 分支"，正是死循环的入口。
 */

/**
 * 游标载荷：排序键 `(createdAt, id)` 的原值。
 *
 * `createdAt` 是 **ISO 8601 字符串**而**不是** `Date`——原因见
 * `decodeExecutionCursor` 的长注释（`timestamp` 列只有微秒精度）。
 */
export interface KeysetCursor {
  /** ISO 8601 时间串（解码后已校验为合法时间）。 */
  createdAt: string;
  /** 行主键（uuid 形状）。 */
  id: string;
}

/**
 * 语义化别名：keyset 元组本身与表无关（`(createdAt, id)`），本模块只有**一份**
 * 实现。`ExecutionCursor` 是 `GET /tasks/:id/executions` 引入时的历史命名，保留
 * 为别名以免既有调用点改名；新代码用 `KeysetCursor`。两者**同一个类型**——不是
 * 两份结构相同的接口（那会让"改一处忘另一处"成为可能）。
 */
export type ExecutionCursor = KeysetCursor;

/**
 * 游标内部的字段分隔符。
 *
 * 用 `|` 是因为它**不出现在** ISO 8601 时间串与 uuid 里，故 `split` 结果恒为
 * 两段；而且它本身就是明文，若客户端把游标 base64 解开看到 `2026-01-01T…|uuid`
 * 也能直接读懂（排障友好）。**不要**换成 `:`——ISO 时间串里全是冒号。
 */
const SEGMENT_SEPARATOR = "|";

/**
 * base64url 的严格判据：去 padding 后只允许 `[A-Za-z0-9_-]`，长度非 0 且
 * **不落在 `len % 4 === 1`**（该余数在 base64 里不可能出现，表示输入被截断）。
 *
 * 为什么要先自己判一次而不是直接把 `Buffer.from(s, "base64url")` 的结果丢给
 * 后续校验：Node 的 base64 解码器**极其宽容**——它忽略非法字符、容忍错误
 * padding，甚至把 `"abc$%"` 静默解成 `"abc"`。若不前置拦截，一个被截断/被
 * 中间件改写的游标可能"恰好"解出看似合法的时间串，翻页就从"明确报错"退化成
 * "悄悄跳到某个位置"，正是本模块要防的那类静默。
 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** 复合游标载荷的长度上限（base64url 文本字符数）。见 `decodeCompositeCursor`。 */
const MAX_CURSOR_LENGTH = 512;

/** 复合游标第一分量的长度上限（解 base64 之后的原始字符数）。 */
const MAX_CURSOR_KEY_LENGTH = 128;

/**
 * ISO 8601（本仓口径：UTC `Z` 结尾，秒可有可无小数、小数 1–6 位）。
 *
 * 带捕获组是为了做**日历字段回读校验**（见 decodeExecutionCursor）——单靠
 * `new Date(...)` 判不出 `2026-02-30` 这类"会被静默归一化"的日期。
 */
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;

/**
 * 把游标载荷编码成不透明字符串。
 *
 * 入参由服务层从**数据库行**直接取（`row.createdAt` / `row.id`），不做任何
 * 业务判断。`createdAt` 接受 `Date` 或 ISO 串：服务层拿到的是实体（`Date`），
 * 测试里手写 ISO 串更直观，两种都收。
 */
export function encodeKeysetCursor(
  createdAt: Date | string,
  id: string,
): string {
  const iso =
    createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  return Buffer.from(`${iso}${SEGMENT_SEPARATOR}${id}`, "utf8")
    .toString("base64url")
    .replace(/=+$/, "");
}

/**
 * `GET /tasks/:id/executions` 的语义化包装（见 `KeysetCursor` / `ExecutionCursor`
 * 别名说明）。**不是第二份实现**——直接转调 `encodeKeysetCursor`。
 */
export function encodeExecutionCursor(
  createdAt: Date | string,
  id: string,
): string {
  return encodeKeysetCursor(createdAt, id);
}

/**
 * 解出游标载荷；**任何**不合法形态一律抛 400（`VALIDATION_FAILED`）。
 *
 * ## 为什么复用 `VALIDATION_FAILED` 而不新增一个 `CURSOR_INVALID` 码
 *
 * 语义上更想要专用码（前端能给出"请从第一页重新开始"这类可操作指引）。但本仓
 * 的错误码是**单一真值源**：`catalog/*.ts` → `scripts/gen-error-i18n.mjs` →
 * `apps/admin-web/src/locales/generated/error-codes.{zh,en}.ts`，`check:error-i18n-drift`
 * 会在码表变动时判红，要求同步重新生成前端产物。本轮的范围**明确禁止**改
 * `apps/admin-web`（前端迁移是后续版本的事），新增码会让那条门禁变红且无法在
 * 本轮内合法转绿。故这里复用既有的通用 400 码——`detail` 里带上可读原因，
 * 调用方仍能靠 **HTTP 400** 稳定区分"游标坏了"与"翻到底了"，这是本轮真正需要
 * 的契约。
 *
 * 将来若要专用码，正确做法是：加 `CURSOR_INVALID` 到码表 + 重新生成前端产物，
 * 两件事必须在**同一轮**里做（单独做任何一件都会让门禁红）。
 *
 * 被拒绝的输入（全部有单测钉住）：
 *   · 非字符串 / 空串 / 非 base64url 字符 / 长度余数为 1（截断）；
 *   · base64 解出的不是 UTF-8 文本、或字段数 ≠ 2；
 *   · 时间字段非 ISO 8601、或 `Date.parse` 给出 NaN、或日历字段回读不一致
 *     （后者拦住 `2026-02-30` 这类"能被 Date 归一化、但原值非法"的日期）；
 *   · id 不是 uuid 形状。
 *
 * ⚠️ **`createdAt` 保持字符串、不在这里转成 `Date`** —— 这是本模块最容易写错的
 * 一处。**两张表的时间列都是 PG 微秒精度**（已实测核实，见下），而 JS `Date`
 * 只有毫秒。若把游标**载荷**规整成 `Date`，等于把数据库里的 `…:00.123456` 截成
 * `…:00.123`，payload 就永久丢了微秒信息。故载荷保持原始 ISO 串。
 *
 * ⚠️⚠️ 但**绝不能用这个毫秒串去近似"游标行的位置"**。这是 704f749e 的真实缺陷，
 * 实测定性后已改为"行值比较 + 子查询取游标行的库内精确值"（服务层实现）：
 *
 *   · 载荷层（本模块）：保持 ISO 串，仅作**排障可读**与 forward-compat，
 *     **不参与任何比较运算**；
 *   · 绑定层（服务层）：只把 `id` 交给 SQL，时间由
 *     `(createdAt, id) < (SELECT c."createdAt", c.id ... WHERE c.id = :cursorId)`
 *     从库里按主键取原值——DB 值比 DB 值，零精度损失。
 *
 * 为什么不能用毫秒串近似（两层原因，都实测过）：
 *
 *   ① **时区**：列是 naive `timestamp`。PG 把带 `Z` 的**文本**强转成 naive
 *      timestamp 时**丢弃时区**、按会话本地墙钟解释；而 pg 驱动把 `Date` 序列化
 *      时按本地墙钟输出。两者在 UTC 会话下恰好一致，UTC+8 下相差 8 小时。
 *      实测（Asia/Shanghai，同一游标行，`WHERE "createdAt" < $1` 命中行数，真值
 *      2 行）：字符串参数 → **0 行**（漏行），`Date` 参数 → **2 行**。
 *   ② **精度**：即便绑定正确，`(createdAt < at OR (createdAt < at+1ms AND id < cid))`
 *      这套"毫秒半开区间"隐含"同毫秒内排序由 id 决定"，只在同毫秒行的微秒值**恰好
 *      相等**时成立。实测（同毫秒 4 行）：该式返回 **4 行**（含游标行本身，翻页
 *      打转），行值比较返回 **3 行**（正确）。
 *
 * 完整论证与精确触发条件见 `task.service.getExecutionsByKeyset` /
 * `findAllByKeyset` 的头注。
 *
 * ## 精度核实结果（不是假设，是实测）
 *
 * `information_schema.columns` 对两列给出**完全一致**的结论：
 *
 *   task_executions."createdAt" → timestamp without time zone, datetime_precision = 6
 *   tasks."createdAt"           → timestamp without time zone, datetime_precision = 6
 *
 * `tasks` 一侧还有实体与迁移的双重佐证：`task.entity.ts:410` 是裸
 * `@CreateDateColumn()`（TypeORM 对 `Date` 属性派生 `timestamp`，**不带**
 * `precision` 选项 → 走 PG 默认 `timestamp(6)`），建表迁移
 * `1717473142678-InitialSchema.ts:75` 写的是 `"createdAt" TIMESTAMP NOT NULL
 * DEFAULT now()`（未限定精度 = PG 默认微秒），且全量迁移史里**没有**任何
 * `ALTER COLUMN "createdAt" TYPE ...` 把它降精度。写路径也不显式赋值
 * （`findAll` 之外的三处 `taskRepo.create/save` 均不带 createdAt），取的是
 * `now()` 默认值——实测 `autoflow_test` 库中 `tasks` 的 3/3 行都带非零微秒分量。
 *
 * 故 tasks 与 task_executions **同属微秒列**，两个端点必须用同一套正确谓词
 * （行值比较），不能因为"tasks 行比执行行少、不太可能同刻"就退化成毫秒近似。
 */
export function decodeKeysetCursor(raw: unknown): KeysetCursor {
  const invalid = (): never => invalidKeysetCursor();

  if (typeof raw !== "string") invalid();
  const text = (raw as string).trim();
  if (!text) invalid();
  if (!BASE64URL_RE.test(text)) invalid();
  // 单个字符不可能是任何 base64 编码的产物；且 len%4===1 表示尾部被截断。
  if (text.length % 4 === 1) invalid();

  let decoded: string;
  try {
    decoded = Buffer.from(text, "base64url").toString("utf8");
  } catch {
    return invalid();
  }

  // 解出来必须是「ISO 时间 | uuid」两段，不能多也不能少。
  const parts = decoded.split(SEGMENT_SEPARATOR);
  if (parts.length !== 2) invalid();
  const [iso, id] = parts;

  const match = ISO_INSTANT_RE.exec(iso);
  if (!match) invalid();
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) invalid();
  // 日历回读：`Date` 会把非法日期**静默归一化**（`2026-02-30` → `2026-03-02`，
  // `2026-13-01` → `2027-01-01`）。所以不能只判 NaN，必须把解析结果的年月日
  // 时分秒读回来跟原文比对——不一致就说明游标编码的是一个数据库里根本不存在的
  // 时刻，继续用它做元组比较只会得到一个语义不明的切片。
  //
  // ⚠️ 这里**刻意不用** `parsed.toISOString() === iso`：那会把合法的
  // "无毫秒"（`…:05Z`）与"微秒"（`…:05.123456Z`）两种形态全部误判为非法
  // （`toISOString()` 恒输出 3 位小数），而微秒正是本列的真实精度。
  if (
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() !== Number(match[2]) - 1 ||
    parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCHours() !== Number(match[4]) ||
    parsed.getUTCMinutes() !== Number(match[5]) ||
    parsed.getUTCSeconds() !== Number(match[6])
  ) {
    invalid();
  }

  if (!isUuidShape(id)) invalid();

  return { createdAt: iso, id };
}

/**
 * 由**一页的原始行**算出下一页游标；`null` = 没有下一页。
 *
 * 语义要点：
 *   · 入参必须是数据库**按 `(createdAt DESC, id DESC)` 排好序后的行**，本函数
 *     只取最后一行——它天然是"本页最靠后"的位置，下一页从它之后继续。
 *   · 空页 → `null`（没有"最后一行"可作游标，硬造一个会是错的）。
 *   · 不清洗 `createdAt` 的类型：实体给 `Date`、raw 查询给字符串都支持，编码
 *     时统一走 `encodeExecutionCursor`（见其注释）。
 *
 * 与 `extra`（多取一行）配合的用法见 `task.service.getExecutions`：那里取
 * `pageSize + 1` 行，用"是否多出第 N+1 行"判断 hasMore，再把多出的那行丢掉。
 */
/**
 * 游标非法的**唯一**抛出点：任何形态问题的 400 都从这里出去，保证 detail 文案与
 * 错误码在"执行历史"与"任务列表"两个端点之间逐字节一致（调用方只需实现一次
 * 处理逻辑）。
 */
export function invalidKeysetCursor(): never {
  throw new AppError("VALIDATION_FAILED", {
    detail:
      "cursor（分页游标无效或已损坏，请不带 cursor 参数从第一页重新开始）",
  });
}

/** `GET /tasks/:id/executions` 的语义化包装（转调 `decodeKeysetCursor`）。 */
export function decodeExecutionCursor(raw: unknown): ExecutionCursor {
  return decodeKeysetCursor(raw);
}

/**
 * 复合游标（排序键不是 `(createdAt, id)` 时的载荷）。见 `decodeCompositeCursor`。
 *
 * `key` 存**数据库列的原值**（数字列的字符串形态），`id` 是决胜键。
 */
export interface CompositeCursor {
  /** 排序键列的原始字符串形态（数字列如 priority/timeout 也是字符串）。 */
  key: string;
  /** 行主键（uuid 形状）。 */
  id: string;
}

/**
 * 把复合游标编码成不透明字符串：`<key>|<id>` 再 base64url。
 *
 * 与 `encodeKeysetCursor` 共用 `SEGMENT_SEPARATOR` / 去 padding 规则，只是不再
 * 把第一个分量当作 ISO 时间——语义差异不在编码层，在解码层的校验强度。
 */
export function encodeCompositeCursor(
  key: string | number,
  id: string,
): string {
  return Buffer.from(`${String(key)}${SEGMENT_SEPARATOR}${id}`, "utf8")
    .toString("base64url")
    .replace(/=+$/, "");
}

/**
 * 解出复合游标。校验强度**刻意放宽**（第一分量只要求"非空、不含分隔符、
 * 长度受限"），原因见下面两段。
 *
 * ## 为什么这里不做时间/uuid 那种强校验
 *
 * 第一分量在复合模式下可能是 `status`（enum label）、`runtime`（enum label）、
 * `priority`（数字）、`timeout`（数字）……**值域由服务层当次的白名单决定**，
 * 纯函数无从知道"哪些 label 合法"。所以这里只做**结构性**校验（形状、长度、
 * 分隔符数量），取值合法性由服务层把它当 SQL 参数喂给 PG：
 *   · 它**永远不会被拼进 SQL 文本**——只经 `:param` 参数化绑定，故不是注入面；
 *   · 非法值不可能"恰好"匹配到行，结果是一个空的下一页，而不是语义错乱的切片。
 *
 * ## 为什么仍要拒绝空载荷 / 超长载荷
 *
 * 空第一分量会让"继续"语义退化成"从头开始"（正是本模块头注禁止的静默降级）；
 * 超长载荷则是无意义的放大请求（服务端不该为任意长度的 payload 做 base64 解码）。
 */
export function decodeCompositeCursor(raw: unknown): CompositeCursor {
  const invalid = (): never => invalidKeysetCursor();

  if (typeof raw !== "string") invalid();
  const text = (raw as string).trim();
  if (!text) invalid();
  if (!BASE64URL_RE.test(text)) invalid();
  if (text.length % 4 === 1) invalid();
  // 复合游标的合法载荷远短于此（enum label / 数字 + uuid）；上限只防放大攻击。
  if (text.length > MAX_CURSOR_LENGTH) invalid();

  let decoded: string;
  try {
    decoded = Buffer.from(text, "base64url").toString("utf8");
  } catch {
    return invalid();
  }

  const parts = decoded.split(SEGMENT_SEPARATOR);
  if (parts.length !== 2) invalid();
  const [key, id] = parts;
  if (!key) invalid();
  if (key.length > MAX_CURSOR_KEY_LENGTH) invalid();
  if (!isUuidShape(id)) invalid();

  return { key, id };
}

/**
 * 由**一页的原始行**算出下一页游标；`null` = 没有下一页。
 *
 * 语义要点：
 *   · 入参必须是数据库**按 `(createdAt DESC, id DESC)` 排好序后的行**，本函数
 *     只取最后一行——它天然是"本页最靠后"的位置，下一页从它之后继续。
 *   · 空页 → `null`（没有"最后一行"可作游标，硬造一个会是错的）。
 *   · 不清洗 `createdAt` 的类型：实体给 `Date`、raw 查询给字符串都支持，编码
 *     时统一走 `encodeKeysetCursor`（见其注释）。
 *
 * 与 `extra`（多取一行）配合的用法见 `task.service.getExecutions`：那里取
 * `pageSize + 1` 行，用"是否多出第 N+1 行"判断 hasMore，再把多出的那行丢掉。
 */
export function nextKeysetCursor(
  rows: ReadonlyArray<{ createdAt?: Date | string | null; id?: string | null }>,
): string | null {
  if (!rows || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const { createdAt, id } = last ?? {};
  // 行缺关键列 → 不编游标（返回 null 让调用方判定"没有下一页"）。**不抛错**：
  // 这是服务端数据完整性问题的信号，不该伪装成客户端的 400。
  if (createdAt == null || id == null) return null;
  return encodeKeysetCursor(createdAt, id);
}

/** `GET /tasks/:id/executions` 的语义化包装（转调 `nextKeysetCursor`）。 */
export function nextExecutionCursor(
  rows: ReadonlyArray<{ createdAt?: Date | string | null; id?: string | null }>,
): string | null {
  return nextKeysetCursor(rows);
}

/**
 * 复合模式下的"下一页游标"：取本页最后一行的 `(sortKey 列值, id)`。
 *
 * 与 `nextKeysetCursor` 同一套契约（空页 → null，缺列 → null 不抛错），差别只在
 * 第一个分量读哪一列——由调用方给 `pickKey` 从行上取值，因为"排序键是哪列"是
 * 服务层当次请求的上下文，纯函数无从推断。
 */
export function nextCompositeCursor<T>(
  rows: ReadonlyArray<T>,
  pickKey: (row: T) => string | number | null | undefined,
): string | null {
  if (!rows || rows.length === 0) return null;
  const last = rows[rows.length - 1] as T;
  const id = (last as { id?: string | null } | null)?.id;
  if (id == null) return null;
  const key = pickKey(last);
  if (key == null) return null;
  return encodeCompositeCursor(key, id);
}
