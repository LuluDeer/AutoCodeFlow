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

@UseGuards(JwtAuthGuard)
@Controller("registry")
export class RegistryController {
  private readonly logger = new Logger(RegistryController.name);

  constructor(private readonly config: ConfigService) {}

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
    return (
      this.config.get<string>("NPM_REGISTRY_URL") || "http://localhost:4873"
    );
  }

  // S5: optional Verdaccio service account (configuration.ts: registry.npm,
  // registered as optional NPM_REGISTRY_* env vars in the Joi schema). When
  // configured, the proxy authenticates before pulling the package list; when
  // unset the previous anonymous behavior is kept.
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

  @Post("pypi/upload")
  // Limit uploads to 50 MB; multer enforces this before the handler runs
  @UseInterceptors(
    FileInterceptor("content", { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  async uploadPypiPackage(
    @UploadedFile() file: Express.Multer.File,
    @Body("name") name: string,
    @Body("version") version: string,
  ): Promise<{ success: boolean }> {
    if (!file || !name || !version) {
      throw new HttpException(
        "name, version and file are required",
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
    return new Promise((resolve, reject) => {
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
    });
  }
}
