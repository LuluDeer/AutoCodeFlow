import { BadRequestException, type PipeTransform } from "@nestjs/common";

/**
 * F-53（UIAUDIT 后端轮 P2-2）：POST /notification/channels/:key/test 的
 * per-channel 配置覆盖体形状管道。
 *
 * 为什么不是 class DTO：body 是**动态键**的 `Record<string, string>`——键集随
 * 渠道类型变化（email: host/port/username/password…、webhook: url、
 * feishu: webhookUrl/secret…，见 notification-config.service 的渠道默认值与
 * ChannelConfigStore），封闭的 class DTO 会把「新增一个渠道配置键」变成
 * 「必须同步改 DTO，否则该键 400」的陷阱——这正是 class-validator 面对开放
 * 映射的边界。metatype 保持非 class（运行时 Object），全局 ValidationPipe
 * 如旧跳过，由本管道承担该面的校验职责。
 *
 * 校验面（此前完全无校验——任意形状 JSON 直达渠道 override，非字符串值会
 * 流进渠道实现）：
 *   ① 必须是普通对象（数组/null/标量 400）；
 *   ② 每个值必须是 string（数字/嵌套对象 400——拒绝而非静默转换，与全站
 *      forbidNonWhitelisted 的「可疑输入必 400」方向一致）；
 *   ③ 键数量 ≤32、单键 ≤64 字符、单值 ≤4096 字符（渠道配置键的现实上界
 *      远低于此；全局 body 1MB 之下再给这层 admin-only 面一个便宜的护栏）。
 *
 * 错误形态与全局 ValidationPipe 对齐：BadRequestException + message 数组，
 * 经 HttpExceptionFilter 落成 400 VALIDATION_FAILED（detail 进 message）。
 */
export class ChannelConfigOverridePipe
  implements PipeTransform<unknown, Record<string, string>>
{
  /** 键数量/长度/值长度的护栏上界（现实渠道配置远用不到）。 */
  private static readonly MAX_KEYS = 32;
  private static readonly MAX_KEY_LENGTH = 64;
  private static readonly MAX_VALUE_LENGTH = 4096;

  transform(value: unknown): Record<string, string> {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException({
        statusCode: 400,
        message: ["config override must be an object (string → string map)"],
        error: "Bad Request",
      });
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > ChannelConfigOverridePipe.MAX_KEYS) {
      throw new BadRequestException({
        statusCode: 400,
        message: [
          `config override accepts at most ${ChannelConfigOverridePipe.MAX_KEYS} keys`,
        ],
        error: "Bad Request",
      });
    }
    const out: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (k.length > ChannelConfigOverridePipe.MAX_KEY_LENGTH) {
        throw new BadRequestException({
          statusCode: 400,
          message: [
            `config override key too long (max ${ChannelConfigOverridePipe.MAX_KEY_LENGTH}): ${k.slice(0, 16)}…`,
          ],
          error: "Bad Request",
        });
      }
      if (typeof v !== "string") {
        throw new BadRequestException({
          statusCode: 400,
          message: [`config override value for "${k}" must be a string`],
          error: "Bad Request",
        });
      }
      if (v.length > ChannelConfigOverridePipe.MAX_VALUE_LENGTH) {
        throw new BadRequestException({
          statusCode: 400,
          message: [
            `config override value for "${k}" too long (max ${ChannelConfigOverridePipe.MAX_VALUE_LENGTH})`,
          ],
          error: "Bad Request",
        });
      }
      out[k] = v;
    }
    return out;
  }
}
