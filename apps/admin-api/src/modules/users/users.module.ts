import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { User } from "./entities/user.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { AuditModule } from "../audit/audit.module";

// R-14: RefreshToken 仅以实体仓储形式注入 UsersService（删除用户时回收令牌行），
// 不引入 AuthModule 服务 —— 避免 AuthModule↔UsersModule 的循环依赖。
@Module({
  imports: [TypeOrmModule.forFeature([User, RefreshToken]), AuditModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
