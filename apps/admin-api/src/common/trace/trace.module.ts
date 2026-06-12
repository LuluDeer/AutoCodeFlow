import { Module } from "@nestjs/common";
import { TraceService } from "../services/trace.service";

@Module({
  providers: [TraceService],
  exports: [TraceService],
})
export class TraceModule {}
