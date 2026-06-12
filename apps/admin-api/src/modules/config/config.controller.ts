import {
  Controller,
  Get,
  Put,
  Delete,
  Post,
  Param,
  Body,
  UseGuards,
  Req,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Request } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { SystemConfigService, UpsertConfig } from "./config.service";
import { UpsertConfigDto } from "./dto/upsert-config.dto";
import { PaginationDto } from "../../common/dto/pagination.dto";

@ApiTags("系统配置")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("config")
export class ConfigController {
  constructor(private readonly configService: SystemConfigService) {}

  @Get()
  @ApiOperation({ summary: "获取所有配置项" })
  async findAll(@Query("prefix") prefix?: string, @Query("tag") tag?: string) {
    let configs: any[];
    if (prefix) {
      configs = await this.configService.getByPrefix(prefix);
    } else if (tag) {
      configs = await this.configService.getByTag(tag);
    } else {
      configs = await this.configService.findAll();
    }
    return configs.map((c) => (c.isSecret ? { ...c, value: "***" } : c));
  }

  @Get(":key")
  @ApiOperation({ summary: "获取单个配置项" })
  async findOne(@Param("key") key: string) {
    const c = await this.configService.findOne(key);
    return c.isSecret ? { ...c, value: "***" } : c;
  }

  @Put()
  @ApiOperation({ summary: "新增或更新配置项" })
  async upsert(
    @Body() dto: UpsertConfigDto,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    return this.configService.upsert(dto, {
      userId: user?.id,
      username: user?.username,
      ipAddress: req.ip,
    });
  }

  @Post("batch")
  @ApiOperation({ summary: "批量新增或更新配置项" })
  async batchUpsert(
    @Body() items: UpsertConfig[],
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    return this.configService.batchUpsert(items, {
      userId: user?.id,
      username: user?.username,
      ipAddress: req.ip,
    });
  }

  @Delete(":key")
  @ApiOperation({ summary: "删除配置项" })
  async remove(
    @Param("key") key: string,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    return this.configService.remove(key, {
      userId: user?.id,
      username: user?.username,
      ipAddress: req.ip,
    });
  }

  @Get("history")
  @ApiOperation({ summary: "获取配置历史记录" })
  async getHistory(
    @Query("key") key?: string,
    @Query() pagination?: PaginationDto,
  ) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.pageSize ?? 20;
    return this.configService.getHistory(key, page, limit);
  }

  @Get("history/:key")
  @ApiOperation({ summary: "获取指定配置项的历史记录" })
  async getHistoryByKey(
    @Param("key") key: string,
    @Query() pagination?: PaginationDto,
  ) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.pageSize ?? 20;
    return this.configService.getHistory(key, page, limit);
  }

  @Post("history/:id/rollback")
  @ApiOperation({ summary: "回滚到历史版本" })
  async rollback(
    @Param("id") id: number,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    return this.configService.rollback(id, {
      userId: user?.id,
      username: user?.username,
      ipAddress: req.ip,
    });
  }
}
