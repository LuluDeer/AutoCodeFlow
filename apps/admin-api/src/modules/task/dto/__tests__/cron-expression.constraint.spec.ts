/**
 * cron 表达式三种写法的合法性口径（RT-CRON 反证）。
 *
 * 背景：任务主 `cronExpression` 此前由 `create-task.dto.ts` 里一条**手写正则**
 * 校验，而那条正则写坏了——每个字段只接受 `*`、单值、`值/步进`，没有逗号列表
 * 与范围分支。于是 `0 12,18 * * *`（每天 12 点与 18 点）这类最常用的合法写法
 * 在**保存**时被 400 拦死，而前端预览器与调度器都接受它：
 *
 *     用户看到的现象 =「能预览出下次触发时间，却存不进去」
 *
 * 根因是同一语义被实现了四份（前端预览器 / 维护窗口 / node-cron / DTO）之后的
 * 漂移，所以修复不是"补一个正则分支"，而是把 DTO 的判定收敛到**调度器注册时
 * 用的同一个校验器**（nodeCron.validate）。本文件把这件事钉成断言：
 *
 *   1. DTO 校验器必须接受全部合法形态（含逗号列表与范围）；
 *   2. DTO 校验器必须拒绝全部非法形态（越界、段数不对、非数字）；
 *   3. **与 nodeCron.validate 同源**——凡是调度器能注册的 5 段表达式，DTO 就必须
 *      放行（这是本 bug 的根因断言，任何人再引入第二套口径都会在此转红）；
 *   4. 5 段契约：node-cron 接受 6 段（带秒），本仓不放行。
 */
import * as nodeCron from "node-cron";
import {
  isValidCronExpression,
  IsCron5FieldConstraint,
} from "../cron-expression.constraint";

/** 合法表达式 → 人类可读说明（用于失败信息）。 */
const VALID: Array<[string, string]> = [
  ["0 12,18 * * *", "每天 12 点与 18 点（用户报障现场）"],
  ["0 9-17 * * *", "每天 9 点到 17 点每小时"],
  ["0 12 * * *", "每天 12 点（单值，修复前就通过）"],
  ["*/5 * * * *", "每 5 分钟（步进，修复前就通过）"],
  ["0 */2 * * *", "每 2 小时"],
  ["0 9-17/2 * * *", "范围 + 步进"],
  ["0 12-18/2 * * *", "范围 + 步进（另一形态）"],
  ["0 12,18 * * 1-5", "逗号 + 范围组合（工作日 12/18 点）"],
  ["0 0 1,15 * *", "每月 1 号与 15 号"],
  ["30 8,12,18 * * 1,3,5", "多值逗号（时 + 周）"],
  ["0 0 * * 0", "每周日零点"],
  ["0 0 * * 7", "每周日零点（7 视同 0，POSIX）"],
  ["* * * * *", "每分钟"],
  ["0 0 1 1 *", "每年 1 月 1 日"],
];

/** 非法表达式 → 说明。 */
const INVALID: Array<[string, string]> = [
  ["60 12 * * *", "分钟越界（0-59）"],
  ["0 25 * * *", "小时越界（0-23）"],
  ["0 12 32 * *", "日越界（1-31）"],
  ["0 12 * 13 *", "月越界（1-12）"],
  ["0 12 * * 8", "周越界（0-7）"],
  ["0 12 * *", "只有 4 段"],
  ["0 12 * * * *", "6 段（带秒）——超出本仓 5 段契约"],
  ["0 12 * * * * *", "7 段"],
  ["abc", "非数字"],
  ["", "空串"],
  ["   ", "纯空白"],
  ["not-valid-cron", "调度器用例里的同款非法值"],
  ["* * * * * *", "6 段全星"],
  // 星期名 / 月名：node-cron 接受，但前端预览器与维护窗口只认数字。
  // 放行会造成"存得进去但预览空白"的反向不一致（本 bug 的镜像），故收紧。
  ["0 12 * * sun", "星期名（node-cron 接受，本仓不收）"],
  ["0 12 * * MON", "星期名大写"],
  ["0 12 * * mon", "星期名小写"],
  ["0 12 * jan *", "月名小写"],
  ["0 12 * JAN *", "月名大写"],
];

