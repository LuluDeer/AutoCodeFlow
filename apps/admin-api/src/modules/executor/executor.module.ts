import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutorController } from './executor.controller';
import { ExecutorService } from './executor.service';
import { Executor } from './entities/executor.entity';
import { Task } from '../task/entities/task.entity';
import { TaskExecution } from '../task/entities/task-execution.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Executor, Task, TaskExecution])],
  controllers: [ExecutorController],
  // ConfigService is global (ConfigModule.forRoot isGlobal:true) so no extra import needed
  providers: [ExecutorService],
  exports: [ExecutorService],
})
export class ExecutorModule {}
