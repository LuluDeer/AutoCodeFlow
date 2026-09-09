/**
 * OBS-03: levelOfLine 形态矩阵。
 *
 * 覆盖任务要求的形态族：前缀括号（大小写）、无括号（大小写）、时间戳前缀
 * 后括号/无括号、非级别词、空行、多空格，以及归一化与误报防护边界。
 */
import { levelOfLine, LOG_LEVEL_VALUES } from "../log-level.util";

describe("levelOfLine（OBS-03 形态矩阵）", () => {
  it("值域恒为四值常量", () => {
    expect(LOG_LEVEL_VALUES).toEqual(["ERROR", "WARN", "INFO", "DEBUG"]);
  });

  // ---- 前缀括号形态（大小写不敏感）----
  it.each([
    ["[ERROR] boom", "ERROR"],
    ["[error] boom", "ERROR"],
    ["[Error] boom", "ERROR"],
    ["[WARN] careful", "WARN"],
    ["[info] starting", "INFO"],
    ["[DEBUG] detail", "DEBUG"],
  ])("括号前缀 %j → %s", (line, expected) => {
    expect(levelOfLine(line)).toBe(expected);
  });

  // ---- 无括号形态（大小写不敏感，冒号/空白收尾）----
  it.each([
    ["ERROR: boom", "ERROR"],
    ["error: boom", "ERROR"],
    ["ERROR:boom", "ERROR"],
    ["INFO something", "INFO"],
    ["info starting", "INFO"],
    ["debug detail", "DEBUG"],
  ])("无括号前缀 %j → %s", (line, expected) => {
    expect(levelOfLine(line)).toBe(expected);
  });

  // ---- WARNING 归一化 ----
  it.each([
    ["WARNING: careful", "WARN"],
    ["[warning] careful", "WARN"],
  ])("WARNING 归一化 %j → %s", (line, expected) => {
    expect(levelOfLine(line)).toBe(expected);
  });

  // ---- 时间戳前缀后括号 / 无括号 ----
  it.each([
    ["2024-01-01 12:00:00 [WARN] careful", "WARN"],
    ["2024-01-01T12:00:00.123Z ERROR boom", "ERROR"],
    ["2024-05-01 08:00:00,123 [INFO] ok", "INFO"],
    ["2024/05/01 08:00:00 [ERROR] bad", "ERROR"],
    ["[2024-05-01 08:00:00] [INFO] ok", "INFO"],
    ["2024-01-01 12:00:00+08:00 [DEBUG] tz", "DEBUG"],
    ["12:00:00 INFO time-only", "INFO"],
    ["12:00:00,123 [ERROR] comma-millis", "ERROR"],
  ])("时间戳前缀 %j → %s", (line, expected) => {
    expect(levelOfLine(line)).toBe(expected);
  });

  // ---- 多空格与行首空白 ----
  it.each([
    ["   [debug]   spaced   ", "DEBUG"],
    ["  ERROR:  indented", "ERROR"],
    ["2024-01-01 12:00:00    [INFO]  many-spaces", "INFO"],
  ])("多空格/缩进 %j → %s", (line, expected) => {
    expect(levelOfLine(line)).toBe(expected);
  });

  // ---- 非级别词 / 误报防护 → null ----
  it.each([
    ["no level here"],
    ["the error was handled"], // 级别词在行中间
    ["ERRORS: 3"], // 级别词的更长单词
    ["WARNINGS: 2"],
    ["information overload"], // INFO 前缀误报防护
    ["debugger attached"], // DEBUG 前缀误报防护
    ["err: shorthand not supported"], // 值域外级别缩写
    ["FATAL: out of domain"], // 值域外级别不强行折叠
    ["Sep  6 12:00:00 host [WARN] syslog"], // syslog 月名前缀有歧义（可匹配普通英文句），不识别
    ["2024-01-01 12:00:00 plain message"], // 只有时间戳没有级别
    ["2024-01-01 12:00:00"], // 纯时间戳行
  ])("推断不到 %j → null", (line) => {
    expect(levelOfLine(line)).toBeNull();
  });

  // ---- 空行 / 边界输入 ----
  it.each([
    [""],
    ["   "],
    ["\t"],
    [null as unknown as string],
    [undefined as unknown as string],
  ])("空/空白/非字符串 %j → null", (line) => {
    expect(levelOfLine(line)).toBeNull();
  });
});
