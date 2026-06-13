import {
  Controller,
  Get,
  Post,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Body,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import * as https from 'https';
import * as http from 'http';
import * as FormData from 'form-data';

@UseGuards(JwtAuthGuard)
@Controller('registry')
export class RegistryController {
  private readonly logger = new Logger(RegistryController.name);

  constructor(private readonly config: ConfigService) {}

  private get pypiUrl(): string {
    return this.config.get<string>('PYPI_REGISTRY_URL') || 'http://localhost:8003';
  }

  private get pypiUser(): string {
    return this.config.get<string>('REGISTRY_USER') || 'admin';
  }

  private get pypiPass(): string {
    return this.config.get<string>('REGISTRY_PASS') || '';
  }

  private get npmUrl(): string {
    return this.config.get<string>('NPM_REGISTRY_URL') || 'http://localhost:4873';
  }

  /** Fetch a URL with optional Basic Auth; returns the response text */
  private async fetchText(url: string, auth?: { user: string; pass: string }): Promise<{ ok: boolean; status: number; text: string }> {
    return new Promise((resolve) => {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = { Accept: 'text/html,application/json' };
      if (auth) {
        const b64 = Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
        headers['Authorization'] = `Basic ${b64}`;
      }
      const req = lib.request(
        { hostname: parsedUrl.hostname, port: parsedUrl.port, path: parsedUrl.pathname + parsedUrl.search, method: 'GET', headers },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 500, text: data }));
        },
      );
      req.on('error', (e) => resolve({ ok: false, status: 500, text: e.message }));
      req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, status: 504, text: 'timeout' }); });
      req.end();
    });
  }

  /** Parse PyPI simple index HTML → list of package names */
  private parsePypiIndex(html: string): string[] {
    const matches = html.matchAll(/<a[^>]*>([^<]+)<\/a>/gi);
    const names: string[] = [];
    for (const m of matches) {
      const name = m[1].trim();
      if (name) names.push(name);
    }
    return names;
  }

  @Get('pypi/packages')
  async listPypiPackages(): Promise<{ packages: string[] }> {
    const url = `${this.pypiUrl}/simple/`;
    try {
      const resp = await this.fetchText(url, { user: this.pypiUser, pass: this.pypiPass });
      if (!resp.ok) {
        this.logger.warn(`PyPI registry returned ${resp.status}: ${resp.text.slice(0, 200)}`);
        return { packages: [] };
      }
      return { packages: this.parsePypiIndex(resp.text) };
    } catch (e: unknown) {
      this.logger.error('Failed to fetch PyPI packages', e);
      return { packages: [] };
    }
  }

  @Get('npm/packages')
  async listNpmPackages(): Promise<{ packages: Array<{ name: string; latest?: string; description?: string }> }> {
    const url = `${this.npmUrl}/-/verdaccio/packages`;
    try {
      const resp = await this.fetchText(url);
      if (!resp.ok) return { packages: [] };
      const data = JSON.parse(resp.text);
      return { packages: Array.isArray(data) ? data : [] };
    } catch (e: unknown) {
      this.logger.error('Failed to fetch npm packages', e);
      return { packages: [] };
    }
  }

  /** Allowed PyPI package extensions */
  private static readonly ALLOWED_PYPI_EXTS = ['.whl', '.tar.gz', '.zip'];

  @Post('pypi/upload')
  // Limit uploads to 50 MB; multer enforces this before the handler runs
  @UseInterceptors(FileInterceptor('content', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async uploadPypiPackage(
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
    @Body('version') version: string,
  ): Promise<{ success: boolean }> {
    if (!file || !name || !version) {
      throw new HttpException('name, version and file are required', HttpStatus.BAD_REQUEST);
    }
    // Validate file extension to reject arbitrary uploads
    const filename = file.originalname ?? '';
    const allowed = RegistryController.ALLOWED_PYPI_EXTS;
    if (!allowed.some(ext => filename.toLowerCase().endsWith(ext))) {
      throw new HttpException(
        `Unsupported file type. Allowed extensions: ${allowed.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const uploadUrl = `${this.pypiUrl}/upload/`;
    const auth = Buffer.from(`${this.pypiUser}:${this.pypiPass}`).toString('base64');
    const form = new FormData();
    form.append('name', name);
    form.append('version', version);
    form.append('content', file.buffer, { filename: file.originalname, contentType: file.mimetype });

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(uploadUrl);
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname,
          method: 'POST',
          headers: { ...form.getHeaders(), Authorization: `Basic ${auth}` },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if ((res.statusCode ?? 500) < 400) {
              resolve({ success: true });
            } else {
              reject(new HttpException(`Upload failed: ${body}`, HttpStatus.BAD_GATEWAY));
            }
          });
        },
      );
      req.on('error', (e) => reject(new HttpException(e.message, HttpStatus.BAD_GATEWAY)));
      form.pipe(req);
    });
  }
}
