/**
 * CRON-DESC-01：常用 5 段 Cron 表达式的人类可读描述。
 *
 * 背景：列表/详情页此前只渲染裸表达式（`0 12,18 * * *`），用户得自己心算
 * 「这是每天 12 点和 18 点」。本工具覆盖调度平台最常见的模式族：
 * 每 N 分钟 / 每小时第 M 分 / 每天（小时列表）/ 每周几 / 每月几号 / 每年。
 *
 * 原则：**宁缺勿错**——任何超出子集的表达式（区间、步长小时、月份列表、
 * 秒级 6 段等）返回 null，调用方回退为只显示原始表达式，绝不生成可能
 * 误导的描述。
 *
 * 与 timeFormat.ts 同范式：输出统一走 i18n（cron.desc.* / cron.desc.dow.*，
 * zh/en 双侧成对）。传 t 时用调用方的 t（组件内 useTranslation）；缺省回落
 * i18n 单例（跟随当前语言，非组件文件直引单例与 api/tasks.ts 同模式）——
 * 此前缺省路径内联中文，英文界面直调时会漏中文，现随语言走。
 */

import i18n from '../i18n';

type TFunc = (k: string, opts?: Record<string, unknown>) => string;

/** 缺省 t：i18n 单例（测试环境默认 zh，与旧中文基线输出逐字一致）。 */
const fallbackT: TFunc = (k, opts) => i18n.t(k, opts);

/** 把字段解析为数字列表（如 `12,18`）；仅接受纯数字/逗号 */
function parseNumberList(field: string, max: number): number[] | null {
  if (!/^(\d+)(,\d+)*$/.test(field)) return null;
  const nums = field.split(',').map(Number);
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > max)) return null;
  return nums;
}

function fmtTime(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 分钟+小时均为具体数字列表时给出时刻串（`12:00, 18:00`），否则 null */
function parseTimes(minute: string, hour: string): string | null {
  const minutes = parseNumberList(minute, 59);
  if (!minutes || minutes.length === 0) return null;
  const hours = parseNumberList(hour, 23);
  if (!hours || hours.length === 0) return null;
  return hours.flatMap((h) => minutes.map((m) => fmtTime(h, m))).join(', ');
}

export function describeCron(expr: string | null | undefined, t?: TFunc): string | null {
  if (!expr) return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  const T = t ?? fallbackT;

  // —— 每分钟 ——
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return T('cron.desc.everyMinute');
  }

  // —— 每 N 分钟（`*/n * * * *`）——
  if (hour === '*' && dom === '*' && month === '*' && dow === '*' && /^\*\/(\d+)$/.test(minute)) {
    const n = Number(minute.slice(2));
    if (n < 1 || n > 59) return null;
    return n === 1 ? T('cron.desc.everyMinute') : T('cron.desc.everyNMinutes', { n });
  }

  // —— 每小时第 M 分（分钟为具体值，小时 '*'）——
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const minutes = parseNumberList(minute, 59);
    if (minutes && minutes.length >= 1) {
      const times = minutes.map((m) => `:${String(m).padStart(2, '0')}`).join(', ');
      return T('cron.desc.hourly', { times });
    }
    return null;
  }

  const times = parseTimes(minute, hour);
  if (!times) return null;

  // —— 每天 ——
  if (dom === '*' && month === '*' && dow === '*') {
    return T('cron.desc.daily', { times });
  }

  // —— 每周几 ——
  if (dom === '*' && month === '*' && dow !== '*') {
    const dows = parseNumberList(dow, 7);
    if (!dows || dows.length === 0) return null;
    // 星期名走 cron.desc.dow.*（zh 汉字/en 缩写，双语成对）——此前即便传 t
    // 也用硬编码 DOW_ZH，英文界面会把「一、二、三」漏进 "Weekly on …"。
    const names = dows.map((d) => T(`cron.desc.dow.${d}`)).join('、');
    return T('cron.desc.weekly', { dow: names, times });
  }

  // —— 每月几号 ——
  if (month === '*' && dow === '*' && dom !== '*') {
    const doms = parseNumberList(dom, 31);
    if (!doms || doms.length === 0) return null;
    return T('cron.desc.monthly', { dom: doms.join('、'), times });
  }

  // —— 每年（月/日均为单个数字）——
  if (dow === '*') {
    const doms = parseNumberList(dom, 31);
    const months = parseNumberList(month, 12);
    if (doms && months && doms.length === 1 && months.length === 1) {
      return T('cron.desc.yearly', { month: months[0], dom: doms[0], times });
    }
  }

  return null;
}
