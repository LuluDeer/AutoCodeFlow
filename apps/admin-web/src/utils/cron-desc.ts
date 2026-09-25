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
 * 与 timeFormat.ts 同范式：中文基线内联（测试锚定），传 t 时输出走 i18n。
 */

type TFunc = (k: string, opts?: Record<string, unknown>) => string;

const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'];

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
  const T = t;

  // —— 每分钟 ——
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return T ? T('cron.desc.everyMinute') : '每分钟';
  }

  // —— 每 N 分钟（`*/n * * * *`）——
  if (hour === '*' && dom === '*' && month === '*' && dow === '*' && /^\*\/(\d+)$/.test(minute)) {
    const n = Number(minute.slice(2));
    if (n < 1 || n > 59) return null;
    return n === 1
      ? (T ? T('cron.desc.everyMinute') : '每分钟')
      : (T ? T('cron.desc.everyNMinutes', { n }) : `每 ${n} 分钟`);
  }

  // —— 每小时第 M 分（分钟为具体值，小时 '*'）——
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const minutes = parseNumberList(minute, 59);
    if (minutes && minutes.length >= 1) {
      const times = minutes.map((m) => `:${String(m).padStart(2, '0')}`).join(', ');
      return T ? T('cron.desc.hourly', { times }) : `每小时 ${times}`;
    }
    return null;
  }

  const times = parseTimes(minute, hour);
  if (!times) return null;

  // —— 每天 ——
  if (dom === '*' && month === '*' && dow === '*') {
    return T ? T('cron.desc.daily', { times }) : `每天 ${times}`;
  }

  // —— 每周几 ——
  if (dom === '*' && month === '*' && dow !== '*') {
    const dows = parseNumberList(dow, 7);
    if (!dows || dows.length === 0) return null;
    const names = dows.map((d) => DOW_ZH[d]).join('、');
    return T ? T('cron.desc.weekly', { dow: names, times }) : `每周${names} ${times}`;
  }

  // —— 每月几号 ——
  if (month === '*' && dow === '*' && dom !== '*') {
    const doms = parseNumberList(dom, 31);
    if (!doms || doms.length === 0) return null;
    return T ? T('cron.desc.monthly', { dom: doms.join('、'), times }) : `每月 ${doms.join('、')} 日 ${times}`;
  }

  // —— 每年（月/日均为单个数字）——
  if (dow === '*') {
    const doms = parseNumberList(dom, 31);
    const months = parseNumberList(month, 12);
    if (doms && months && doms.length === 1 && months.length === 1) {
      return T
        ? T('cron.desc.yearly', { month: months[0], dom: doms[0], times })
        : `每年 ${months[0]} 月 ${doms[0]} 日 ${times}`;
    }
  }

  return null;
}
