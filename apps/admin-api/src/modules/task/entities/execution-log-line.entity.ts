import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from "typeorm";

@Entity("execution_log_lines")
@Index(["executionId", "lineNumber"])
// OBS-03: 级别检索索引。读取形态固定为 executionId 等值 +（可选）level 等值
// + ORDER BY lineNumber 分页——三列复合使 level 过滤查询无需排序节点即可
// 按行序扫描，同时可作 (executionId, level) 前缀的计数扫描。未过滤路径
// 继续走既有的 (executionId, lineNumber) 索引，互不影响。
@Index(["executionId", "level", "lineNumber"])
// DB-002: 写入时间索引，支撑保留期分批 DELETE 的范围扫描
@Index(["createdAt"])
export class ExecutionLogLine {
  @PrimaryGeneratedColumn() id: number;
  @Column() executionId: string;
  @Column({ type: "int" }) lineNumber: number;
  @Column({ type: "text" }) content: string;
  // OBS-03: 写入时由 log-level.util.ts 的 levelOfLine(content) 推断的级别
  // （ERROR/WARN/INFO/DEBUG）。可空：null = 存量行或文本推断不到的未知
  // 级别；level 过滤查询不返回 NULL 行（语义 = 未知级别，见 api-reference）。
  @Column({ type: "varchar", length: 8, nullable: true })
  level: string | null;
  // DB-002: 写入时间，LogRetentionCleanupService 按保留期（LOG_RETENTION_DAYS，默认 30 天）清理过期行
  @CreateDateColumn() createdAt: Date;
}
