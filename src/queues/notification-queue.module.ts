import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  NotificationEvent,
  NotificationEventSchema,
} from './notification-event.schema';
import { NotificationQueuePublisher } from './notification-queue.publisher';
import { TELEGRAM_NOTIFICATION_QUEUE } from './queues.constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: TELEGRAM_NOTIFICATION_QUEUE,
      forceDisconnectOnShutdown: true,
    }),
    MongooseModule.forFeature([
      { name: NotificationEvent.name, schema: NotificationEventSchema },
    ]),
  ],
  providers: [NotificationQueuePublisher],
  exports: [NotificationQueuePublisher, BullModule, MongooseModule],
})
export class NotificationQueueModule {}
