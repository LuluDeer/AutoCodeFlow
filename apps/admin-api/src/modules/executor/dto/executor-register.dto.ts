import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
// python_task_multiversion（WS2）：解释器清单条目 DTO 与心跳共用一份定义
// （两处上报同一形状，分开定义必然漂移）。
import { ExecutorInterpreterDto } from "./executor-heartbeat.dto";
// R3-A（部署模型评审 §4.3）：设备级应用版本事实/已安装包清单同样与心跳共用
// 一份定义（同一上报形状，分开定义必然漂移）。
import { DeployedAppDto, InstalledPackageDto } from "./executor-heartbeat.dto";

/**
 * PK-03（DEEP_REVIEW 0ef3bbe）: POST /executors/register 的请求体 Swagger 文档 DTO。
 *
 * 注意：本类**仅用于 openapi schema 生成**——控制器 @Body() 仍用内联类型
 * （metatype = Object，全局 ValidationPipe 不对其做 whitelist 校验）。此处不挂
 * class-validator 装饰器，避免把 executor-node 注册请求体误入
 * forbidNonWhitelisted 400 路径；字段白名单在 controller/service 侧显式裁剪。
 */
export class ExecutorRegisterDto {
  @ApiProperty({
    example: "executor-node",
    description: "执行器应用名称",
  })
  appName: string;

  @ApiProperty({
    example: "192.168.1.100:3002",
    description: "执行器注册地址",
  })
  address: string;

  @ApiPropertyOptional({
    example: "node",
    description: "执行器类型",
  })
  type?: string;

  @ApiPropertyOptional({
    example: "1.0.0",
    description: "执行器版本",
  })
  version?: string;

  @ApiPropertyOptional({
    example: 1,
    description:
      "PROTOCOL-VER (B-3/U-2): 执行器线缆协议版本（与实现版本 version 解耦）。中台按兼容矩阵分支：低于 supportedMin 只 warn + 兜底，不拒绝注册。",
  })
  protocolVersion?: number;

  @ApiPropertyOptional({
    type: [String],
    example: ["docker", "shell"],
    description: "声明的能力",
  })
  capabilities?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ["nodejs", "python3"],
    description: "声明的运行时环境",
  })
  runtime?: string[];

  @ApiPropertyOptional({
    example: 10,
    description: "最大并发任务数",
  })
  maxConcurrentTasks?: number;

  @ApiPropertyOptional({
    example: 10,
    description: "最大并发数（legacy 别名）",
  })
  maxConcurrent?: number;

  @ApiPropertyOptional({
    example: "production",
    nullable: true,
    description: "执行器分组名称",
  })
  groupName?: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ["nodejs", "prod"],
    nullable: true,
    description: "执行器标签",
  })
  tags?: string[] | null;

  @ApiPropertyOptional({
    example: "Production Node.js executor",
    nullable: true,
    description: "执行器描述",
  })
  description?: string | null;

  @ApiPropertyOptional({
    example: "2026-09-14T08:00:00.000Z",
    nullable: true,
    description: "重启时间戳（ISO 8601）",
  })
  restartedAt?: string | null;

  @ApiPropertyOptional({
    example: "uuid-of-this-executor-process-life",
    nullable: true,
    description: "启动 ID（进程生命周期标识，用于幂等重复注册）",
  })
  startupId?: string | null;

  @ApiPropertyOptional({
    example: "pull",
    enum: ["push", "pull"],
    description: "派发模式（'push' | 'pull'；默认为 push）",
  })
  dispatchMode?: string;

  @ApiPropertyOptional({
    type: () => [ExecutorInterpreterDto],
    description:
      "python_task_multiversion：解释器缓存池清单。缺省 → 保留已存值；[] → 已上报且池为空；结构非法 → 整字段被拒绝。",
  })
  interpreters?: ExecutorInterpreterDto[];

  @ApiPropertyOptional({
    example: "3f2a1c9d8b7e6f504132a5b6c7d8e9f00a1b2c3d4e5f60718293a4b5c6d7e8f9",
    nullable: true,
    description:
      "ARCH-36（ADR-017 第二/三阶段）：稳定的安装身份 —— sha256(deviceId + ':' + installSalt)，64 位小写十六进制字符。ADR-017 第三阶段把它定为行查找键：注册时先按指纹解析行（地址退化为可达性元数据）。缺省/非法 → 保留已存值并回退到按地址查找；从未上报过指纹的行会带上服务端生成的 `legacy:{address}` 兜底键。",
  })
  deviceFingerprint?: string | null;

  @ApiPropertyOptional({
    type: () => [DeployedAppDto],
    description:
      "R3-A（§4.3）：设备级应用版本事实（执行器启动时随注册上报一份，语义与心跳 deployedApps 完全一致：缺省 → 不动；[] → 设备无已部署应用；非法 → 整字段拒绝）。",
  })
  deployedApps?: DeployedAppDto[];

  @ApiPropertyOptional({
    type: () => [InstalledPackageDto],
    description:
      "R3-A（§4.3/P10）：设备已安装的执行器包清单（语义与心跳 installedPackages 完全一致）。",
  })
  installedPackages?: InstalledPackageDto[];
}
