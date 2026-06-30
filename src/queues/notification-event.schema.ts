import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';
import type { NotificationEventPayload } from './queues.constants';

export type NotificationEventDocument = HydratedDocument<NotificationEvent>;

@Schema({ collection: 'notification_events', timestamps: true })
export class NotificationEvent {
  @Prop({ required: true, unique: true })
  eventId: string;

  @Prop({ required: true })
  subscriptionId: string;

  @Prop({ required: true, enum: ['leader-changed', 'target-price'] })
  type: 'leader-changed' | 'target-price';

  @Prop({ required: true, type: SchemaTypes.Mixed })
  payload: NotificationEventPayload;

  @Prop({ required: true, enum: ['queued', 'sending', 'sent', 'failed'] })
  status: 'queued' | 'sending' | 'sent' | 'failed';

  @Prop({ required: true, default: 0 })
  attempts: number;

  @Prop({ type: String, default: null })
  lastError: string | null;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;
}

export const NotificationEventSchema =
  SchemaFactory.createForClass(NotificationEvent);
