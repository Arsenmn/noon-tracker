import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TrackingSubscriptionDocument =
  HydratedDocument<TrackingSubscription>;

@Schema({ collection: 'tracking_subscriptions', timestamps: true })
export class TrackingSubscription {
  @Prop({ required: true })
  telegramUserId: string;

  @Prop({ required: true })
  chatId: string;

  @Prop({ required: true })
  sku: string;

  @Prop({ required: true })
  canonicalUrl: string;

  @Prop({ type: String, default: null })
  title: string | null;

  @Prop({ type: Number, default: null, min: 0 })
  targetPriceMinor: number | null;

  @Prop({ required: true, default: true })
  isActive: boolean;

  @Prop({ required: true, default: false })
  targetPriceTriggered: boolean;

  @Prop({ type: String, default: null })
  lastLeaderOfferId: string | null;

  @Prop({ type: String, default: null })
  lastLeaderSellerName: string | null;

  @Prop({ required: true, default: 0, min: 0 })
  leaderChangeVersion: number;

  @Prop({ required: true, default: 0, min: 0 })
  targetPriceCycle: number;
}

export const TrackingSubscriptionSchema =
  SchemaFactory.createForClass(TrackingSubscription);

TrackingSubscriptionSchema.index(
  { telegramUserId: 1, chatId: 1, sku: 1 },
  { unique: true },
);
TrackingSubscriptionSchema.index({ sku: 1, isActive: 1 });
