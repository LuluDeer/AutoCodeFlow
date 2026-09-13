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

  // WIKI-AUTH-REVOC: 用户级会话版本——logout（revokeAllForUser）与改密
  // （users.service.update 携带 password 时）原子 +1；access token 签发时把
  // 该值快照进 ver claim，jwt.strategy.validate() 比对不一致即 401
  // （"Session has been revoked"），实现注销/改密后在途访问令牌即时失效。
  // 存量旧行经迁移 1790000000017 取 0；无 ver claim 的旧令牌兼容放行。
  @Column({ default: 0 })
  sessionVersion: number;

  // AUTH-04: OIDC IdP 的稳定身份标识（sub 声明）。可空：本地密码登录用户
  // 恒为 NULL；首次 SSO 登录按 username 匹配成功后写入绑定。唯一部分索引
  // （WHERE NOT NULL）保证一个 sub 至多绑定一个账号。
  @Column({ nullable: true, type: "varchar", length: 255 })
  @Exclude()
  oidcSub: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