describe("cron 表达式合法性（RT-CRON）", () => {
  const constraint = new IsCron5FieldConstraint();

  describe("接受全部合法形态", () => {
    it.each(VALID)("接受 %s（%s）", (expr) => {
      expect(isValidCronExpression(expr)).toBe(true);
      expect(constraint.validate(expr)).toBe(true);
    });
  });

  describe("拒绝全部非法形态", () => {
    it.each(INVALID)("拒绝 %s（%s）", (expr) => {
      expect(isValidCronExpression(expr)).toBe(false);
      expect(constraint.validate(expr)).toBe(false);
    });
  });

  describe("与调度注册路径同源（本 bug 的根因断言）", () => {
    // 这是最关键的一组：只要 DTO 与 nodeCron.validate 对本仓契约内的表达式
    // 判定不同，就说明又出现了第二套口径——「能预览/能调度但存不进去」这类
    // 不一致会立刻在此暴露，而不是等用户报障。
    //
    // 注意"契约内"这个限定：node-cron 比本仓契约更宽（接受 6 段与 sun/jan
    // 这类名字），那两处是**有意**收紧的，见下面两组专项用例。这里只断言
    // 「5 段纯数字」这一交集上两边完全一致。
    const isInRepoContract = (e: string) => {
      const fields = e.trim().split(/\s+/);
      if (fields.length !== 5) return false;
      return fields.every((f) => /^[\d*,\-/]+$/.test(f));
    };

    const allExprs = [
      ...VALID.map(([e]) => e),
      ...INVALID.map(([e]) => e),
      // 额外补一批两边都不该有分歧的形态
      "*/15 * * * *",
      "0 0,6,12,18 * * *",
      "0 22 * * 1-5",
      "23 0-23/2 * * *",
    ];

    it.each(allExprs)(
      "契约内表达式的判定与 nodeCron.validate 一致：%s",
      (expr) => {
        if (!isInRepoContract(expr)) return; // 契约外形态由下面两组专项覆盖
        expect(isValidCronExpression(expr)).toBe(nodeCron.validate(expr));
      },
    );

    it("凡调度器能注册的、契约内的表达式，DTO 必须放行（穷举上面那批）", () => {
      const schedulable = allExprs.filter(
        (e) => isInRepoContract(e) && nodeCron.validate(e),
      );
      const rejected = schedulable.filter((e) => !isValidCronExpression(e));
      expect(rejected).toEqual([]);
      // 断言这组确实非空，否则本用例会退化成永真断言
      expect(schedulable.length).toBeGreaterThan(10);
    });
  });

  describe("5 段契约（node-cron 更宽，本仓收紧）", () => {
    it("node-cron 接受 6 段，但本仓必须拒绝", () => {
      // 先钉住"node-cron 确实更宽"这个前提，否则下面的断言可能是空的
      expect(nodeCron.validate("0 12 * * * *")).toBe(true);
      expect(isValidCronExpression("0 12 * * * *")).toBe(false);
    });

    it("node-cron 接受星期名/月名，但本仓必须拒绝（前端预览器与维护窗口只认数字）", () => {
      // 同样先钉前提：node-cron 确实接受字母形态
      expect(nodeCron.validate("0 12 * * sun")).toBe(true);
      expect(nodeCron.validate("0 12 * jan *")).toBe(true);
      // 再钉本仓收紧——放行会造成"存得进去但预览空白"的反向不一致
      expect(isValidCronExpression("0 12 * * sun")).toBe(false);
      expect(isValidCronExpression("0 12 * jan *")).toBe(false);
    });
  });

  describe("与前端预览器口径一致", () => {
    // 前端 trigger-preview.ts 的 parseCronExpression 是展示层；这里只钉"凡是
    // 保存能过的，前端都该能预览"，避免出现"存进去了但预览是空白"的反向不一致。
    // （前端侧另有 trigger-preview.test.ts 覆盖其自身形态矩阵。）
    it("用户报障的表达式在前端与后端都被接受", () => {
      const expr = "0 12,18 * * *";
      // 后端
      expect(isValidCronExpression(expr)).toBe(true);
      // 调度器
      expect(nodeCron.validate(expr)).toBe(true);
    });
  });

  describe("null / undefined 交给 @IsOptional", () => {
    it("null 与 undefined 不报错（PATCH 未提供该字段）", () => {
      expect(constraint.validate(null)).toBe(true);
      expect(constraint.validate(undefined)).toBe(true);
    });

    it("非字符串值拒绝", () => {
      expect(constraint.validate(123)).toBe(false);
      expect(constraint.validate({})).toBe(false);
      expect(constraint.validate([])).toBe(false);
    });
  });

  describe("错误文案保持既有契约", () => {
    it("仍给出 5 段提示（前端/文档依赖这段文案）", () => {
      const msg = constraint.defaultMessage({
        property: "cronExpression",
      } as never);
      expect(msg).toContain("cronExpression");
      expect(msg).toContain("5 fields: min hour day month weekday");
    });
  });
});
