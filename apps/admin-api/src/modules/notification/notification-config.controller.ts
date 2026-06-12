import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { NotificationConfigService } from "./notification-config.service";

@ApiTags("通知配置")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("notification")
export class NotificationConfigController {
  constructor(private readonly configService: NotificationConfigService) {}

  @Get("channels")
  @ApiOperation({ summary: "获取所有通知渠道配置" })
  getChannels() {
    return this.configService.getAllChannels();
  }

  @Patch("channels/:key")
  @ApiOperation({ summary: "更新通知渠道配置" })
  updateChannel(
    @Param("key") key: string,
    @Body() body: { enabled?: boolean; config?: Record<string, string> },
  ) {
    return this.configService.updateChannel(key, body);
  }

  @Post("channels/:key/test")
  @ApiOperation({ summary: "测试通知渠道" })
  testChannel(@Body() body: Record<string, string>) {
    return this.configService.testChannel(body);
  }

  @Post("test")
  @ApiOperation({ summary: "发送测试通知到指定渠道" })
  sendTest(
    @Body() body: { channels: string[]; title: string; content: string },
  ) {
    return this.configService.sendTest(body);
  }
}
