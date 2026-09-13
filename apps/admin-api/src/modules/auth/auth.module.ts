import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { UsersModule } from "../users/users.module";
import { AuditModule } from "../audit/audit.module";
import { RefreshToken } from "./entities/refresh-token.entity";
import { User } from "../users/entities/user.entity";
import { OidcService } from "./oidc.service";
import { OidcController } from "./oidc.controller";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>("jwt.secret"),
        signOptions: {
          expiresIn: configService.get<string>("jwt.expiresIn") as any,
        },
      }),
      inject: [ConfigService],
    }),
    UsersModule,
    AuditModule,
    // SEC-02: register RefreshToken entity for persistence
    // AUTH-04: User entity for OidcService identity resolution/provisioning
    TypeOrmModule.forFeature([RefreshToken, User]),
  ],
  controllers: [AuthController, OidcController],
  providers: [AuthService, JwtStrategy, OidcService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
