import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ConfigService } from "@nestjs/config";

@ApiTags("Executors")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("executors")
export class InstallCmdController {
  constructor(private readonly configService: ConfigService) {}

  @Get("install-cmd")
  @ApiOperation({
    summary: "Generate executor one-click install command",
    description: "Returns a bash install command ready to run on the target machine",
  })
  @ApiQuery({ name: "name", required: false, description: "Executor name (defaults to hostname)" })
  @ApiQuery({ name: "port", required: false, description: "Listen port (default 8002)" })
  @ApiQuery({ name: "runtime", required: false, enum: ["node", "python", "universal"] })
  getInstallCmd(
    @Query("name") name?: string,
    @Query("port") port?: string,
    @Query("runtime") runtime?: string,
  ): { cmd: string; curlCmd: string } {
    const secret = this.configService.get<string>("executor.sharedToken") ||
      this.configService.get<string>("executor.secret") || "";

    // Determine the public URL of admin-api
    const corsOrigins = this.configService.get<string>("app.corsOrigins") || "";
    const adminUrl = corsOrigins.split(",")[0]?.trim().replace(/\/$/, "") ||
      `http://localhost:${this.configService.get<number>("app.port") || 3105}`;

    // Shell-quote values to prevent word-splitting / injection when the user
    // copies the generated command into a shell.
    const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

    const args: string[] = [
      `--api-url ${q(adminUrl)}`,
      `--secret ${q(secret)}`,
    ];
    if (name) args.push(`--name ${q(name)}`);
    if (port) args.push(`--port ${q(port)}`);
    if (runtime) args.push(`--runtime ${q(runtime)}`);

    const argStr = args.join(" ");
    const scriptUrl = `${adminUrl}/static/install.sh`;

    return {
      cmd: `bash install.sh ${argStr}`,
      curlCmd: `curl -fsSL ${q(scriptUrl)} | bash -s -- ${argStr}`,
    };
  }
}
