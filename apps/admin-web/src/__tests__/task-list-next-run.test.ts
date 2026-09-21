/**
 * P1-1 / P1-2（UX-AUDIT-2026-09-21）：任务列表必须能回答
 * 「它下次什么时候跑」与「它上次跑是什么时候」。
 *
 * ## 这两个问题为什么重要
 *
 * 这是一个**调度平台**。最坏的故障不是"任务失败"（那会告警、有日志、看得见），
 * 而是"任务根本没在跑却没人发现"——静默不执行在上百个任务里几乎不可见。
 *
 * 而此前：
 *   · 「下次执行」列只渲染静态徽章「Cron 计划中」/「定时运行中」，列题与 tooltip
 *     却承诺「下次 Cron 触发时间」——**承诺了时刻却从不给出时刻**；
 *   · `lastTriggerTime` 在 DB 里一直存在、后端一直返回、甚至已在**排序白名单**里
 *     （可以按它排序），但界面从不显示——能力建好了没接上。
 *
 * 于是用户既答不出"下次何时跑"，也答不出"上次何时跑"，更无法察觉
 * "这任务三个月没动过了"。
 *
 * ## 断言策略
 *
 * 核心在纯函数 `nextRunAt`：它必须给出**真实**时刻，且在无法确定时返回 null
 * （**绝不猜一个假时刻**——猜错比不显示更误导运维）。同时钉住几个容易搞错的
 * 语义边界：暂停任务不调度、手动任务没有"下次"。
 */
import { describe, it, expect } from 'vitest';
import { nextRunAt } from '../utils/trigger-preview';

describe('P1-1: nextRunAt（列表页「下次执行」的真实时刻）', () => {
  const NOW = new Date('2026-09-21T00:00:00Z');

  it('cron 任务：算出真实的最近一次触发时刻（不再是静态徽章）', () => {
    const next = nextRunAt(
      {
        status: 'active',
        triggerType: 'cron',
        cronExpression: '0 8 * * *',
        timezone: 'UTC',
      },
      NOW,
    );
    expect(next).toBeInstanceOf(Date);
    // 00:00 UTC 起算，下一次 08:00 就是当天
    expect(next!.toISOString()).toBe('2026-09-21T08:00:00.000Z');
  });

  it('fixed_rate 任务：按间隔算出下次时刻', () => {
    const next = nextRunAt(
      { status: 'active', triggerType: 'fixed_rate', fixedRate: 300 },
      NOW,
    );
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime() - NOW.getTime()).toBe(300_000);
  });

  it('已暂停/失败的任务不调度 → null（不得显示一个不会发生的时刻）', () => {
    // 反证核心：若忽略 status，暂停的任务会显示一个"下次执行"时刻，
    // 而它永远不会发生——这正是让用户误以为"还在跑"的假象。
    for (const status of ['paused', 'failed', 'inactive', 'deleted']) {
      expect(
        nextRunAt(
          {
            status,
            triggerType: 'cron',
            cronExpression: '0 8 * * *',
            timezone: 'UTC',
          },
          NOW,
        ),
      ).toBeNull();
    }
  });

  it('手动触发：没有可预测的下次时刻 → null', () => {
    expect(nextRunAt({ status: 'active', triggerType: 'manual' }, NOW)).toBeNull();
  });

  it('cron 表达式非法/超出预览子集 → null（宁可说"无法预估"，不猜假时刻）', () => {
    expect(
      nextRunAt(
        { status: 'active', triggerType: 'cron', cronExpression: 'not a cron' },
        NOW,
      ),
    ).toBeNull();
    // 6 字段（含秒）超出 5 字段子集——详情页预览同款策略：不解析就不猜
    expect(
      nextRunAt(
        { status: 'active', triggerType: 'cron', cronExpression: '0 0 8 * * *' },
        NOW,
      ),
    ).toBeNull();
  });

  it('fixed_rate 间隔非法（0/负数/非数）→ null', () => {
    for (const rate of [0, -1, Number.NaN]) {
      expect(
        nextRunAt({ status: 'active', triggerType: 'fixed_rate', fixedRate: rate }, NOW),
      ).toBeNull();
    }
  });

  it('cron 但表达式缺失 → null（不给假时刻）', () => {
    expect(
      nextRunAt({ status: 'active', triggerType: 'cron', cronExpression: null }, NOW),
    ).toBeNull();
  });
});
