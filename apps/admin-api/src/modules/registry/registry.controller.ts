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
  Req,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import * as https from "https";
import * as http from "http";
// form-data is a CJS `export =` module and this project compiles without
// esModuleInterop — the default-import form emits `.default` access that is
// undefined at runtime ("form_data_1.default is not a constructor"). Use the
// namespace import (same pattern as `import * as Joi` in app.module.ts).
import * as FormData from "form-data";
import { Request } from "express";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { AuditService } from "../audit/audit.service";

@UseGuards(JwtAuthGuard)
@Controller("registry")
export class RegistryController {
  private readonly logger = new Logger(RegistryController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private get pypiUrl(): string {
    return (
      this.config.get<string>("PYPI_REGISTRY_URL") || "http://localhost:8003"
    );
  }

  private get pypiUser(): string {
    return this.config.get<string>("REGISTRY_USER") || "admin";
  }

  private get pypiPass(): string {
    return this.config.get<string>("REGISTRY_PASS") || "";
  }

  private get npmUrl(): string {
    // R-12（DEEP_REVIEW 0ef3bbe）: 改读映射节 registry.npm.url（此前裸读
    // config.get("NPM_REGISTRY_URL") 绕过配置中心；其下注释曾失实声称该 URL
    // 已在 Joi 注册，实际仅注册了 TOKEN/USER/PASS）。默认值由 configuration.ts
    // 回退 http://localhost:4873，与旧回退逐字节一致。
    return (
      this.config.get<string>("registry.npm.url") || "http://localhost:4873"
    );
  }

  // S5: optional Verdaccio service account (configuration.ts: registry.npm,
  // registered as NPM_REGISTRY_TOKEN/USER/PASS in the Joi schema; R-12 起
  // NPM_REGISTRY_URL 亦补注册并映射到 registry.npm.url). When configured, the
  // proxy authenticates before pulling the package list; when unset the previous
  // anonymous behavior is kept.
  private get npmUser(): string {
    return (
      this.config.get<string>("registry.npm.user") ||
      this.config.get<string>("NPM_REGISTRY_USER") ||
      ""
    );
  }

  private get npmPass(): string {
    return (
      this.config.get<string>("registry.npm.pass") ||
      this.config.get<string>("NPM_REGISTRY_PASS") ||
      ""
    );
  }

  private get npmToken(): string {
    return (
      this.config.get<string>("registry.npm.token") ||
      this.config.get<string>("NPM_REGISTRY_TOKEN") ||
      ""
    );
  }

  // S4: the upload proxy caps files at 50MB (FileInterceptor limit), so its
  // timeout must be far more generous than fetchText's 8s small-GET budget.
  // Overridable via REGISTRY_UPLOAD_TIMEOUT_MS (tests / slow links).
  private get uploadTimeoutMs(): number {
    const parsed = parseInt(
      this.config.get<string>("REGISTRY_UPLOAD_TIMEOUT_MS") ?? "",
      10,
    );
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
  }

  /** Fetch a URL with optional Basic Auth; returns the response text */
  private async fetchText(
    url: string,
    auth?: { user: string; pass: string },
    opts?: {
      method?: "GET" | "PUT" | "POST";
      body?: string;
      headers?: Record<string, string>;
    },
  ): Promise<{ ok: boolean; status: number; text: string }> {
    return new Promise((resolve) => {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === "https:" ? https : http;
      const headers: Record<string, string> = {
        Accept: "text/html,application/json",
      };
      if (auth) {
        const b64 = Buffer.from(`${auth.user}:${auth.pass}`).toString("base64");
        headers["Authorization"] = `Basic ${b64}`;
      }
      if (opts?.headers) Object.assign(headers, opts.headers);
      if (opts?.body !== undefined) {
        headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      }
      const req = lib.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: opts?.method ?? "GET",
          headers,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({
              ok: (res.statusCode ?? 500) < 400,
              status: res.statusCode ?? 500,
              text: data,
            }),
          );
        },
      );
      req.on("error", (e) =>
        resolve({ ok: false, status: 500, text: e.message }),
      );
      req.setTimeout(8000, () => {
        req.destroy();
        resolve({ ok: false, status: 504, text: "timeout" });
      });
      if (opts?.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  /**
   * S5: registry-npm (Verdaccio) requires authentication for EVERY package
   * pattern (`access: $authenticated` in apps/registry-npm/config.yaml), so
   * the anonymous GET /-/verdaccio/packages is answered 401 and the admin npm
   * package list would always be empty. When a service account is configured,
   * exchange it for a bearer token first (PUT /-/user/login), or use a
   * pre-issued NPM_REGISTRY_TOKEN directly. Without credentials the previous
   * anonymous behavior is kept (401 → empty list); the cause is logged at
   * debug level so misconfiguration is discoverable.
   */
  private async resolveNpmAuthHeader(): Promise<string | undefined> {
    const token = this.npmToken;
    if (token) return `Bearer ${token}`;

    const user = this.npmUser;
    const pass = this.npmPass;
    if (!user || !pass) {
      this.logger.debug(
        "NPM registry credentials are not configured (NPM_REGISTRY_TOKEN or NPM_REGISTRY_USER/NPM_REGISTRY_PASS); " +
          "the authenticated-only registry will answer 401 and the package list stays empty",
      );
      return undefined;
    }

    const loginResp = await this.fetchText(
      `${this.npmUrl}/-/user/login`,
      undefined,
      {
        method: "PUT",
        // Both key spellings are accepted so either Verdaccio's /-/user/login
        // handler or the npm couch-user handler understands the payload.
        body: JSON.stringify({ name: user, username: user, password: pass }),
      },
    );
    if (!loginResp.ok) {
      this.logger.warn(
        `NPM registry login failed with ${loginResp.status}: ${loginResp.text.slice(0, 200)}`,
      );
      return undefined;
    }
    let parsed: { token?: string } | null = null;
    try {
      parsed = JSON.parse(loginResp.text) as { token?: string };
    } catch {
      parsed = null;
    }
    if (!parsed?.token) {
      this.logger.warn(
        "NPM registry login response did not contain a token; listing packages anonymously",
      );
      return undefined;
    }
    return `Bearer ${parsed.token}`;
  }

  /** Parse PyPI simple index HTML → list of package names */
  private parsePypiIndex(html: string): string[] {
    // Use [\s\S]*? (non-greedy, dotall-equivalent) so attributes that span
    // multiple lines in the <a> tag are still matched correctly.
    const matches = html.matchAll(/<a[\s\S]*?>([^<]+)<\/a>/gi);
    const names: string[] = [];
    for (const m of matches) {
      const name = m[1].trim();
      if (name) names.push(name);
    }
    return names;
  }

  @Get("pypi/packages")
  async listPypiPackages(): Promise<{ packages: string[] }> {
    const url = `${this.pypiUrl}/simple/`;
    try {
      const resp = await this.fetchText(url, {
        user: this.pypiUser,
        pass: this.pypiPass,
      });
      if (!resp.ok) {
        this.logger.warn(
          `PyPI registry returned ${resp.status}: ${resp.text.slice(0, 200)}`,
        );
        return { packages: [] };
      }
      return { packages: this.parsePypiIndex(resp.text) };
    } catch (e: unknown) {
      this.logger.error("Failed to fetch PyPI packages", e);
      return { packages: [] };
    }
  }

  @Get("npm/packages")
  async listNpmPackages(): Promise<{
    packages: Array<{ name: string; latest?: string; description?: string }>;
  }> {
    const url = `${this.npmUrl}/-/verdaccio/packages`;
    try {
      // S5: authenticate first when a service account is configured — the
      // registry requires $authenticated access for every package pattern.
      const authHeader = await this.resolveNpmAuthHeader();
      const resp = await this.fetchText(
        url,
        undefined,
        authHeader ? { headers: { Authorization: authHeader } } : undefined,
      );
      if (!resp.ok) {
        this.logger.warn(
          `npm registry returned ${resp.status}: ${resp.text.slice(0, 200)}`,
        );
        return { packages: [] };
      }
      const data = JSON.parse(resp.text);
      return { packages: Array.isArray(data) ? data : [] };
    } catch (e: unknown) {
      this.logger.error("Failed to fetch npm packages", e);
      return { packages: [] };
    }
  }

  /** Allowed PyPI package extensions */
  private static readonly ALLOWED_PYPI_EXTS = [".whl", ".tar.gz", ".zip"];

  /** A7（DEEP_REVIEW §七「registry 面收敛」）：包名/版本的字符级白名单。
   *  这两个值会原样转发给上游私有 PyPI（pypiserver 用它拼存储路径），上游的
   *  健壮性不该是我们唯一的防线——名字里混进 `/` `..` 或 shell 元字符属于
   *  「把自己的输入卫生甩给下游」的老问题。取 PEP 508 名称与 PEP 440 版本的
   *  **保守子集**（够用且不含任何路径/元字符）。 */
  private static readonly PYPI_NAME_RE =
    /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
  private static readonly PYPI_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

  /**
   * A7：上传面收敛到 **ADMIN**。
   *
   * 此前本端点是 `scope: "authenticated"`——**任意已登录用户都能往私有 PyPI
   * 传包**，而任务的 `requirements` 正是从这个私服 `uv pip install`。也就是说
   * 任何账号都能抢注/覆盖一个内部包名，让下游所有引用它的任务装到攻击者的
   * 代码——这是评审点名的「任务依赖投毒面」（A2 审计再次确认并如实登记）。
   *
   * 上传内部依赖包是**全局写操作**（影响所有任务），属管理员/运维职责，不是
   * 普通用户的自助功能。按 A2 的规则，有 `@Roles` 就不再需要 `@WriteGuard`
   * （两者不得共存），故原声明移除。
   *
   * **未**同时引入专用 upload token：那需要先确认是否存在 CI/流水线上传的
   * 真实场景（谁签发、谁轮换是运维决策），凭空加一种凭据类型只会扩大攻击面。
   * 已登记为残差。
   */
  @Roles(UserRole.ADMIN)
  @Post("pypi/upload")
  // Limit uploads to 50 MB; multer enforces this before the handler runs
  @UseInterceptors(
    FileInterceptor("content", { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  async uploadPypiPackage(
    @UploadedFile() file: Express.Multer.File,
    @Body("name") name: string,
    @Body("version") version: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<{ success: boolean }> {
    if (!file || !name || !version) {
      throw new HttpException(
        "name, version and file are required",
        HttpStatus.BAD_REQUEST,
      );
    }
    // A7: 字符级白名单（见 PYPI_NAME_RE / PYPI_VERSION_RE 注释）
    if (name.length > 128 || !RegistryController.PYPI_NAME_RE.test(name)) {
      throw new HttpException(
        "Invalid package name: must match PEP 508 (letters, digits, . _ -)",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      version.length > 64 ||
      !RegistryController.PYPI_VERSION_RE.test(version)
    ) {
      throw new HttpException(
        "Invalid version: must match PEP 440 (letters, digits, . _ + -)",
        HttpStatus.BAD_REQUEST,
      );
    }
    // Validate file extension to reject arbitrary uploads
    const filename = file.originalname ?? "";
    const allowed = RegistryController.ALLOWED_PYPI_EXTS;
    if (!allowed.some((ext) => filename.toLowerCase().endsWith(ext))) {
      throw new HttpException(
        `Unsupported file type. Allowed extensions: ${allowed.join(", ")}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const uploadUrl = `${this.pypiUrl}/upload/`;
    const auth = Buffer.from(`${this.pypiUser}:${this.pypiPass}`).toString(
      "base64",
    );
    const form = new FormData();
    form.append("name", name);
    form.append("version", version);
    form.append("content", file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });

    // S4: the POST proxy previously had no timeout at all — a hung registry
    // would pin the request (and its connection) indefinitely. Mirror the
    // fetchText style with a socket timeout plus an overall deadline, widened
    // to 60s for large uploads (fetchText's small-GET budget is 8s).
    const timeoutMs = this.uploadTimeoutMs;
    const uploadPromise = new Promise<{ success: boolean }>(
      (resolve, reject) => {
        let settled = false;
        const done = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          fn();
        };
        // Overall deadline covers the entire request lifecycle (connect +
        // send + response) — the socket timeout alone can be starved by a
        // trickle response that keeps resetting it.
        const deadline = setTimeout(() => {
          req.destroy();
          done(() =>
            reject(
              new HttpException(
                "Upstream registry upload timed out",
                HttpStatus.GATEWAY_TIMEOUT,
              ),
            ),
          );
        }, timeoutMs);
        const parsedUrl = new URL(uploadUrl);
        const lib = parsedUrl.protocol === "https:" ? https : http;
        const req = lib.request(
          {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname,
            method: "POST",
            headers: { ...form.getHeaders(), Authorization: `Basic ${auth}` },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => {
              done(() => {
                if ((res.statusCode ?? 500) < 400) {
                  resolve({ success: true });
                } else {
                  reject(
                    new HttpException(
                      `Upload failed: ${body}`,
                      HttpStatus.BAD_GATEWAY,
                    ),
                  );
                }
              });
            });
          },
        );
        // Socket-level inactivity timeout — a stalled connection is destroyed
        // and surfaces through the overall deadline handling above.
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          done(() =>
            reject(
              new HttpException(
                "Upstream registry upload timed out",
                HttpStatus.GATEWAY_TIMEOUT,
              ),
            ),
          );
        });
        req.on("error", (e) =>
          done(() =>
            reject(new HttpException(e.message, HttpStatus.BAD_GATEWAY)),
          ),
        );
        // Safety net: a connection that closes without a response (and without
        // an 'error' event) must not leave the caller's promise pending forever.
        req.on("close", () =>
          done(() =>
            reject(
              new HttpException(
                "Upstream registry closed the connection before responding",
                HttpStatus.BAD_GATEWAY,
              ),
            ),
          ),
        );
        form.pipe(req);
      },
    );

    // A7：投毒面必须可追溯——成功与失败都落一条审计（谁、传了哪个包的哪个版本）。
    // 审计写入失败**不**阻断上传（DB 抖动不该让运维传不了包），但必须 error 级
    // 留痕：静默吞掉等于审计形同虚设。
    return uploadPromise
      .then((ok) => {
        void this.recordUploadAudit({
          user,
          name,
          version,
          filename,
          size: file.size,
          ip: req.ip,
          result: "success",
        });
        return ok;
      })
      .catch((err: unknown) => {
        void this.recordUploadAudit({
          user,
          name,
          version,
          filename,
          size: file.size,
          ip: req.ip,
          result: "failure",
          detail: {
            error: err instanceof Error ? err.message : String(err),
          },
        });
        throw err;
      });
  }

  /**
   * A7：上传审计。写失败只记 error 日志，不向上抛（见调用点注释）。
   */
  private async recordUploadAudit(params: {
    user?: AuthUser;
    name: string;
    version: string;
    filename: string;
    size: number;
    ip?: string;
    result: "success" | "failure";
    detail?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.audit.log({
        userId: params.user?.id,
        username: params.user?.username,
        action: "registry.pypi.upload",
        resource: "registry-package",
        resourceId: `${params.name}==${params.version}`,
        ip: params.ip,
        result: params.result,
        detail: {
          filename: params.filename,
          size: params.size,
          ...params.detail,
        },
      });
    } catch (e: unknown) {
      this.logger.error(
        `Failed to write audit log for registry upload ${params.name}==${params.version} — 投毒面失去可追溯性，请立即检查 audit_logs 写入`,
        e instanceof Error ? e.stack : String(e),
      );
    }
  }
}
