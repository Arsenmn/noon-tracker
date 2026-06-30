import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NoonModule } from '../noon/noon.module';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import {
  TrackingSubscription,
  TrackingSubscriptionSchema,
} from './tracking-subscription.schema';
import { TrackingSubscriptionService } from './tracking-subscription.service';

@Module({
  imports: [
    NoonModule,
    MongooseModule.forFeature([
      { name: TrackingSubscription.name, schema: TrackingSubscriptionSchema },
    ]),
  ],
  controllers: [BotController],
  providers: [BotService, TrackingSubscriptionService],
  exports: [BotService, TrackingSubscriptionService],
})
export class BotModule {}
