import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { EventSubscription } from "./entities/event-subscription.entity";
import { EventSubscriptionDeadLetter } from "./entities/event-subscription-dead-letter.entity";
import { EventSubscriptionService } from "./event-subscription.service";
import { OutboundEventDispatcher } from "./outbound-event-dispatcher.service";
import {
  CreateEventSubscriptionDto,
  ListDeadLettersQueryDto,
  UpdateEventSubscriptionDto,
} from "./dto/event-subscription.dto";

/**
 * FEAT-07: 出站事件订阅端点（全部走全局 JwtAuthGuard）。
 *
 *  GET    /api/event-subscriptions                          列表（ADMIN 全量 / 用户自己的 + 系统级）
 *  POST   /api/event-subscriptions                          新建订阅（url SSRF 深校验）
 *  PATCH  /api/event-subscriptions/:id                      更新（enabled/url/eventTypes/secret）
 *  DELETE /api/event-subscriptions/:id                      删除（死信级联清）
 *  GET    /api/event-subscriptions/:id/dead-letters         死信分页列表
 *  POST   /api/event-subscriptions/:id/dead-letters/:dlId/replay  手动重放（单次派发）
 *
 * secret 语义：POST 未传则服务端生成并在**本次响应**一次性回显
 * （generatedSecret 字段）；此后任何读端点都只回 "******"。
 */
class UpdateSubscriptionBody extends UpdateEventSubscriptionDto {
  @ApiPropertyOptional({ description: "Enable/disable delivery" })
  enabled?: boolean;
}

@ApiTags("Event Subscriptions")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("event-subscriptions")
export class EventSubscriptionController {
  constructor(
    private readonly svc: EventSubscriptionService,
    private readonly dispatcher: OutboundEventDispatcher,
  ) {}

  @Get()
  @ApiOperation({ summary: "List outbound event subscriptions" })
  @ApiResponse({ status: 200, description: "Subscription list", type: [EventSubscription] })
  list(@Req() req: Request & { user: AuthUser }): Promise<EventSubscription[]> {
    return this.svc.findAll(req.user);
  }

  @Post()
  @ApiOperation({
    summary: "Create an outbound event subscription",
    description:
      "URL is deep-validated against SSRF (private/loopback/link-local/metadata " +
      "targets rejected). Omit `secret` to have one generated (returned once as " +
      "`generatedSecret`).",
  })
  @ApiResponse({ status: 201, description: "Created subscription" })
  @ApiResponse({ status: 400, description: "Invalid URL / event types / quota exceeded" })
  create(
    @Body() dto: CreateEventSubscriptionDto,
    @Req() req: Request & { user: AuthUser },
  ): Promise<{ subscription: EventSubscription; generatedSecret?: string }> {
    return this.svc.create(dto, req.user);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update a subscription (enable/disable, url, eventTypes, secret rotation)",
  })
  @ApiParam({ name: "id", description: "Subscription UUID" })
  @ApiResponse({ status: 200, description: "Updated subscription", type: EventSubscription })
  @ApiResponse({ status: 403, description: "Not the owner" })
  @ApiResponse({ status: 404, description: "Subscription not found" })
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubscriptionBody,
    @Req() req: Request & { user: AuthUser },
  ): Promise<EventSubscription> {
    return this.svc.update(id, dto, req.user);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a subscription (dead letters cascade)" })
  @ApiParam({ name: "id", description: "Subscription UUID" })
  @ApiResponse({ status: 200, description: "Deleted" })
  @ApiResponse({ status: 403, description: "Not the owner" })
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: Request & { user: AuthUser },
  ): Promise<{ ok: true }> {
    await this.svc.remove(id, req.user);
    return { ok: true };
  }

  @Get(":id/dead-letters")
  @ApiOperation({
    summary: "List dead letters (deliveries that failed all retry attempts)",
  })
  @ApiParam({ name: "id", description: "Subscription UUID" })
  @ApiResponse({ status: 200, description: "Paged dead letters" })
  @ApiResponse({ status: 403, description: "Not the owner" })
  deadLetters(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: ListDeadLettersQueryDto,
    @Req() req: Request & { user: AuthUser },
  ): Promise<{ data: EventSubscriptionDeadLetter[]; total: number }> {
    return this.svc.listDeadLetters(id, req.user, q.page, q.limit);
  }

  @Post(":id/dead-letters/:dlId/replay")
  @ApiOperation({
    summary: "Replay a dead letter once with the subscription's current url/secret",
    description:
      "Single delivery attempt (no auto-retry). On success the dead letter row is " +
      "removed; on failure the error is returned and the row is kept.",
  })
  @ApiParam({ name: "id", description: "Subscription UUID" })
  @ApiParam({ name: "dlId", description: "Dead letter UUID" })
  @ApiResponse({ status: 200, description: "Replayed (ok true/false with error)" })
  @ApiResponse({ status: 403, description: "Not the owner" })
  @ApiResponse({ status: 404, description: "Subscription or dead letter not found" })
  async replay(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("dlId", ParseUUIDPipe) dlId: string,
    @Req() req: Request & { user: AuthUser },
  ): Promise<{ ok: boolean; error?: string }> {
    const { subscription, deadLetter } = await this.svc.getDeadLetterForReplay(
      id,
      dlId,
      req.user,
    );
    const result = await this.dispatcher.replayDeadLetter(subscription, deadLetter);
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error };
  }
}
