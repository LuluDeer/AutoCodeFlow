import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ConfigService } from "@nestjs/config";

@ApiTags("执行器")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("executors")
export class InstallCmdController {
  constructor(private readonly configService: ConfigService) {}

  @Get("install-cmd")
  @ApiOperation({
    summary: "生成执行器一键安装命令",
    description: "返回可直接在目标机器执行的 bash 安装命令",
  })
  @ApiQuery({ name: "name", required: false, description: "执行器名称（默认使用主机名）" })
  @ApiQuery({ name: "port", required: false, description: "监听端口（默认 8002）" })
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

    const args: string[] = [
      `--api-url ${adminUrl}`,
      `--secret ${secret}`,
    ];
    if (name) args.push(`--name ${name}`);
    if (port) args.push(`--port ${port}`);
    if (runtime) args.push(`--runtime ${runtime}`);

    const argStr = args.join(" ");
    const scriptUrl = `${adminUrl}/static/install.sh`;

    return {
      cmd: `bash install.sh ${argStr}`,
      curlCmd: `curl -fsSL "${scriptUrl}" | bash -s -- ${argStr}`,
    };
  }
}
