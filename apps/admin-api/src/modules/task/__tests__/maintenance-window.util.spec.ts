/**
 * FEAT-06: maintenance-window.util.ts 纯逻辑回归。
 * 全部用固定时刻断言（now 作入参注入），不依赖真实时钟。
 */
import {
  findActiveMaintenanceWindow,
  lastWindowCronFireBefore,
  MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
  TaskMaintenanceWindows,
} from "../maintenance-window.util";

// 统一用本地时区的固定日期构造（util 按服务端本地时间评估）
const at = (iso: string) => new Date(iso);

describe("lastWindowCronFireBefore（cron 最近触达扫描）", () => {
  it("命中精确分钟", () => {
    const fire = lastWindowCronFireBefore(
      "30 2 * * *",
      at("2026-06-15T02:30:00"),
    );
    expect(fire).toEqual(at("2026-06-15T02:30:00"));
  });

  it("从当前分钟向下回扫（当前分钟未命中时找到上一次触达）", () => {
    const fire = lastWindowCronFireBefore(
      "30 2 * * *",
      at("2026-06-15T03:10:00"),
    );
    expect(fire).toEqual(at("2026-06-15T02:30:00"));
  });

  it("支持步进 */15", () => {
    const fire = lastWindowCronFireBefore(
      "*/15 * * * *",
      at("2026-06-15T04:07:00"),
    );
    expect(fire).toEqual(at("2026-06-15T04:00:00"));
  });

  it("支持范围与步进组合 30-45/5", () => {
    const fire = lastWindowCronFireBefore(
      "30-45/5 2 * * *",
      at("2026-06-15T02:38:00"),
    );
    expect(fire).toEqual(at("2026-06-15T02:35:00"));
  });

  it("weekday 0 与 7 等价（周日）", () => {
    // 2026-06-14 是周日
    const fire0 = lastWindowCronFireBefore(
      "0 8 * * 0",
      at("2026-06-14T09:00:00"),
    );
    const fire7 = lastWindowCronFireBefore(
      "0 8 * * 7",
      at("2026-06-14T09:00:00"),
    );
    expect(fire0).toEqual(at("2026-06-14T08:00:00"));
    expect(fire7).toEqual(at("2026-06-14T08:00:00"));
  });

  it("dom 与 dow 同时受限按 POSIX OR 语义", () => {
    // 2026-06-15 是周一（dow=1），dom=15
    const fire = lastWindowCronFireBefore(
      "0 6 1 * 1",
      at("2026-06-15T07:00:00"),
    );
    // dom=1 与 dow=1 均受限 → OR：6 月 15 日（周一）命中
    expect(fire).toEqual(at("2026-06-15T06:00:00"));
  });

  it("月字段过滤（8 月 cron 在 6 月不命中 → null）", () => {
    const fire = lastWindowCronFireBefore(
      "0 3 * 8 *",
      at("2026-06-15T10:00:00"),
    );
    expect(fire).toBeNull();
  });

  it("非法表达式返回 null（node-cron.validate 拒绝口径）", () => {
    expect(
      lastWindowCronFireBefore("61 * * * *", at("2026-06-15T10:00:00")),
    ).toBeNull();
    expect(
      lastWindowCronFireBefore("not a cron", at("2026-06-15T10:00:00")),
    ).toBeNull();
    expect(
      lastWindowCronFireBefore("* * * *", at("2026-06-15T10:00:00")),
    ).toBeNull();
  });

  it("回看上限兜底：周期超过 LOOKBACK 的 cron 视为未触达", () => {
    // 2 月 30 日不存在；即使存在也远超 7 天回看
    const fire = lastWindowCronFireBefore(
      "0 3 30 2 *",
      at("2026-06-15T10:00:00"),
      MAINTENANCE_WINDOW_LOOKBACK_MINUTES,
    );
    expect(fire).toBeNull();
  });
});

