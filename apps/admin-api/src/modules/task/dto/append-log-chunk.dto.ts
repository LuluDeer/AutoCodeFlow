import {
  IsArray,
  IsInt,
  IsString,
  Min,
  ArrayMaxSize,
  MaxLength,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/**
 * RT-LOG 实时日志片（POST /executions/:id/logs）。
 *
 * F-4（回调/推送面审计）：此前只有 @ArrayMaxSize(2000) 约束行数，单行长度
 * 无上限——与 CallbackItemDto.logs 的 512KB cap（execution-callback.dto.ts，
 * 两者同属执行器回调面）相比存在不对称：无界的单行让单个请求可以顶着 body
 * parser 上限（executions 面 55mb）把超长字符串在落库/SSE 广播前常驻内存。
 * 补齐单行上限以对称约束。
 *
 * 上限取 512_000（与 CallbackItemDto.logs 同量级）而非更小的 64KB：执行器
 * 两侧的 LogStreamPusher 按进程 stdout/stderr 原始行推送、**不做单行截断**
 * （executor-node/src/log-stream-pusher.ts addOutput / executor-python
 * log_stream_pusher.py add_output），任务输出一条超长单行（如 base64 /
 * 压缩 JSON dump）是合法输入；且 400 会拒绝**整片**（同片其余 99 行一并
 * 丢失实时视图）——对齐回调日志 512KB 的既有量级，既封住滥用面，又不给
 * 正常执行器流量新增 400 拒绝。
 */
export const LOG_LINE_MAX_LENGTH = 512_000;

export class AppendLogChunkDto {
  @ApiProperty({
    description: "0-based line number offset of the first line in this chunk",
    example: 0,
  })
  @IsInt()
  @Min(0)
  fromLine: number;

  @ApiProperty({
    description: "Array of log line strings (max 2000 lines, 512 KB per line)",
    example: ["Starting task...", "Step 1 complete"],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(2000)
  @MaxLength(LOG_LINE_MAX_LENGTH, { each: true })
  lines: string[];
}
