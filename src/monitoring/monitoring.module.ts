import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BotModule } from '../bot/bot.module';
import { NoonModule } from '../noon/noon.module';
import { NotificationQueueModule } from '../queues/notification-queue.module';
import {
  MonitoredProduct,
  MonitoredProductSchema,
} from './monitored-product.schema';
import { MonitoringService } from './monitoring.service';

@Module({
  imports: [
    NoonModule,
    BotModule,
    NotificationQueueModule,
    MongooseModule.forFeature([
      { name: MonitoredProduct.name, schema: MonitoredProductSchema },
    ]),
  ],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}
