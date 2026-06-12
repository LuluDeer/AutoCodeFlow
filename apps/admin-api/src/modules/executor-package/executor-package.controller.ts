import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  Res,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { Request, Response } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ExecutorPackageService } from "./executor-package.service";
import {
  CreateExecutorPackageDto,
  UpdateExecutorPackageDto,
  QueryExecutorPackageDto,
} from "./dto/executor-package.dto";
import { ExecutorPackage } from "./executor-package.entity";

@ApiTags("执行器包管理")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("executor-packages")
export class ExecutorPackageController {
  constructor(private readonly svc: ExecutorPackageService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    }),
  )
  @ApiOperation({ summary: "上传执行器包" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    description: "执行器包文件及元信息",
    schema: {
      type: "object",
      required: ["name", "version", "file"],
      properties: {
        name: { type: "string", example: "python-runner" },
        version: { type: "string", example: "1.0.0" },
        type: { type: "string", example: "python" },
        platform: { type: "string", example: "linux" },
        description: { type: "string" },
        file: { type: "string", format: "binary" },
      },
    },
  })
  @ApiResponse({ status: 201, description: "创建成功" })
  create(
    @Body() createDto: CreateExecutorPackageDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ): Promise<ExecutorPackage> {
    const uploadedBy = (req as any).user?.username;
    return this.svc.create(createDto, file, uploadedBy);
  }

  @Get()
  @ApiOperation({ summary: "获取执行器包列表" })
  @ApiResponse({ status: 200, description: "包列表" })
  findAll(
    @Query() query: QueryExecutorPackageDto,
  ): Promise<{ items: ExecutorPackage[]; total: number }> {
    return this.svc.findAll(query);
  }

  @Get("latest")
  @ApiOperation({ summary: "获取指定类型下最新的 ACTIVE 执行器包" })
  @ApiQuery({ name: "type", required: true, description: "执行器包类型" })
  @ApiQuery({ name: "platform", required: false, description: "平台（可选）" })
  @ApiResponse({ status: 200, description: "最新包信息" })
  findLatest(
    @Query("type") type: string,
    @Query("platform") platform?: string,
  ): Promise<ExecutorPackage | null> {
    return this.svc.findLatest(type, platform);
  }

  @Get(":id")
  @ApiOperation({ summary: "获取执行器包详情" })
  @ApiParam({ name: "id", description: "包ID" })
  @ApiResponse({ status: 200, description: "包详情" })
  @ApiResponse({ status: 404, description: "包不存在" })
  findOne(@Param("id", ParseUUIDPipe) id: string): Promise<ExecutorPackage> {
    return this.svc.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "更新执行器包信息" })
  @ApiParam({ name: "id", description: "包ID" })
  @ApiResponse({ status: 200, description: "更新成功" })
  @ApiResponse({ status: 404, description: "包不存在" })
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateExecutorPackageDto,
  ): Promise<ExecutorPackage> {
    return this.svc.update(id, updateDto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "删除执行器包" })
  @ApiParam({ name: "id", description: "包ID" })
  @ApiResponse({ status: 204, description: "删除成功" })
  @ApiResponse({ status: 404, description: "包不存在" })
  remove(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.svc.remove(id);
  }

  @Get(":id/download")
  @ApiOperation({ summary: "下载执行器包文件" })
  @ApiParam({ name: "id", description: "包ID" })
  @ApiResponse({ status: 200, description: "文件内容" })
  @ApiResponse({ status: 404, description: "包或文件不存在" })
  async download(
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, pkg } = await this.svc.getFileBuffer(id);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${pkg.originalFilename ?? pkg.filename ?? `${pkg.name}-${pkg.version}`}"`,
    );
    res.setHeader("Content-Type", pkg.mimeType ?? "application/octet-stream");
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
  }

  @Patch(":id/deprecate")
  @ApiOperation({ summary: "弃用执行器包" })
  @ApiParam({ name: "id", description: "包ID" })
  @ApiResponse({ status: 200, description: "已弃用" })
  deprecate(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ExecutorPackage> {
    return this.svc.deprecate(id);
  }

  @Patch(":id/activate")
  @ApiOperation({ summary: "激活执行器包" })
  @ApiParam({ name: "id", description: "包ID" })
  @ApiResponse({ status: 200, description: "已激活" })
  activate(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ExecutorPackage> {
    return this.svc.activate(id);
  }
}
