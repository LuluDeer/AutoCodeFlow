import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, any> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpCtx = context.switchToHttp();
    const response = httpCtx.getResponse();
    return next
      .handle()
      .pipe(
        map((data) => ({
          code: response.statusCode ?? 200,
          message: "success",
          data: data ?? null,
        })),
      );
  }
}
