import {
  Controller,
  Get,
  Post,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Body,
  Logger,
  HttpStatus,
  Req,
} from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import * as https from "https";
import * as http from "http";
// form-data is a CJS `export =` module and this project compiles without
// esModuleInterop — the default-import form emits `.default` access that is
// undefined at runtime ("form_data_1.default is not a constructor"). Use the
// namespace import (same pattern as `import * as Joi` in app.module.ts).
import FormData from "form-data";
import { Request } from "express";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
import { AuditService } from "../audit/audit.service";
import { ApiOkResponse, ApiCreatedResponse } from "@nestjs/swagger";
import {
  RegistryPackagesResponseDto,
  RegistryNpmPackagesResponseDto,
  RegistryUploadResponseDto,
} from "../executor-package/dto/executor-package-response.dto";

@UseGuards(JwtAuthGuard)
@Controller("registry")
export class RegistryController {
  private readonly logger = new Logger(RegistryController.name);

  /**
   * P3-6（2026-10-25 审计）：fetchText 响应体字节上限。fetchText 的两个调用方
   * （listPypiPackages 的 simple 索引 HTML、listNpmPackages 的 Verdaccio 包
   * 数组 JSON）都是「读进内存字符串再解析」——上游异常（或被劫持/代理错配）
   * 时响应体可无限累积。1MB 对私有仓索引（每包名一条锚点/记录）有 2-3 个
   * 数量级余量；超出即中止连接，按 throwUpstreamListFailure 的既有失败形态
   * 透出（413 非 504 → REGISTRY_UPSTREAM_FAILED 502，detail 带上限事实）。
   */
  private static readonly FETCH_MAX_BYTES = 1024 * 1024;

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private get pypiUrl(): string {
    // 2026-10-23（真机缺陷）：此前裸读 `PYPI_REGISTRY_URL`，而 compose 的
    // admin-api 服务块从未注入该键 → 容器内恒回落 `localhost:8003`（指向
    // 容器自身）→「包注册中心」的 PyPI 列表在所有 Docker 部署下必然 502，
    // 而单测因为显式注入 env 一直是绿的。
    //
    // 现改读映射节 `registry.pypi.url`（configuration.ts 收口，含
    // `ADMIN_PYPI_REGISTRY_URL` 优先 + 从 `PYPI_REGISTRY_URL` 剥 `/simple`
    // 派生的语义消歧）。保留裸键回退，兼容未注册该节的极简装配（spec）。
    return (
      this.config.get<string>("registry.pypi.url") ||
      this.config.get<string>("PYPI_REGISTRY_URL") ||
      "http://localhost:8003"
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
    // 2026-10-23（真机缺陷）：Verdaccio 的 `packages.'**'.access = $authenticated`，
    // 匿名拉 `/-/verdaccio/data/packages` 回的是 **200 + `[]`**（按权限过滤后
    // 空数组），不是 401——于是「凭据没配」表现为「仓库里一个包都没有」，
    // 比报错更难查。compose 只注入了 `REGISTRY_USER/PASS`（PyPI 那套），
    // NPM_REGISTRY_* 默认空 → 列表恒空。
    // 故补一条回落：NPM 专用凭据未配置时用 `REGISTRY_USER/PASS`——两者本来
    // 就指向同一套私有仓服务账号（compose 里两个 registry 由同一组键驱动），
    // 分开配置只是为了「公网 npm + 私有 PyPI」这种混合场景。
    return (
      this.config.get<string>("registry.npm.user") ||
      this.config.get<string>("NPM_REGISTRY_USER") ||
      this.config.get<string>("REGISTRY_USER") ||
      ""
    );
  }

  private get npmPass(): string {
    return (
      this.config.get<string>("registry.npm.pass") ||
      this.config.get<string>("NPM_REGISTRY_PASS") ||
      this.config.get<string>("REGISTRY_PASS") ||
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
          // P3-6：响应体字节闸——超出即中止连接并按合成 413 resolve（两个
          // 调用方把它当非 2xx 走 throwUpstreamListFailure → 502）。
          let bytes = 0;
          res.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > RegistryController.FETCH_MAX_BYTES) {
              req.destroy();
              resolve({
                ok: false,
                status: HttpStatus.PAYLOAD_TOO_LARGE,
                text: `upstream response body exceeded ${RegistryController.FETCH_MAX_BYTES} bytes`,
              });
              return;
            }
            data += chunk;
          });
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
   * anonymous behavior is kept (401 → 502，见 B-3)；the cause is logged at
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
          "the authenticated-only registry will answer 401 and the package list fails with 502 (B-3)",
      );
      return undefined;
    }

    // 2026-10-23（真机缺陷）：**不再走 PUT /-/user/login 换 token**。
    // 那个端点在 Verdaccio 5 上是「注册或登录」语义：用户已存在时回
    // 409 `username is already registered`，而 performNpmLogin 把非 2xx
    // 一律当失败 → 只要服务账号建过一次，npm 列表就永远 502。
    // （首轮实测日志：`NPM registry login failed with 409`。）
    //
    // 正确形态：Verdaccio 的 `/-/verdaccio/data/packages` 与 `/` 元数据面
    // **直接接受 Basic Auth**（实测 200），根本不需要 token 往返。故这里
    // 直接返回 Basic 头——少一次网络往返、少一个缓存、少一个失败模式。
    // NPM_REGISTRY_TOKEN（预签发 Bearer）仍然优先，公网 npm 场景不受影响。
    const b64 = Buffer.from(`${user}:${pass}`).toString("base64");
    return `Basic ${b64}`;
  }

  // 2026-10-23：B-11 的「登录换 token + 5 分钟缓存 + 并发单飞」整块删除。
  //
  // 它解决的是一个**不存在的问题**：`/-/verdaccio/data/packages` 本来就接受
  // Basic Auth（实测 200），不需要 token 往返。而它引入了一个**真实缺陷**：
  // Verdaccio 5 的 `PUT /-/user/login` 是「注册或登录」语义，账号已存在时回
  // 409 `username is already registered`，被 `!loginResp.ok` 判成失败 →
  // 只要服务账号建过一次，npm 包列表就永远 502（首轮实测日志可见）。
  //
  // 删除后收益：少一次网络往返、少一个跨实例不一致的进程内缓存、少一个
  // 失败模式。NPM_REGISTRY_TOKEN（预签发 Bearer）路径保持不变。

  /**
   * B-9：解码索引页锚点文本里的 HTML 实体。registry-pypi 渲染索引时对包名
   * 做了 html.escape（`a&b` 落页为 `a&amp;b`），此前直接取锚点文本会把转义
   * 后的名字当包名透出——列表显示 `a&amp;b`，复制出的 pip 安装命令随之错误。
   * Node 无内置 HTML 解码器，按 html.escape 的输出集做轻量反向替换（顺序
   * 关键：`&amp;` 必须最后替换，保证 `&amp;lt;` 只解码一轮得 `&lt;`，不越过
   * 单次解码语义）。覆盖 python html.escape 产物的五个实体 + 常见数字变体。
   */
  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  /** Parse PyPI simple index HTML → list of package names */
  private parsePypiIndex(html: string): string[] {
    // Use [\s\S]*? (non-greedy, dotall-equivalent) so attributes that span
    // multiple lines in the <a> tag are still matched correctly.
    const matches = html.matchAll(/<a[\s\S]*?>([^<]+)<\/a>/gi);
    const names: string[] = [];
    for (const m of matches) {
      // B-9：锚点文本先去空白再实体解码（上游渲染层转义的逆操作）。
      const name = this.decodeHtmlEntities(m[1].trim());
      if (name) names.push(name);
    }
    return names;
  }

  /**
   * B-3：列表代理的统一失败透出。此前上游非 2xx/超时被吞成
   * `{ packages: [] }` 的 200——前端 StateError（错误态已就绪）永远不触发，
   * 故障静默表现为「暂无包」。现在：上游非 2xx → 502（消息含上游状态码与
   * 响应摘要），上游超时（fetchText 统一以 504 标记）→ 504；空列表（上游
   * 2xx 且无锚点）仍是 200，失败与空态语义分离。
   */
  private throwUpstreamListFailure(
    upstream: string,
    status: number,
    text: string,
  ): never {
    if (status === HttpStatus.GATEWAY_TIMEOUT) {
      throw new AppError("REGISTRY_UPSTREAM_TIMEOUT", { upstream });
    }
    throw new AppError("REGISTRY_UPSTREAM_FAILED", {
      upstream,
      detail: `HTTP ${status}：${text.slice(0, 200)}`,
    });
  }

  @Get("pypi/packages")
  @ApiOkResponse({ type: RegistryPackagesResponseDto })
  async listPypiPackages(): Promise<{ packages: string[] }> {
    const url = `${this.pypiUrl}/simple/`;
    const resp = await this.fetchText(url, {
      user: this.pypiUser,
      pass: this.pypiPass,
    });
    // B-3：成功判据收紧为 2xx（与上传代理同口径，3xx/4xx/5xx 一律透出），
    // 不再 catch 吞错——网络错误经 fetchText 以 status 500 兜底，同样走 502。
    if (resp.status < 200 || resp.status >= 300) {
      this.logger.warn(
        `PyPI registry returned ${resp.status}: ${resp.text.slice(0, 200)}`,
      );
      this.throwUpstreamListFailure("PyPI registry", resp.status, resp.text);
    }
    return { packages: this.parsePypiIndex(resp.text) };
  }

  @Get("npm/packages")
  // P3-4（2026-10-25 审计）：npm 响应是 {name, latest?, description?} 对象数组，
  // 与 PyPI 的 string[] 契约已分叉——不再共用 RegistryPackagesResponseDto。
  @ApiOkResponse({ type: RegistryNpmPackagesResponseDto })
  // req 可选（N-4）：既有单测与内部调用以无参形态调本方法，不强行改签名——
  // 审计只需要 IP，缺 req 时审计行 ip 为空（source 可从容器日志交叉定位）。
  // @Req() 保留（Nest 运行时注入靠它），TS 侧 `?:` 让无参调用合法。
  async listNpmPackages(@Req() req?: Request): Promise<{
    packages: Array<{ name: string; latest?: string; description?: string }>;
  }> {
    // 2026-10-23（真机缺陷）：此前请求 `/-/verdaccio/packages`——该路由在
    // Verdaccio 5.x **不存在**（实测 5.31.1 返回 404「File not found」），
    // 真实路由是 `/-/verdaccio/data/packages`（verdaccio/build/api/web/api/package.js）。
    // 单测用一个自造的 http 桩「假装」这个路径存在，于是绿了整整两个版本。
    // 症状：npm 包列表恒 502，与 PyPI 那个「键没注入」是两个独立缺陷叠加。
    //
    // 返回形状也随之纠正：`/-/verdaccio/data/packages` 回的是**包版本对象数组**
    // （`{name, version, description, dist, ...}`），不是 `{name, latest}`。
    // 映射成前端契约 `{name, latest, description}`（latest 取 `version`），
    // 并对形状漂移如实降级：不是数组 → 502（不伪装成空列表）。
    const url = `${this.npmUrl}/-/verdaccio/data/packages`;
    // S5: authenticate first when a service account is configured — the
    // registry requires $authenticated access for every package pattern.
    const authHeader = await this.resolveNpmAuthHeader();
    const resp = await this.fetchText(
      url,
      undefined,
      authHeader ? { headers: { Authorization: authHeader } } : undefined,
    );
    if (resp.status < 200 || resp.status >= 300) {
      // B-3：同 PyPI——401（凭据缺失/被拒）不再静默变空列表，按 502 透出；
      // 凭据缺失的原因已在 resolveNpmAuthHeader 里 debug 级留痕。
      this.logger.warn(
        `npm registry returned ${resp.status}: ${resp.text.slice(0, 200)}`,
      );
      // N-4（2026-10-26 审计）：npm 代理读面此前只打本地 log，零审计——
      // 与同文件 PyPI 上传审计链（recordUploadAudit）对等性缺口。选择**只记
      // 失败路径**：读面成功查询是高频低信号操作（前端 Registry 页每次打开
      // 都拉一次），全量落 audit_logs 只会稀释投毒面告警的信噪比；失败
      // （凭据配置漂移、registry 故障、被代理拒绝）才是需要可追溯的信号。
      // 内网 registry 是 $authenticated 面，npm 读失败 ≈ 服务账号失效——
      // 这正是运维要回溯的时点。
      await this.recordRegistryReadAudit(req, {
        action: "registry.npm.list",
        resource: "registry",
        resourceId: "npm-packages",
        result: "failure",
        detail: { upstreamStatus: resp.status },
      });
      this.throwUpstreamListFailure("npm registry", resp.status, resp.text);
    }
    let data: unknown;
    try {
      data = JSON.parse(resp.text);
    } catch {
      // B-3：上游回了 2xx 但不是 JSON（如代理层回 HTML）也是上游故障。
      await this.recordRegistryReadAudit(req, {
        action: "registry.npm.list",
        resource: "registry",
        resourceId: "npm-packages",
        result: "failure",
        detail: { upstreamStatus: resp.status, reason: "non_json_response" },
      });
      throw new AppError("REGISTRY_UPSTREAM_FAILED", {
        upstream: "npm registry",
        detail: `返回了非 JSON 响应体：${resp.text.slice(0, 200)}`,
      });
    }
    if (!Array.isArray(data)) {
      await this.recordRegistryReadAudit(req, {
        action: "registry.npm.list",
        resource: "registry",
        resourceId: "npm-packages",
        result: "failure",
        detail: { upstreamStatus: resp.status, reason: "shape_drift" },
      });
      throw new AppError("REGISTRY_UPSTREAM_FAILED", {
        upstream: "npm registry",
        detail: `期望包数组，实际是 ${typeof data}（Verdaccio 路由/形状漂移）`,
      });
    }
    const packages = data
      .map((row: unknown) => {
        if (!row || typeof row !== "object") return null;
        const rec = row as Record<string, unknown>;
        const name = typeof rec.name === "string" ? rec.name : null;
        if (!name) return null;
        const latest =
          typeof rec.version === "string"
            ? rec.version
            : typeof rec.latest === "string"
              ? rec.latest
              : undefined;
        const description =
          typeof rec.description === "string" ? rec.description : undefined;
        return {
          name,
          ...(latest ? { latest } : {}),
          ...(description ? { description } : {}),
        };
      })
      .filter(
        (p): p is { name: string; latest?: string; description?: string } =>
          p !== null,
      );
    return { packages };
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
  @ApiCreatedResponse({ type: RegistryUploadResponseDto })
  async uploadPypiPackage(
    @UploadedFile() file: Express.Multer.File,
    @Body("name") name: string,
    @Body("version") version: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<{ success: boolean }> {
    if (!file || !name || !version) {
      throw new AppError("REGISTRY_UPLOAD_FIELDS_REQUIRED");
    }
    // A7: 字符级白名单（见 PYPI_NAME_RE / PYPI_VERSION_RE 注释）
    if (name.length > 128 || !RegistryController.PYPI_NAME_RE.test(name)) {
      throw new AppError("REGISTRY_PACKAGE_NAME_INVALID");
    }
    if (
      version.length > 64 ||
      !RegistryController.PYPI_VERSION_RE.test(version)
    ) {
      throw new AppError("REGISTRY_PACKAGE_VERSION_INVALID");
    }
    // Validate file extension to reject arbitrary uploads
    const filename = file.originalname ?? "";
    const allowed = RegistryController.ALLOWED_PYPI_EXTS;
    if (!allowed.some((ext) => filename.toLowerCase().endsWith(ext))) {
      throw new AppError("REGISTRY_FILE_TYPE_UNSUPPORTED", {
        extensions: allowed.join(", "),
      });
    }
    // A7-修复（DEEP-AUDIT B·2.1）：上传改打 **twine 兼容规范路 `POST /`**——
    // 自建 registry-pypi 的路由是 `@app.post("/")`（`POST /upload` 只是别名，
    // 且无尾斜杠）。此前打 `/upload/`（带尾斜杠）会被 Starlette 的
    // redirect_slashes 回 307（保留方法的重定向），而下方原生 http.request
    // 不跟随重定向、旧成功判据 `< 400` 又把 3xx 当成功——结果是「管理台报
    // 上传成功、包实际从未落盘」的静默假成功（实测复现）。双保险：
    // ① 规范路不存在尾斜杠重定向；② 成功判据收紧为 2xx（见下方 end 处理），
    //   任何 3xx 都按 BAD_GATEWAY 显式失败。
    const uploadUrl = `${this.pypiUrl.replace(/\/+$/, "")}/`;
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
          done(() => reject(new AppError("REGISTRY_UPLOAD_TIMEOUT")));
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
                // A7-修复（DEEP-AUDIT B·2.1）：成功判据收紧为 **2xx**。旧实现
                // `< 400` 会把上游重定向（如 307）当成功——而本代理不跟随
                // 重定向，POST 从未真正到达上传端点（2.1 假成功的根因之一）。
                // 3xx 在此显式失败并附状态码，绝不静默吞掉。
                const status = res.statusCode ?? 500;
                if (status >= 200 && status < 300) {
                  resolve({ success: true });
                } else if (status >= 300 && status < 400) {
                  reject(
                    new AppError("REGISTRY_UPLOAD_REDIRECTED", {
                      status,
                    }),
                  );
                } else if (status === HttpStatus.CONFLICT) {
                  // B-10：上游 409 = registry-pypi 的防覆盖闸（同 filename
                  // 不同 sha256，N21/N30）——此前压成 502，运维无法区分
                  // 「上游故障」与「发布冲突」。按语义透传为 409。
                  reject(
                    new AppError("REGISTRY_UPLOAD_CONFLICT", {
                      detail: body.slice(0, 200),
                    }),
                  );
                } else if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
                  // B-10：上游 413（registry-pypi S10 体积上限）同理透传。
                  reject(
                    new AppError("REGISTRY_UPLOAD_TOO_LARGE", {
                      detail: body.slice(0, 200),
                    }),
                  );
                } else {
                  reject(
                    new AppError("REGISTRY_UPLOAD_FAILED", {
                      detail: body,
                    }),
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
          done(() => reject(new AppError("REGISTRY_UPLOAD_TIMEOUT")));
        });
        req.on("error", (e) =>
          done(() =>
            reject(
              new AppError("REGISTRY_UPLOAD_FAILED", {
                detail: e.message,
              }),
            ),
          ),
        );
        // Safety net: a connection that closes without a response (and without
        // an 'error' event) must not leave the caller's promise pending forever.
        req.on("close", () =>
          done(() => reject(new AppError("REGISTRY_CONNECTION_CLOSED"))),
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
   * N-4（2026-10-26 审计）：registry 代理**读面**失败审计的公共落点。
   * 与 recordUploadAudit 同形态：audit 写失败只记 error 日志、不向上抛
   * （读失败审计是可观测性增强，绝不能把 502 变 500）。不读 CurrentUser
   * ——读面由 JwtAuthGuard 放行，controller 层不重复解析用户身份；审计行
   * 以 action/resource 定位，IP 保留（排障时区分来源容器）。
   */
  private async recordRegistryReadAudit(
    req: Request,
    params: {
      action: string;
      resource: string;
      resourceId: string;
      result: "failure";
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.audit.log({
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId,
        // req 可为空（单测直接调 controller.listNpmPackages() 不带 @Req 桩）。
        ip: req?.ip,
        result: params.result,
        detail: params.detail,
      });
    } catch (e: unknown) {
      this.logger.error(
        `Failed to write audit log for ${params.action} — registry 读失败面失去可追溯性，请检查 audit_logs 写入`,
        e instanceof Error ? e.stack : String(e),
      );
    }
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
