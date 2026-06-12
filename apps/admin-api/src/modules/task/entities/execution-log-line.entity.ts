import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

@Entity("execution_log_lines")
@Index(["executionId", "lineNumber"])
export class ExecutionLogLine {
  @PrimaryGeneratedColumn() id: number;
  @Column() executionId: string;
  @Column({ type: "int" }) lineNumber: number;
  @Column({ type: "text" }) content: string;
}
