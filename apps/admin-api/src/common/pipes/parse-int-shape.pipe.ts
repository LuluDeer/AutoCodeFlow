import {
  ParseIntPipe,
  type ArgumentMetadata,
  type PipeTransform,
} from "@nestjs/common";
import { AppError } from "../errors/app-error";

/**
 * F-52（UIAUDIT 后端轮 P2-1）：整数主键路由的 ID 形态契约统一。
 *
 * 背景：`/users/:id` 等整数主键路由此前挂原生 `ParseIntPipe`，形态非法（深链
 * `/users/not-a-number`）抛普通 `BadRequestException`（字符串 message
 * `"Validation failed (numeric string is expected)"`）。全局
 * `HttpExceptionFilter` 对字符串 message 只透传不赋码 → 响应是
 * `400 + errorCode:null + 裸英文文案`。同一类「ID 形态非法」在 UUID 侧
 * （`ParseUuidShapePipe` 路由管道 + 22P02 filter 兜底）已是
 * `400 + INVALID_VALUE_FORMAT`，两套形态漂移让前端按 errorCode 查 i18n 的
 * 机制在这类路由失效（UIAUDIT api-findings P2-1）。
 *
 * 本管道与 `parse-uuid-shape.pipe.ts`（F-41 先例）同构：委托 NestJS 自带的
 * `ParseIntPipe` 保住它的整数形态判定（严格 `/^-?\d+$/` 正则 + `isFinite`，
 * `"12abc"` 这类「数值可解析但形态带尾巴」的串天然被拒），仅在其拒绝时把
 * 异常**换封套**为 `AppError("INVALID_VALUE_FORMAT")`——HTTP 状态不变
 * （400），message 换错误目录中文兜底、errorCode 非 null，与 UUID 形态错误、
 * 22P02 数据库兜底三方同语言。
 *
 * 为什么在管道层显式抛 AppError 而不是留给 filter 兜底：形态校验发生在管道
 * 是最便宜的第一现场（不打 service/DB）；且 LANG-ERR-01 ③ 的纪律是「非本
 * 机制抛出的异常不编造码」——让本机制自己抛码，filter 的兜底推断就只服务
 * 漏挂管道的遗留路由（见 http-exception.filter 的管道 400 兜底分支）。
 */
export class ParseIntShapePipe implements PipeTransform<
  string,
  Promise<number>
> {
  /** 内层 NestJS 管道：保住整数形态判定（严格数字串正则 + isFinite）。 */
  private readonly delegate = new ParseIntPipe();

  async transform(value: string, metadata: ArgumentMetadata): Promise<number> {
    try {
      return await this.delegate.transform(value, metadata);
    } catch {
      // 形态非法：400 + INVALID_VALUE_FORMAT 封套（与 ParseUuidShapePipe、
      // 22P02 兜底同码同文案）。原始英文文案只含类型名、无请求值，不落日志
      // 直接换封套即可。
      throw new AppError("INVALID_VALUE_FORMAT");
    }
  }
}
