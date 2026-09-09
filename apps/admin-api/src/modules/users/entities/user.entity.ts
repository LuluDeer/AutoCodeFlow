import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { Length } from "class-validator";
import { Exclude } from "class-transformer";

export enum UserRole {
  ADMIN = "admin",
  USER = "user",
}

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  // DB-006: 显式长度约束，避免默认 varchar(255) 影响唯一索引效率
  @Column({ unique: true, length: 128 })
  @Length(3, 128)
  username: string;

  @Column({ unique: true })
  email: string;

  @Column()
  @Exclude()
  password: string;

  @Column({ type: "enum", enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Column({ default: true })
  isActive: boolean;

  // SEC-05: track consecutive login failures for account lockout
  @Column({ default: 0 })
  loginFailCount: number;

  @Column({ nullable: true, type: "timestamp" })
  lockedUntil: Date | null;

  // SEC-03: TOTP two-factor auth — Base32 secret (staged by setup before
  // enable; null when never set up). Never serialized to API responses.
  @Column({ nullable: true, type: "varchar", length: 64 })
  @Exclude()
  totpSecret: string | null;

  // SEC-03: user-level opt-in switch — false keeps the login path unchanged
  @Column({ default: false })
  totpEnabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
