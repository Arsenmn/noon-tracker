import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type QueueExecutionDocument = HydratedDocument<QueueExecution>;

@Schema({ collection: 'queue_executions', timestamps: true })
export class QueueExecution {
  @Prop({ required: true, unique: true })
  jobId: string;

  @Prop({ required: true })
  queue: string;

  @Prop({ required: true })
  jobName: string;

  @Prop({ required: true })
  sku: string;

  @Prop({ required: true })
  status: 'queued' | 'running' | 'completed' | 'failed';

  @Prop({ required: true, default: 0 })
  attempt: number;

  @Prop({ type: String, default: null })
  lastError: string | null;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;
}

export const QueueExecutionSchema =
  SchemaFactory.createForClass(QueueExecution);
