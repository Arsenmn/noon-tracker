import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { BotModule } from '../bot/bot.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { MonitoringProcessor } from './monitoring.processor';
import { NotificationProcessor } from './notification.processor';
import { NotificationQueueModule } from './notification-queue.module';
import { QueueExecution, QueueExecutionSchema } from './queue-execution.schema';
import { PRODUCT_MONITORING_QUEUE } from './queues.constants';
import { QueuesService } from './queues.service';
import { QueuesController } from './queues.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BotModule,
    MonitoringModule,
    NotificationQueueModule,
    BullModule.registerQueue({
      name: PRODUCT_MONITORING_QUEUE,
      forceDisconnectOnShutdown: true,
    }),
    MongooseModule.forFeature([
      { name: QueueExecution.name, schema: QueueExecutionSchema },
    ]),
  ],
  controllers: [QueuesController],
  providers: [QueuesService, MonitoringProcessor, NotificationProcessor],
  exports: [QueuesService],
})
export class QueuesModule {}
