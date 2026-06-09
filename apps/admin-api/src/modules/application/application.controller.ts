import {
  Controller, Get, Post, Put, Delete, Body, Param, UseGuards, UseInterceptors,
  UploadedFile, Res, StreamableFile, Logger, BadRequestException, Query, Headers,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApplicationService } from './application.service';
import { CreateApplicationDto, UpdateApplicationDto } from './dto/application.dto';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

@ApiTags('应用管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('applications')
export class ApplicationController {
  constructor(private readonly svc: ApplicationService) {}

  @Get()
  @ApiOperation({ summary: '获取应用列表' })
  findAll() {
    return this.svc.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: '获取应用详情' })
  findById(@Param('id') id: string) {
    return this.svc.findById(id);
  }

  @Post()
  @ApiOperation({ summary: '创建应用' })
  create(@Body() dto: CreateApplicationDto) {
    return this.svc.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: '更新应用' })
  update(@Param('id') id: string, @Body() dto: UpdateApplicationDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除应用' })
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post('upload')
  @ApiOperation({ summary: '上传应用包（zip）' })
  @ApiConsumes('multipart/form-data')
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
    @Body('runtime') runtime: string,
  ) {
    if (!file) throw new Error('No file uploaded');
    if (!name) throw new Error('Application name is required');

    // Save uploaded zip to temp directory
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocodeflow-upload-'));
    const zipPath = path.join(tmpDir, file.originalname || 'app.zip');
    fs.writeFileSync(zipPath, file.buffer);

    // Create application record
    const app = await this.svc.create({
      name,
      version: '1.0.0',
      runtime: runtime || 'node',
    });

    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}

    return app;
  }

  @Post('webhook')
  @ApiOperation({ summary: 'Git webhook for auto-deployment' })
  async webhook(
    @Body() payload: any,
    @Headers('x-github-event') githubEvent?: string,
    @Headers('x-gitlab-event') gitlabEvent?: string,
    @Headers('x-gitee-event') giteeEvent?: string,
  ) {
    const logger = new Logger('GitWebhook');
    let branch: string | undefined;
    let commit: string | undefined;
    let repoUrl: string | undefined;

    // Parse webhook payload from different Git providers
    if (githubEvent === 'push' && payload?.ref) {
      // GitHub push webhook
      branch = payload.ref.replace('refs/heads/', '');
      commit = payload.after || payload.head_commit?.id;
      repoUrl = payload.repository?.clone_url || payload.repository?.ssh_url;
      logger.log(`GitHub webhook: ${repoUrl}@${branch} → ${commit?.slice(0, 8)}`);
    } else if (gitlabEvent === 'Push Hook') {
      // GitLab push webhook
      branch = (payload?.ref || '').replace('refs/heads/', '');
      commit = payload?.checkout_sha || payload?.after;
      repoUrl = payload?.repository?.git_http_url || payload?.repository?.git_ssh_url;
      logger.log(`GitLab webhook: ${repoUrl}@${branch} → ${commit?.slice(0, 8)}`);
    } else if (giteeEvent === 'Push Hook') {
      // Gitee push webhook
      branch = (payload?.ref || '').replace('refs/heads/', '');
      commit = payload?.after || payload?.head_commit?.id;
      repoUrl = payload?.repository?.git_http_url || payload?.repository?.ssh_url;
      logger.log(`Gitee webhook: ${repoUrl}@${branch} → ${commit?.slice(0, 8)}`);
    } else {
      throw new BadRequestException(`Unsupported webhook event: ${githubEvent || gitlabEvent || giteeEvent || 'unknown'}`);
    }

    if (!repoUrl || !branch) {
      throw new BadRequestException('Missing repo URL or branch in webhook payload');
    }

    // Find the application by gitRepo
    const apps = await this.svc.findAll();
    const normalized = (url: string) => url.toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
    const targetApp = apps.find(a => {
      if (!a.gitRepo) return false;
      return normalized(a.gitRepo) === normalized(repoUrl!) && a.gitBranch === branch;
    });

    if (!targetApp) {
      logger.warn(`No matching application found for ${repoUrl}@${branch}`);
      return { ok: true, message: 'No matching application' };
    }

    // Update gitCommit and trigger re-deployment
    await this.svc.deployFromGit(targetApp.id, targetApp.gitRepo!, branch, commit);
    return { ok: true, applicationId: targetApp.id, branch, commit };
  }

  @Post(':id/sync-tasks')
  @ApiOperation({ summary: '从 manifest.json 同步任务注册', description: '解析应用的 manifest.json 并自动注册其中的任务定义' })
  async syncTasks(@Param('id') id: string) {
    const count = await this.svc.syncTasksFromManifest(id);
    return { ok: true, registeredCount: count };
  }
}