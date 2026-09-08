import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * AUTH-03: scope levels for limited API Keys.
 *
 * - `readonly`: all GET endpoints.
 * - `trigger`: readonly + POST task trigger endpoints (CI/CD dispatch).
 * - `manage`: every non-excluded write endpoint.
 *
 * Hard exclusions (never reachable with an API Key, any scope):
 * /api-keys management endpoints are JWT-only — a leaked key must never be
 * able to mint/replace credentials for itself.
 */
export type ApiKeyScope = "readonly" | "trigger" | "manage";

/**
 * AUTH-03: persistent API Key record.
 *
 * Security invariants:
 * - `keyHash` = sha256(plaintext). Plaintext is shown ONCE in the create
 *   response and never stored or returned afterwards.
 * - `keyPrefix` = first 8 chars of the plaintext (display/identification
 *   only — not enough to reconstruct the key: `acf_` + 4 hex chars).
 * - Revocation is a soft-delete (`revokedAt` set) so audit trails survive.
 */
@Entity("api_keys")
@Index("idx_api_keys_user_id", ["userId"])
@Index("idx_api_keys_key_hash", ["keyHash"], { unique: true })
export class ApiKey {
  @PrimaryGeneratedColumn()
  id: number;

  /** Owning user (creator) — API Keys can only be managed by their owner via JWT. */
  @Column({ type: "integer" })
  userId: number;

  /** Human label, e.g. "ci-deploy". */
  @Column({ type: "varchar", length: 100 })
  name: string;

  /** First 8 chars of the plaintext key — display/identification only. */
  @Column({ type: "varchar", length: 16 })
  keyPrefix: string;

  /** sha256 hex of the full plaintext key. Lookup + uniqueness constraint. */
  @Column({ type: "varchar", length: 64 })
  keyHash: string;

  /** Permission tier: readonly | trigger | manage. */
  @Column({ type: "varchar", length: 16, default: "readonly" })
  scope: ApiKeyScope;

  /** Optional expiry — expired keys authenticate as 401. */
  @Column({ type: "timestamptz", nullable: true })
  expiresAt: Date | null;

  /** Soft-revoke timestamp — set => key rejected immediately. */
  @Column({ type: "timestamptz", nullable: true })
  revokedAt: Date | null;

  /** Last successful authentication; throttled update (≤1 write/min per key). */
  @Column({ type: "timestamptz", nullable: true })
  lastUsedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
