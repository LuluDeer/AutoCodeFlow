import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * SEC-02: Persistent refresh token record for revocation support.
 * Each issued refresh token is stored here; logout / rotation marks it revoked.
 */
// PK-16: 会话列表按 userId 查、过期清理按 expiresAt DELETE 的查询面索引
// （迁移 1790000000022 建，两处注记与迁移索引名同步）
@Index("idx_refresh_tokens_user_id", ["userId"])
@Index("idx_refresh_tokens_expires_at", ["expiresAt"])
@Entity("refresh_tokens")
export class RefreshToken {
  @PrimaryGeneratedColumn()
  id: number;

  /** JWT ID claim — matches the `jti` field in the signed JWT. */
  @Index({ unique: true })
  @Column({ unique: true })
  jti: string;

  @Column()
  userId: number;

  @Column({ default: false })
  revoked: boolean;

  /** Mirror of the JWT `exp` claim — used for periodic cleanup. */
  @Column()
  expiresAt: Date;

  // SEC-03: session-management display metadata, captured at issuance time
  /** Client User-Agent at issuance (truncated to 256 chars) — may be null. */
  @Column({ nullable: true, type: "varchar", length: 256 })
  userAgent: string | null;

  /** Client IP at issuance — may be null. */
  @Column({ nullable: true, type: "varchar", length: 64 })
  ip: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
