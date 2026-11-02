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

  /**
   * SEC-03: TOTP 两因子的**明文 Base32 种子**（setup 时先 staging，enable 后生效；
   * 从未配置过则 null）。
   *
   * ## 为什么本列必须 `select: false`（2026-11-02 补，凭据防线的第 1 条腿）
   *
   * 本仓凭据防线是**三条彼此独立的腿**（逐字见 `packages/mcp-server/src/redact.ts:8-10`）：
   * ① 实体列 `select: false` ② 响应 DTO 显式排除 ③ 掩码函数。
   * 本列此前只有 ②（`@Exclude()`）。**但 `@Exclude()` 只在「经过 class-transformer
   * 序列化」的路径上生效**——任何直接返回实体、内部调用、导出、日志、MCP 面都绕过它。
   *
   * 而 TOTP 种子是**第二因子的根**：拿到它就能**无限生成有效验证码** ⇒ **2FA 完全绕过**。
   * 这比 `password`（bcrypt 哈希，不可逆）严重得多 ⇒ 两者都缺 `select: false`，
   * 但**先修本列**。
   *
   * ## 需要明文的路径必须显式 `addSelect`
   *
   * 只有三处真正需要明文（全部在 `AuthService`）：
   *   · `login()`（判断「启用了且种子在」）
   *   · `totpLogin()`（`totpVerify` 校验验证码）
   *   · `totpEnable()` 之前的校验路径（`totpVerify`）
   * ⇒ 它们用 `UsersService.findByIdWithTotp` / `findByUsernameWithTotp`（专用方法，
   *   **只有这两条窄路径会带出明文**）。
   * ⚠ `totpSetup` / `totpDisable` 只看 `totpEnabled`（布尔）⇒ **不需要明文**，用普通 `findById`。
   *
   * 漏一处的后果：`totpVerify(undefined, ...)` ⇒ 登录 2FA **恒失败**（不是绕过，是拒绝服务）。
   */
  @Column({ nullable: true, type: "varchar", length: 64, select: false })
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

  // NETOPT-5⑤: TOTP 重放防护——最近一次成功通过 totpVerifyLogin 的 counter。
  // 可空：无 TOTP 用户恒 NULL；存量 TOTP 用户首次登录时自然占位。校验侧条件
  // UPDATE（NULL 或 < 本次命中才放行并写入，见 UsersService.consumeTotpCounter），
  // 同一 6 位码在 ±1 步窗口内的第二次通过被拒绝（重放/并发占位）。
  // 迁移 1790000000031。
  @Column({ type: "int", nullable: true })
  lastTotpCounter: number | null;

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
