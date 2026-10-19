import {
  ParseUUIDPipe,
  type ArgumentMetadata,
  type PipeTransform,
} from "@nestjs/common";
import { isUuidShape } from "../decorators/is-uuid-shape.decorator";

/**
 * PROJECT-UUID-01（生产故障）：路由参数用的 `ParseUUIDPipe` 会 400 掉**默认项目
 * 自己的 id**，于是项目管理页点「成员」必现
 *
 *     Validation failed (uuid is expected)
 *
 * 根因与 `is-uuid-shape.decorator.ts` 头注记的是**同一类**缺陷，但那一轮只修了
 * **DTO 校验**（`@IsUUID()` → `@IsUuidShape()`），**路由参数**这条路径漏了：
 *
 *   `DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000001'`
 *   的版本位是 `0`，NestJS 12 的 `ParseUUIDPipe` 默认 version='all'，正则
 *   （`@nestjs/common/pipes/parse-uuid.pipe.js` 的 `uuidRegExps.all`）只接受：
 *
 *     · 版本 1–8 且 variant 位 ∈ [89ab] 的 RFC 9562 UUID；
 *     · nil UUID `00000000-0000-0000-0000-000000000000`；
 *     · max UUID `ffffffff-ffff-ffff-ffff-ffffffffffff`。
 *
 *   实测（本仓 @nestjs/common 12.1.3 的 `uuidRegExps.all`）：
 *
 *     00000000-0000-0000-0000-000000000001  ->  false   ← 默认项目，必被拒
 *     00000000-0000-0000-0000-000000000000  ->  true    ← nil，恰好通过
 *     aaaa0000-0000-4000-8000-000000000002  ->  true    ← 普通 v4
 *
 * 即「默认项目」是**唯一**一个过不了路由校验的合法项目 id。`GET /projects`
 * 无条件返回它（`projects.controller.ts` findAll 的 `p.id === DEFAULT_PROJECT_ID`），
 * 所以项目管理页第一行就是它——**点其它行可能对，点第一行必错**。同文件里
 * `findOne / update / remove / listMembers / addMember / updateMember /
 * removeMember` 全部挂 `ParseUUIDPipe`，故「成员」只是最先被点到的那个入口；
 * 同一行的编辑/删除也会撞同一面墙。
 *
 * 为什么改路由校验而不是改 `DEFAULT_PROJECT_ID`：后者是三处硬编码的既有主键
 * （实体常量 + 两条迁移的种子与回填 SQL），存量数据已按该值落库，改它等于改
 * 主键——与 `is-uuid-shape.decorator.ts` 头注「为什么不改 DEFAULT_PROJECT_ID」
 * 同一结论。正确做法同样是让校验器表达真实意图：**这里要的是「一个 UUID 形状
 * 的标识符」，不是「一个 RFC 4122 版本 1–8 的 UUID」**。
 *
 * 实现取「复用 + 收窄」而非「重写正则」：先交给 NestJS 自带的 `ParseUUIDPipe`
 * （保住它对 nil/max UUID、大小写、非字符串输入的既有行为与错误文案），仅在它
 * 拒绝时**追加**一次形状校验放行。这样：
 *
 *   · 默认项目 id、variant 位非 [89ab] 的 v4、v7 等 → 放行（与 `@IsUuidShape`
 *     的接受面逐字一致，两处不漂移）；
 *   · `urn:uuid:…` / `{…}` / 空串 / `abc` / 注入串 / 超长串 → 仍然拒绝
 *     （`isUuidShape` 是锚定的 8-4-4-4-12 十六进制正则，不放松任何语法面）；
 *   · 错误文案与状态码保持 NestJS 原样（400 + `Validation failed (uuid is
 *     expected)`），既有按此断言的 spec 不受影响。
 *
 * 安全性：放宽的只是版本位/variant 位两个「形状内的自由位」，值最终仍走
 * TypeORM 参数化查询，不做字符串拼接（与 `is-uuid-shape.decorator.ts` 同论证）。
 */
export class ParseUuidShapePipe implements PipeTransform<
  string,
  Promise<string>
> {
  /** 内层 NestJS 管道：保住框架原有的错误文案/状态码与 nil/max 特例。 */
  private readonly delegate = new ParseUUIDPipe();

  async transform(value: string, metadata: ArgumentMetadata): Promise<string> {
    try {
      return await this.delegate.transform(value, metadata);
    } catch (err) {
      // 内层拒绝：只有「形状是 UUID」才放行，否则**原样抛回框架异常**
      // （不吞不改——nil/max 走不到这里，它们内层就通过了）。
      //
      // 这里不再补 `if (err instanceof Error)` 的兜底分支：`ParseUUIDPipe`
      // 抛的一定是 `HttpException`（`Error` 的子类），那个分支恒不可达；
      // 更糟的是它会把内层原始的 message 换成硬编码常量——若未来有人给
      // 内层传 `exceptionFactory`，自定义文案会被这里静默吃掉。直接抛原
      // 异常，错误文案/状态码就与 NestJS 逐字一致（本文件头注的承诺）。
      if (isUuidShape(value)) return value;
      throw err;
    }
  }
}
