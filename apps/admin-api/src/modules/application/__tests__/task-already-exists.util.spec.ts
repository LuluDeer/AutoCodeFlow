/**
 * LANG-ERR-01（D 项）：任务「已存在」判据——**按码优先、文本兜底**。
 *
 * 这一组守的是一个真实踩过的**静默**故障形态：判据按文案分类，而文案是可翻译的。
 * 中文化改造把「已存在」类消息从英文改成中文后，只留英文支的匹配随即失效，
 * 于是「正常跳过」被误报成 error 级故障——无编译错误、无测试失败，只有日志级别
 * 悄悄变了。
 *
 * 故本文件分两组断言：
 *   ① 行为：码命中即跳过、非码路径走中英文本兜底、**真故障不得被误判为跳过**；
 *   ② 自检：`catalog` 里所有「占用」语义的码都必须登记在判据表内——新增码忘了
 *      登记不会报错，只会退回文本兜底（又一次静默降级），故必须由测试拦住。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../../../common/errors/app-error";
import {
  TASK_ALREADY_EXISTS_CODES,
  isTaskAlreadyExistsError,
} from "../task-already-exists.util";

describe("LANG-ERR-01 · 任务「已存在」判据", () => {
  describe("① 按稳定码（首选路径，与语言无关）", () => {
    it.each([...TASK_ALREADY_EXISTS_CODES])("%s 判为已存在", (code) => {
      expect(isTaskAlreadyExistsError(new AppError(code as never))).toBe(true);
    });

    it("AppError 的码命中时不依赖文案（换成任意语言都成立）", () => {
      // 同一个码，params 不同 → 渲染出的 message 不同，但判定必须一致
      const a = new AppError("TASK_NAME_EXISTS", { name: "甲" });
      const b = new AppError("TASK_NAME_EXISTS", { name: "乙" });
      expect(a.message).not.toBe(b.message);
      expect(isTaskAlreadyExistsError(a)).toBe(true);
      expect(isTaskAlreadyExistsError(b)).toBe(true);
    });
  });

  describe("② 文本兜底（仅非 AppError 路径：旧副本 / 底层库）", () => {
    it("英文文案（滚动升级期旧副本、已落库历史值）", () => {
      expect(
        isTaskAlreadyExistsError(new Error("Task name already exists")),
      ).toBe(true);
    });

    it("中文文案（中文化之后的直接文本抛出）", () => {
      expect(isTaskAlreadyExistsError(new Error("任务名已存在"))).toBe(true);
    });

    it("非 Error 值也能判定（String() 兜底，不抛）", () => {
      expect(isTaskAlreadyExistsError("任务已存在")).toBe(true);
      expect(isTaskAlreadyExistsError(undefined)).toBe(false);
      expect(isTaskAlreadyExistsError(null)).toBe(false);
    });
  });

  describe("③ 真故障**不得**被判为跳过（首版的假阴性）", () => {
    it("「版本不存在」不判为已存在（首版 includes 宽松匹配会误伤）", () => {
      expect(
        isTaskAlreadyExistsError(new Error("Version v3 does not exist")),
      ).toBe(false);
    });

    it("回滚目标被占用码**属于**已存在族（语义上确为占用）", () => {
      // 这一条刻意断言 true：TASK_ROLLBACK_NAME_TAKEN 的语义就是「名字被占」，
      // 对"本次注册要不要当正常跳过"而言与普通重名同解（见 util 头注）。
      expect(
        isTaskAlreadyExistsError(new AppError("TASK_ROLLBACK_NAME_TAKEN")),
      ).toBe(true);
    });

    it("其它 AppError 码一律不判为已存在", () => {
      expect(isTaskAlreadyExistsError(new AppError("TASK_NOT_FOUND"))).toBe(
        false,
      );
      expect(
        isTaskAlreadyExistsError(
          new AppError("VALIDATION_FAILED", { detail: "x" }),
        ),
      ).toBe(false);
    });

    it("正文里含「已存在」但码不同的 AppError → 以**码**为准（不误判）", () => {
      // 构造一个码不在族内、但 message 恰好含「已存在」的情形。
      // 按码判定的价值正在于此：不被文案带偏。
      const err = new AppError("TASK_VERSION_ID_NOT_FOUND", {
        // params 只影响渲染，不影响码
      });
      // 该码不在族内 → false，哪怕我们把 message 改写成含「已存在」
      Object.defineProperty(err, "message", {
        value: "依赖值必须是已存在的任务 ID",
      });
      expect(isTaskAlreadyExistsError(err)).toBe(false);
    });
  });

  describe("④ 自检：新增「任务占用」类码必须登记（防静默退回文本兜底）", () => {
    it("task 分片里名字含 EXISTS/TAKEN 的**任务**码都在判据表内", () => {
      const src = readFileSync(
        join(__dirname, "../../../common/errors/catalog/task.ts"),
        "utf8",
      );
      const codes: string[] = [];
      for (const m of src.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*\{/gm)) {
        if (/(EXISTS|TAKEN)/.test(m[1])) codes.push(m[1]);
      }
      // 反永真：确实扫到了码（否则解析坏了，本用例会永远通过）
      expect(codes.length).toBeGreaterThan(0);
      const unregistered = codes.filter(
        (c) => !TASK_ALREADY_EXISTS_CODES.includes(c),
      );
      expect(unregistered).toEqual([]);
    });

    it("判据表里的码**都真实存在**（防拼错码名）", () => {
      const src = readFileSync(
        join(__dirname, "../../../common/errors/catalog/task.ts"),
        "utf8",
      );
      const declared = new Set(
        [...src.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*\{/gm)].map((m) => m[1]),
      );
      const missing = TASK_ALREADY_EXISTS_CODES.filter((c) => !declared.has(c));
      expect(missing).toEqual([]);
    });
  });
});
