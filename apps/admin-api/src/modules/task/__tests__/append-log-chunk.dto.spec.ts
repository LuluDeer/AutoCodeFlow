import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  AppendLogChunkDto,
  LOG_LINE_MAX_LENGTH,
} from "../dto/append-log-chunk.dto";

/**
 * F-4（回调/推送面审计）：RT-LOG 实时日志片的单行长度上限。
 *
 * 背景：DTO 此前只有 @ArrayMaxSize(2000) 约束行数，单行长度无上限——与
 * CallbackItemDto.logs 的 512KB cap（execution-callback.dto.ts，同属执行器
 * 回调面）不对称，无界单行可在落库/SSE 广播前顶着 body parser 上限（55mb）
 * 常驻内存。本组用例把补齐的单行上限钉住。
 *
 * 上限取 512_000 而非 64KB 的原因见 dto 文件头注：执行器两侧 LogStreamPusher
 * 按进程 stdout 原始行推送、不做单行截断，超长单行是合法输入；且 400 拒绝
 * 的是**整片**（同片其余行一并丢实时视图），上限必须给足。
 */
const base = { fromLine: 0, lines: ["hello", "world"] };

async function errorsFor(payload: Record<string, unknown>) {
  const dto = plainToInstance(AppendLogChunkDto, payload);
  return validate(dto, { forbidUnknownValues: false });
}

describe("AppendLogChunkDto（RT-LOG 单行长度上限）", () => {
  it(`LOG_LINE_MAX_LENGTH = ${512_000}，与 CallbackItemDto.logs 的 512KB cap 同量级`, () => {
    expect(LOG_LINE_MAX_LENGTH).toBe(512_000);
  });

  it("正常日志片合法", async () => {
    expect(await errorsFor(base)).toEqual([]);
  });

  it("恰在上限内的单行合法（不误伤正常执行器流量）", async () => {
    const errs = await errorsFor({ ...base, lines: ["x".repeat(512_000)] });
    expect(errs).toEqual([]);
  });

  it("超长单行被拒绝（整片 400，ValidationPipe 拒绝路径）", async () => {
    const errs = await errorsFor({
      ...base,
      lines: ["x".repeat(LOG_LINE_MAX_LENGTH + 1)],
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.property === "lines")).toBe(true);
  });

  it("混入一行超长即整片拒绝（调用方必须自行截行）", async () => {
    const errs = await errorsFor({
      ...base,
      lines: ["ok-1", "x".repeat(LOG_LINE_MAX_LENGTH + 100), "ok-2"],
    });
    expect(errs.length).toBeGreaterThan(0);
  });

  it("既有行数上限（ArrayMaxSize 2000）不被放宽", async () => {
    const errs = await errorsFor({
      ...base,
      lines: Array.from({ length: 2001 }, (_, i) => `line-${i}`),
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(await errorsFor({ ...base, lines: [""] })).toEqual([]);
  });
});
