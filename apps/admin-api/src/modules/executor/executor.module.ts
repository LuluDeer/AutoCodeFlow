import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutorController } from './executor.controller';
import { ExecutorService } from './executor.service';
import { Executor } from './entities/executor.entity';
import { TaskExecution } from '../task/entities/task-execution.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Executor, TaskExecution])],
  controllers: [ExecutorController],
  providers: [ExecutorService],
  exports: [ExecutorService],
})
export class ExecutorModule {}
