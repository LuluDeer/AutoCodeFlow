import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { RefreshToken } from './entities/refresh-token.entity';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    @InjectRepository(RefreshToken)
    private refreshTokenRepo: Repository<RefreshToken>,
  ) {}

  /** Max consecutive failures before lockout. */
  private static readonly MAX_FAIL = 5;
  /** Lockout duration in minutes. */
  private static readonly LOCK_MINUTES = 15;

  async login(loginDto: LoginDto) {
    const user = await this.usersService.findByUsername(loginDto.username);

    // SEC-05: always run the full check path to avoid username-enumeration timing leaks
    const passwordOk =
      user != null && (await bcrypt.compare(loginDto.password, user.password));

    if (!user || !passwordOk) {
      // SEC-05: increment failure counter and lock if threshold reached
      if (user) {
        await this.usersService.recordLoginFailure(user.id, {
          maxFail: AuthService.MAX_FAIL,
          lockMinutes: AuthService.LOCK_MINUTES,
        });
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    // SEC-05: reject if account is currently locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      throw new UnauthorizedException(
        `Account locked. Try again in ${minutesLeft} minute(s).`,
      );
    }

    // SEC-05: successful login — reset failure counter
    await this.usersService.resetLoginFailure(user.id);
    return this.generateTokens(user);
  }

  async refreshToken(token: string) {
    let payload: JwtPayload & { type: string; jti?: string };
    try {
      // S2: verify using the dedicated refresh secret and require type='refresh'
      payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }

    // SEC-02: check the token has not been revoked
    if (payload.jti) {
      const record = await this.refreshTokenRepo.findOne({
        where: { jti: payload.jti },
      });
      if (!record || record.revoked) {
        throw new UnauthorizedException('Refresh token has been revoked');
      }
      // SEC-02: Token Rotation — immediately revoke the consumed token
      record.revoked = true;
      await this.refreshTokenRepo.save(record);
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) throw new UnauthorizedException();
    return this.generateTokens(user);
  }

  /** SEC-02: Revoke all active refresh tokens for a user (called on logout). */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.refreshTokenRepo.update(
      { userId, revoked: false },
      { revoked: true },
    );
  }

  private async generateTokens(user: { id: number; username: string }) {
    // S2: include 'type' claim and use separate secrets for access/refresh tokens
    const base: JwtPayload = { sub: user.id, username: user.username };

    // SEC-02: attach a unique jti to each refresh token for revocation tracking
    const jti = randomUUID();

    const accessToken = this.jwtService.sign(
      { ...base, type: 'access' },
      { expiresIn: this.configService.get<string>('jwt.expiresIn') },
    );

    const refreshToken = this.jwtService.sign(
      { ...base, type: 'refresh', jti },
      {
        secret: this.configService.get<string>('jwt.refreshSecret'),
        expiresIn: '30d',
      },
    );

    // SEC-02: persist the refresh token for future revocation checks
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await this.refreshTokenRepo.save(
      this.refreshTokenRepo.create({ jti, userId: user.id, expiresAt }),
    );

    return { accessToken, refreshToken };
  }

  /**
   * SEC-02: Daily cleanup of expired refresh token rows to keep the table lean.
   * Runs at 03:00 every day.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpiredTokens(): Promise<void> {
    await this.refreshTokenRepo.delete({ expiresAt: LessThan(new Date()) });
  }
}
