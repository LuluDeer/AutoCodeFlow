import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { UsersService } from "../../users/users.service";

export interface JwtPayload {
  sub: number;
  username: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("jwt.secret"),
    });
  }

  async validate(payload: JwtPayload) {
    // Reject tokens that don't carry the 'access' type marker (S2)
    if ((payload as any).type && (payload as any).type !== "access") {
      throw new UnauthorizedException("Invalid token type");
    }
    const user = await this.usersService.findById(payload.sub);
    if (!user) throw new UnauthorizedException("User not found");
    // S1: reject disabled accounts even when their JWT is still valid
    if (!user.isActive) throw new UnauthorizedException("Account is disabled");
    return user;
  }
}
