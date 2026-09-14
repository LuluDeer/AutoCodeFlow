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
  // PK-10（DEEP_REVIEW 0ef3bbe）: 迁移 1789900000002 把本表改造为按日分区
  // （PARTITION BY RANGE (createdAt)），PG 分区表要求唯一约束含分区键——DB 实际
  // PK 为联合 (id, createdAt)。此前实体只声明 @PrimaryGeneratedColumn() id 单列，
  // migration:generate 会误以为 PK 是单列而翻转语义。此处用 @CreateDateColumn({
  // primary: true }) 同时钉住"联合 PK 含 createdAt"与"插入时应用侧自动写时间"
  // （TypeORM ColumnMetadata 对 createDate 模式列仍读取 options.primary，二者可叠加）。
  @PrimaryGeneratedColumn() id: number;
  @Column() executionId: string;
  @Column({ type: "int" }) lineNumber: number;
  @Column({ type: "text" }) content: string;
  // OBS-03: 写入时由 log-level.util.ts 的 levelOfLine(content) 推断的级别
  // （ERROR/WARN/INFO/DEBUG）。可空：null = 存量行或文本推断不到的未知
  // 级别；level 过滤查询不返回 NULL 行（语义 = 未知级别，见 api-reference）。
  @Column({ type: "varchar", length: 8, nullable: true })
  level: string | null;
  // DB-002: 写入时间，LogRetentionCleanupService 按保留期（LOG_RETENTION_DAYS，默认 30 天）清理过期行。
  // 同时是联合主键的分区键列（见上方 PK-10 注释）。
  @CreateDateColumn({ primary: true }) createdAt: Date;
}
