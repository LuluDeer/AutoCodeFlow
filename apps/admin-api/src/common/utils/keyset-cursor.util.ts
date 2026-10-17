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
export interface ExecutionCursor {
  /** ISO 8601 时间串（解码后已校验为合法时间）。 */
  createdAt: string;
  /** 执行记录主键（uuid 形状）。 */
  id: string;
}

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
export function encodeExecutionCursor(
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
 * 一处。`task_executions.createdAt` 的列类型是 `TIMESTAMP`（不带时区，PG 精度
 * 微秒），而 JS `Date` 只有毫秒。若把游标规整成 `Date` 再回传给 SQL，等于把
 * 数据库里的 `…:00.123456` 截成 `…:00.123`，元组比较的第一分量就**变小**了，
 * 同一时刻的若干行会被判定为"还大于游标"而**重复返回**（翻页重行）。保留原始
 * ISO 串交给 TypeORM 参数化（PG 侧重新解析成同一微秒值）可保证逐字节往返。
 */
export function decodeExecutionCursor(raw: unknown): ExecutionCursor {
  const invalid = (): never => {
    throw new AppError("VALIDATION_FAILED", {
      detail:
        "cursor（分页游标无效或已损坏，请不带 cursor 参数从第一页重新开始）",
    });
  };

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
export function nextExecutionCursor(
  rows: ReadonlyArray<{ createdAt?: Date | string | null; id?: string | null }>,
): string | null {
  if (!rows || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const { createdAt, id } = last ?? {};
  // 行缺关键列 → 不编游标（返回 null 让调用方判定"没有下一页"）。**不抛错**：
  // 这是服务端数据完整性问题的信号，不该伪装成客户端的 400。
  if (createdAt == null || id == null) return null;
  return encodeExecutionCursor(createdAt, id);
}
