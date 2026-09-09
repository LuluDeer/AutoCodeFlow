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
