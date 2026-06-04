import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async login(loginDto: LoginDto) {
    const user = await this.usersService.findByUsername(loginDto.username);
    if (!user || !(await bcrypt.compare(loginDto.password, user.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.generateTokens(user);
  }

  async refreshToken(token: string) {
    try {
      // S2: verify using the dedicated refresh secret and require type='refresh'
      const payload = this.jwtService.verify<JwtPayload & { type: string }>(token, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });
      if (payload.type !== 'refresh') throw new UnauthorizedException('Invalid token type');
      const user = await this.usersService.findById(payload.sub);
      if (!user) throw new UnauthorizedException();
      if (!user.isActive) throw new UnauthorizedException('Account is disabled');
      return this.generateTokens(user);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private generateTokens(user: { id: number; username: string }) {
    // S2: include 'type' claim and use separate secrets for access/refresh tokens
    const base: JwtPayload = { sub: user.id, username: user.username };
    return {
      accessToken: this.jwtService.sign(
        { ...base, type: 'access' },
        { expiresIn: this.configService.get<string>('jwt.expiresIn') },
      ),
      refreshToken: this.jwtService.sign(
        { ...base, type: 'refresh' },
        {
          secret: this.configService.get<string>('jwt.refreshSecret'),
          expiresIn: '30d',
        },
      ),
    };
  }
}
