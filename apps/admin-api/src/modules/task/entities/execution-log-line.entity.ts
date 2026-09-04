import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from "typeorm";

@Entity("execution_log_lines")
@Index(["executionId", "lineNumber"])
// DB-002: 写入时间索引，支撑保留期分批 DELETE 的范围扫描
@Index(["createdAt"])
export class ExecutionLogLine {
  @PrimaryGeneratedColumn() id: number;
  @Column() executionId: string;
  @Column({ type: "int" }) lineNumber: number;
  @Column({ type: "text" }) content: string;
  // DB-002: 写入时间，LogRetentionCleanupService 按保留期（LOG_RETENTION_DAYS，默认 30 天）清理过期行
  @CreateDateColumn() createdAt: Date;
}