describe("findActiveMaintenanceWindow（窗口命中判定）", () => {
  const daily = (start: string, end: string): TaskMaintenanceWindows => [
    { start, end, description: "发布冻结" },
  ];

  it("start 触达后、end 触达前 → 命中", () => {
    const w = daily("30 2 * * *", "0 4 * * *");
    expect(findActiveMaintenanceWindow(w, at("2026-06-15T02:30:00"))).toEqual(
      w[0],
    );
    expect(findActiveMaintenanceWindow(w, at("2026-06-15T03:59:00"))).toEqual(
      w[0],
    );
  });

  it("恰在 end 触达分钟 → 已关窗（半开区间）", () => {
    const w = daily("30 2 * * *", "0 4 * * *");
    expect(
      findActiveMaintenanceWindow(w, at("2026-06-15T04:00:00")),
    ).toBeNull();
  });

  it("start 触达前（含前一天关窗后）→ 未命中", () => {
    const w = daily("30 2 * * *", "0 4 * * *");
    expect(
      findActiveMaintenanceWindow(w, at("2026-06-15T01:00:00")),
    ).toBeNull();
    expect(
      findActiveMaintenanceWindow(w, at("2026-06-15T05:00:00")),
    ).toBeNull();
  });

  it("未配置（null / [] / 非数组）→ 未命中", () => {
    const now = at("2026-06-15T03:00:00");
    expect(findActiveMaintenanceWindow(null, now)).toBeNull();
    expect(findActiveMaintenanceWindow([], now)).toBeNull();
    expect(findActiveMaintenanceWindow(undefined as never, now)).toBeNull();
  });

  it("条目字段非法（防御）→ 跳过该条不抛错", () => {
    const now = at("2026-06-15T03:00:00");
    expect(
      findActiveMaintenanceWindow(
        [{ start: "bad", end: "0 4 * * *" }] as never,
        now,
      ),
    ).toBeNull();
    expect(
      findActiveMaintenanceWindow(
        [null, { start: "30 2 * * *", end: "0 4 * * *" }] as never,
        now,
      ),
    ).toEqual({ start: "30 2 * * *", end: "0 4 * * *" });
  });

  it("多窗口并集：任一命中即返回该条（短路）", () => {
    const windows: TaskMaintenanceWindows = [
      { start: "0 5 * * *", end: "0 6 * * *" }, // 未开
      { start: "30 2 * * *", end: "0 4 * * *" }, // 开启中
    ];
    expect(
      findActiveMaintenanceWindow(windows, at("2026-06-15T03:00:00")),
    ).toEqual(windows[1]);
  });

  it("跨午夜窗口按最近触达自然成立（start 23:30 / end 次日 01:00）", () => {
    const w = daily("30 23 * * *", "0 1 * * *");
    // 当日 23:59：start=23:30 今日，end=01:00 昨日 → 开
    expect(findActiveMaintenanceWindow(w, at("2026-06-15T23:59:00"))).toEqual(
      w[0],
    );
    // 次日 00:30：仍开（start 昨日 23:30 > end 昨日 01:00）
    expect(findActiveMaintenanceWindow(w, at("2026-06-16T00:30:00"))).toEqual(
      w[0],
    );
    // 次日 01:00 关窗
    expect(
      findActiveMaintenanceWindow(w, at("2026-06-16T01:00:00")),
    ).toBeNull();
  });

  it("start/end 写反（文档提示）：退化为长窗口而非报错", () => {
    // start 04:00 / end 02:00：04:00 开 → 次日 02:00 关（22h 长窗口）
    const w = daily("0 4 * * *", "0 2 * * *");
    expect(findActiveMaintenanceWindow(w, at("2026-06-15T05:00:00"))).toEqual(
      w[0],
    );
    expect(
      findActiveMaintenanceWindow(w, at("2026-06-16T02:00:00")),
    ).toBeNull();
  });

  it("start 与 end 同 cron：平局按关窗处理（零长度窗口）", () => {
    const w = daily("0 3 * * *", "0 3 * * *");
    expect(
      findActiveMaintenanceWindow(w, at("2026-06-15T03:00:00")),
    ).toBeNull();
    expect(
      findActiveMaintenanceWindow(w, at("2026-06-15T04:00:00")),
    ).toBeNull();
  });

  it("周级窗口：周一 03:00-04:00 仅周一命中", () => {
    const w = daily("0 3 * * 1", "0 4 * * *");
    // 2026-06-15 周一
    expect(findActiveMaintenanceWindow(w, at("2026-06-15T03:30:00"))).toEqual(
      w[0],
    );
    // 2026-06-16 周二同刻：end（周二 04:00 前最后一次=周一 04:00）已关
    expect(
      findActiveMaintenanceWindow(w, at("2026-06-16T03:30:00")),
    ).toBeNull();
  });
});
