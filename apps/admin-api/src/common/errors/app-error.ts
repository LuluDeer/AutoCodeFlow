import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  GoneException,
  HttpException,
  InternalServerErrorException,
  MethodNotAllowedException,
  NotAcceptableException,
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  PreconditionFailedException,
  RequestTimeoutException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import {
  ERROR_CATALOG,
  renderZh,
  type ErrorCode,
  type ErrorCodeDef,
} from "./error-codes";

/**
 * HTTP 状态码 → NestJS 内置异常类。
 *
 * 为什么需要这张表（**这是全量迁移能否收敛的关键**，别删）：
 *
 * 本仓有 178 处 spec 用 `.rejects.toThrow(UnauthorizedException)` 这类**按异常类
 * 断言**的写法。若 `AppError` 是独立于它们的新类，那么把一处
 * `throw new UnauthorizedException("凭据无效")` 改成
 * `throw new AppError("INVALID_CREDENTIALS")` 之后，**行为完全没变**（同样的
 * 401、同样的文案），测试却会集体变红——迁移者于是被迫去改那 178 处断言，
 * 既稀释了这次改动的语义，也让"翻译"看起来像"破坏契约"。
 *
 * 故让 `AppError` 在构造时**按状态码挂到对应的 NestJS 内置异常类上**
 * （原型链拼接，见下）。这样 `instanceof UnauthorizedException` 仍为真、
 * `toThrow(UnauthorizedException)` 继续通过，而 `errorCode` 一路带到响应体。
 *
 * ⚠️ 为什么不干脆 `extends UnauthorizedException`：状态码是**每个码各自**的
 * （同一个域里 400/403/404/409 混用），编译期无法知道某个 `ErrorCode` 对应哪个
 * 类。若按"每个码建一个子类"来解，运行时就要动态造类——那会让
 * `instanceof` 的语义变得依赖构造时机，更难推理。用 `Object.setPrototypeOf`
 * 在构造后改原型链，是这里唯一既保住 `instanceof`、又保住单一定义的方式。
 */
const STATUS_TO_EXCEPTION: Record<
  number,
  new (...args: never[]) => HttpException
> = {
  400: BadRequestException,
  401: UnauthorizedException,
  402: PreconditionFailedException, // Nest 无 402 专用类，用最接近的语义占位
  403: ForbiddenException,
  404: NotFoundException,
  405: MethodNotAllowedException,
  406: NotAcceptableException,
  408: RequestTimeoutException,
  409: ConflictException,
  410: GoneException,
  413: PayloadTooLargeException,
  415: UnsupportedMediaTypeException,
  422: UnprocessableEntityException,
  500: InternalServerErrorException,
  501: NotImplementedException,
  502: BadGatewayException,
  503: ServiceUnavailableException,
  504: GatewayTimeoutException,
};

/**
 * LANG-ERR-01：**带稳定错误码的异常**——后端抛码，前端翻译。
 *
 * ## 用法
 *
 * ```ts
 * throw new AppError(ErrorCode.EXECUTOR_NOT_FOUND);
 * throw new AppError(ErrorCode.TASK_NAME_EXISTS, { name: task.name });
 * ```
 *
 * 与 `throw new BadRequestException("…中文…")` 的区别，正是本机制存在的理由：
 * 后者的文案在**抛出时刻**就被写死成一种语言，无法随用户语言变化；前者只带
 * 码 + 参数，文案由前端 i18n 决定。
 *
 * ## 为什么继承 `HttpException` 而不是自造一套
 *
 * `http-exception.filter.ts`（全局 `@Catch()`）已经接管了 HTTP 状态、日志与响应
 * 体拼装；继承它意味着**零新增异常处理通路**——`getStatus()` 直接给状态码，
 * `getResponse()` 给载荷对象，既有守卫/管道/拦截器全部照旧工作。自造基类则要
 * 在 filter 里多一条分支，多一条分支就多一处可能漂移的判定（本仓既有教训：
 * `INTERPRETER_UNAVAILABLE_PATTERN` 曾经在两个分类器里各抄了一份）。
 *
 * ## 载荷形状（filter 会原样透出这三个字段）
 *
 * ```json
 * { "errorCode": "EXECUTOR_NOT_FOUND", "message": "执行器不存在", "params": null }
 * ```
 *
 * `message` 是**中文兜底**，服务于不翻译的消费者（裸 API / CLI / MCP / 日志 /
 * 落库字段）——详见 `error-codes.ts` 的 `zh` 说明。**它不是给前端显示的**：
 * 前端拿 `errorCode` 查自己的 i18n 表，查不到才回落到这个 `message`。
 */
export class AppError extends HttpException {
  /** 业务码（同时出现在载荷里，供测试与调用方断言，不必再解析 response）。 */
  readonly errorCode: ErrorCode;

  /** 插值参数（`null` = 无参数，与"传了空对象"区分开，便于调用方判断）。 */
  readonly params: Record<string, unknown> | null;

  constructor(code: ErrorCode, params?: Record<string, unknown> | null) {
    const def: ErrorCodeDef = ERROR_CATALOG[code];
    const message = renderZh(code, params);
    super({ errorCode: code, message, params: params ?? null }, def.status);
    this.errorCode = code;
    this.params = params ?? null;
    // Node 的 Error.name 默认是类名，但 HttpException 的 message 在
    // super() 里被设成对象字符串化后的形态——这里把它收敛成中文兜底文案，
    // 使「只读 exception.message」的既有调用方（日志、测试断言、
    // 分类链）拿到的是同一份人读文案，而不是 '[object Object]'。
    this.message = message;
    // 按状态码挂到对应的 NestJS 内置异常类上，保住 `instanceof`（见上方
    // STATUS_TO_EXCEPTION 的长注释：这是 178 处按类断言的 spec 不用改的原因）。
    // 未知状态码保持 HttpException 原型（filter 仍按 getStatus() 正确出码）。
    const Ctor = STATUS_TO_EXCEPTION[def.status];
    if (Ctor) {
      Object.setPrototypeOf(this, Ctor.prototype);
      // ⚠️ `instanceof` 之外还必须对齐 `name`：Jest 的
      // `toThrow(new UnauthorizedException("…"))` 比对的是**实例的 name + message**
      // （不是 instanceof）。只做 setPrototypeOf 时 `name` 仍是 "AppError"，
      // 于是 `rejects.toThrow(new UnauthorizedException("账号已被禁用"))` 会以
      // "serializes to the same string" 失败——**文案一模一样却报错**，是最难
      // 读懂的一类红（实测 jwt.strategy.spec.ts 两例正是如此）。
      // 取构造器名（`UnauthorizedException`）而非硬编码，跟随映射表自动正确。
      this.name = Ctor.name;
    }
  }
}
