/**
 * FEAT-06 维护窗口读面人性化（P2-06）。
 *
 * 维护窗口 start/end 都是 5 段 Cron（半开区间 [start, end)）。详情页此前把
 * 裸表达式 `0 0 * * * → 30 0 * * *` 直接塞进 Tag，非技术用户看不懂。
 * 本工具把可解析的常用模式（每日 / 每周几）翻成「HH:MM–HH:MM」区间，
 * 跨午夜（end ≤ start）追加括注；超出子集（区间/步长/列表等）返回
 * human=null，调用方回退原始 Cron，绝不生成可能误导的描述（与 cron-desc.ts
 * 同策：宁缺勿错）。原始表达式始终保留在 tooltip 作为次要文本。
 */

import i18n from '../i18n';

type TFunc = import('i18next').TFunction;

interface CronTime {
  minute: number;
  hour: number;
  dow: string;
}

function parseCronTime(expr: string): CronTime | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, , , dow] = fields;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m < 0 || m > 59 || h < 0 || h > 23) return null;
  // dow 严格校验（宁缺勿错）：'*' 原样留给下方每日分支；单个数字 0-7 可
  // 人文化，其中 7 是 Quartz 周日别名，归一到既有 dow.0 key；范围/列表/
  // 步进等超集一律 null，让 describeMaintenanceWindow 回退原始 Cron，
  // 避免拼出不存在的 i18n key 后在界面直出裸 key。
  if (dow !== '*') {
    if (!/^\d+$/.test(dow)) return null;
    const d = Number(dow);
    if (d < 0 || d > 7) return null;
    return { minute: m, hour: h, dow: String(d === 7 ? 0 : d) };
  }
  return { minute: m, hour: h, dow };
}

const fmtTime = (h: number, m: number): string =>
  `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

export interface MaintenanceDesc {
  /** 人性化区间文案；null = 表达式超出子集，调用方回退原始 Cron */
  human: string | null;
  /** 区间是否跨午夜（end 时刻 ≤ start 时刻） */
  crossMidnight: boolean;
  /** 原始 `start → end`，用于 tooltip / 次要文本 */
  raw: string;
}

export function describeMaintenanceWindow(
  start: string,
  end: string,
  t?: TFunc,
): MaintenanceDesc {
  const T = (t ?? ((k, o) => i18n.t(k, o ?? {}))) as TFunc;
  const raw = `${start} → ${end}`;
  const s = parseCronTime(start);
  const e = parseCronTime(end);
  if (!s || !e) return { human: null, crossMidnight: false, raw };

  const cross = e.hour * 60 + e.minute <= s.hour * 60 + s.minute;
  const startT = fmtTime(s.hour, s.minute);
  const endT = fmtTime(e.hour, e.minute);
  const [, , domS, monthS, dowS] = start.trim().split(/\s+/);
  const [, , domE, monthE, dowE] = end.trim().split(/\s+/);

  let human: string | null = null;
  // 每日：两端 dom/month/dow 均为 '*'
  if (domS === '*' && monthS === '*' && dowS === '*' && domE === '*' && monthE === '*' && dowE === '*') {
    human = T('taskDetail.maintenance.dailyRange', { start: startT, end: endT });
  } else if (domS === '*' && monthS === '*' && dowS !== '*' && domE === '*' && monthE === '*' && dowE !== '*') {
    const dowStart = T(`cron.desc.dow.${s.dow}`);
    const dowEnd = T(`cron.desc.dow.${e.dow}`);
    human =
      dowStart === dowEnd
        ? T('taskDetail.maintenance.weeklyRangeSame', { dow: dowStart, start: startT, end: endT })
        : T('taskDetail.maintenance.weeklyRangeCross', {
            dowStart,
            start: startT,
            dowEnd,
            end: endT,
          });
  }

  if (human && cross) human += T('taskDetail.maintenance.crossMidnight');
  return { human, crossMidnight: cross, raw };
}
