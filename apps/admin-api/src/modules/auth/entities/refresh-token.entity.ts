import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * SEC-02: Persistent refresh token record for revocation support.
 * Each issued refresh token is stored here; logout / rotation marks it revoked.
 */
@Entity('refresh_tokens')
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

  @CreateDateColumn()
  createdAt: Date;
}
