import {
  Controller, Get, Post, Body, Patch, Param,
  Delete, ParseIntPipe, Query, UseGuards, Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';

@ApiTags('用户')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @ApiOperation({ summary: '创建用户' })
  async create(@Body() dto: CreateUserDto, @CurrentUser() user: any, @Req() req: Request) {
    const result = await this.usersService.create(dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'user.create',
      resource: 'user',
      resourceId: String(result.id),
      ip: req.ip,
    });
    return result;
  }

  @Get()
  @ApiOperation({ summary: '获取用户列表' })
  findAll(@Query() pagination: PaginationDto) {
    return this.usersService.findAll(pagination);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取用户详情' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新用户' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const result = await this.usersService.update(id, dto);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'user.update',
      resource: 'user',
      resourceId: String(id),
      ip: req.ip,
    });
    return result;
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除用户' })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const result = await this.usersService.remove(id);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: 'user.delete',
      resource: 'user',
      resourceId: String(id),
      ip: req.ip,
    });
    return result;
  }
}
