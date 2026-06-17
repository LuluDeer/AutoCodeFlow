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

@ApiTags("Notification Config")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("notification")
export class NotificationConfigController {
  constructor(private readonly configService: NotificationConfigService) {}

  @Get("channels")
  @ApiOperation({ summary: "Get all notification channel configs" })
  getChannels() {
    return this.configService.getAllChannels();
  }

  @Patch("channels/:key")
  @ApiOperation({ summary: "Update notification channel config" })
  updateChannel(
    @Param("key") key: string,
    @Body() body: { enabled?: boolean; config?: Record<string, string> },
  ) {
    return this.configService.updateChannel(key, body);
  }

  @Post("channels/:key/test")
  @ApiOperation({ summary: "Test notification channel" })
  testChannel(@Body() body: Record<string, string>) {
    return this.configService.testChannel(body);
  }

  @Post("test")
  @ApiOperation({ summary: "Send test notification to channel" })
  sendTest(
    @Body() body: { channels: string[]; title: string; content: string },
  ) {
    return this.configService.sendTest(body);
  }
}
