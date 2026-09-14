import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, tap } from "rxjs";
import {
  WRITE_GUARD_KEY,
  WriteGuardMetadata,
  WriteScope,
} from "../decorators/write-guard.decorator";
import {
  OwnershipAssertionKind,
  hasOwnershipAssertion,
  runOwnershipScope,
  snapshotOwnershipAssertions,
} from "./ownership-assertion.store";

/**
 * A2-B（DEEP_REVIEW 0ef3bbe §七）：把 `@WriteGuard` 的 ownership / project-role
 * 声明从「文档」升级为**缺省拒绝的强制点**。
 *
 * 只声明不校验 = 越权缺口（评审 §1.2：updateGlue/rollback 曾完全绕过归属守卫）。
 * 本拦截器在端点**成功返回前**核对：声明的 scope 对应的断言证据是否真的落过
 * （由 `task.service.assertCanWrite` / `assertCanOperate` 等真正的校验函数在
 * 执行时落证，见 ownership-assertion.store.ts）。没落证 = 没校验 = 500。
 *
 * 刻意只在**成功路径**核对：
 *   - 校验失败本身会抛 403（ForbiddenException），错误路径不该被改写成 500，
 *     否则真实拒绝原因被掩盖、前端拿不到「你不是属主」；
 *   - 参数校验失败（400）同理——此时根本没走到属主校验是正常时序，不是缺口。
 *   即「这个写操作如果成功了，它到底有没有被授权过？」
 *
 * 作用域：只约束 HTTP 请求面。定时任务 / 进程启动逻辑不在请求作用域内，
 * 落证函数对它们是 no-op，本拦截器也不参与。
 */

/** scope → 该 scope 必须拿出的断言种类。未列出的 scope 无运行时要求。 */
export const REQUIRED_ASSERTION_KIND: Partial<
  Record<WriteScope, OwnershipAssertionKind>
> = {
  ownership: "write",
  "project-role": "operate",
};

@Injectable()
export class WriteGuardEnforcementInterceptor implements NestInterceptor {
  private readonly logger = new Logger("WriteGuardEnforcement");

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.readMeta(context);
    const required = meta && REQUIRED_ASSERTION_KIND[meta.scope];
    if (!meta || !required) return next.handle();

    const resource = meta.resource;
    const scope = meta.scope;
    const handlerName = `${context.getClass().name}.${context.getHandler().name}`;

    // 必须在 runOwnershipScope 回调**内部订阅**——只创建 Observable 的话
    // handler 的真实执行会落在 ALS 作用域之外，证据全部丢失（假红）。
    return new Observable<unknown>((subscriber) => {
      runOwnershipScope(() => {
        next.handle().subscribe(subscriber);
      });
    }).pipe(
      tap({
        next: () => {
          if (hasOwnershipAssertion(resource, required)) return;
          // 缺省拒绝：宁可 500 也不放行。500 是刻意的——这是装配/实现缺陷，
          // 不是客户端错误，必须能在监控里被看见而不是被当 403 吞掉。
          this.logger.error(
            `A2-B: ${handlerName} 声明 scope='${scope}'（resource='${resource}'）` +
              ` 但本请求未执行对应属主/项目角色校验——拒绝该写操作。` +
              `已落证据=[${snapshotOwnershipAssertions().join(", ")}]`,
          );
          throw new InternalServerErrorException(
            "Write endpoint authorization assertion missing (server misconfiguration)",
          );
        },
      }),
    );
  }

  private readMeta(context: ExecutionContext): WriteGuardMetadata | undefined {
    return this.reflector.getAllAndOverride<WriteGuardMetadata | undefined>(
      WRITE_GUARD_KEY,
      [context.getHandler(), context.getClass()],
    );
  }
}
