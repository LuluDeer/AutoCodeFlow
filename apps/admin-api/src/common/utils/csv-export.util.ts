/**
 * CSV 导出的**安全与形态**原语（纯函数，无 IO、无 Nest 依赖）。
 *
 * ## 为什么单列一份（而不是每个导出端点各写一份）
 *
 * 本仓已有两个 CSV 导出消费面（`GET /audit/export` 与
 * `GET /tasks/executions/export`），而且**将来只会更多**（任何"到期即删"的表
 * 都需要一条导出逃生通道）。CSV 的两个致死点恰好都是「写错一次、静默生效、
 * 事后不可补救」的形态：
 *
 *   ① **公式注入**：单元格以 `= + - @ \t \r` 开头时，Excel / LibreOffice /
 *      Google Sheets 打开 CSV 会把它当**公式执行**——执行记录里的
 *      `errorMessage` 是执行器上报的任意文本，攻击者只要让一个任务失败并上报
 *      `=HYPERLINK("http://evil","点我")`，运维导出后双击打开即中招。
 *   ② **引号包裹顺序**：防注入的前缀单引号必须在 RFC 4180 引号包裹**之前**
 *      加——顺序反了会把引号也包进去，单元格内容变成 `'"=HYPERLINK(…)"`，
 *      表格软件显示出一个多余的单引号，而运维会以为数据本来就是那样。
 *
 * 这两点都是「照抄一份能跑」但「各写一份必然漂移」的逻辑，故收敛为纯函数，
 * 由各导出端点复用；各自的**业务列**（表头与取值）仍留在各自模块里。
 *
 * ## 与 audit.service.exportCsv 的关系（本轮不迁）
 *
 * 本文件的判据来自 `audit.service.exportCsv` 的既有实现（该端点是本仓唯一
 * 已验证的 CSV 导出先例），差别只有一处**收紧**：RFC 4180 的引号触发条件
 * 额外纳入单独 `\r`——只判 `\n` 时，一个带孤立 CR 的 `errorMessage` 会把
 * 一行切两行（audit 侧的历史值域里没有这种输入，故未暴露）。
 *
 * `audit.service.ts` 本轮**不改**：它的内联 escape 已被
 * `audit.service.spec.ts` 的行为用例钉住，且审计导出不在本次改动范围内。
 * 迁移它到本文件是一次独立的、零行为的收敛（建议与下一个 CSV 消费面一起做，
 * 避免"改了没人验证"）。
 */

/**
 * 会触发表格软件公式解析的前缀字符（OWASP "CSV Injection" 口径）。
 *
 * `\t` 与 `\r` 单列进来是因为部分表格软件会**先剥掉前导空白**再判公式，于是
 * `"\t=1+1"` 仍会被执行；它们本身也不是任何合法单元格的开头。
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * 把任意值渲染成一个**安全**的 CSV 单元格。
 *
 * 处理顺序是刻意的（与 audit.service.exportCsv 的既有实现逐字节等价）：
 *   1. null/undefined → 空串（区分"没有值"与"值是空串"在 CSV 里不可能，
 *      统一成空串是唯一不误导的选择）；
 *   2. 公式前缀防护：前缀一个单引号。选单引号而不是前导空格/制表符，是因为
 *      它是 Excel 与 Google Sheets **共同**认可"这是字面文本"的标记，且不会
 *      在单元格里显示出多余字符；
 *   3. RFC 4180 引号包裹：含逗号 / 双引号 / 换行时整体加引号、内部双引号翻倍。
 *      `\r` 也必须触发包裹——只判 `\n` 会让带单独 CR 的值把一行切成两行。
 *
 * ⚠️ **不要**把这个函数改成"先包裹再防注入"，也不要为了"少一层判断"把
 * 公式前缀检查挪到包裹之后——两条都会让防护失效（理由见文件头注）。
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_PREFIX.test(s)) {
    s = `'${s}`;
  }
  if (
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes("\r")
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** 把一行取值渲染成 CSV 文本行（不含换行符）。单元格逐个走 `escapeCsvCell`。 */
export function toCsvRow(cells: readonly unknown[]): string {
  return cells.map(escapeCsvCell).join(",");
}

/**
 * 导出达到行上限时的**有痕截断**注释行。
 *
 * 意义不是"少导几行"，而是让打开 CSV 的运维**看得见**截断发生过——否则
 * 10000 行与"全量恰好 10000 行"在文件里毫无区别，据以做的容量/合规判断会
 * 直接错。`#` 前缀不在公式字符集内，表格软件按文本处理（且整行无逗号，
 * 不会被引号包裹，人眼扫一眼就能看见）。
 */
export function csvTruncationMarker(cap: number): string {
  return `# truncated at ${cap} rows`;
}
