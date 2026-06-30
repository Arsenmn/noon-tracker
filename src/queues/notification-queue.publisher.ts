import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import {
  NotificationEvent,
  NotificationEventDocument,
} from './notification-event.schema';
import {
  NotificationEventPayload,
  SEND_NOTIFICATION_JOB,
  SendNotificationJobData,
  TELEGRAM_NOTIFICATION_QUEUE,
} from './queues.constants';

@Injectable()
export class NotificationQueuePublisher {
  constructor(
    @InjectQueue(TELEGRAM_NOTIFICATION_QUEUE)
    private readonly queue: Queue<SendNotificationJobData>,
    @InjectModel(NotificationEvent.name)
    private readonly events: Model<NotificationEventDocument>,
    private readonly configService: ConfigService,
  ) {}

  async publish(
    eventId: string,
    payload: NotificationEventPayload,
  ): Promise<void> {
    const event = await this.events
      .findOneAndUpdate(
        { eventId },
        {
          $setOnInsert: {
            eventId,
            subscriptionId: payload.subscriptionId,
            type: payload.type,
            payload,
            status: 'queued',
            attempts: 0,
            lastError: null,
            sentAt: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();
    if (!event || event.status === 'sent' || event.status === 'sending') {
      return;
    }

    const existingJob = await this.queue.getJob(eventId);
    if (existingJob) {
      if ((await existingJob.getState()) === 'failed') {
        await existingJob.retry();
      }
      return;
    }

    await this.queue.add(
      SEND_NOTIFICATION_JOB,
      { eventId },
      {
        jobId: eventId,
        attempts: this.configService.get<number>(
          'NOTIFICATION_JOB_ATTEMPTS',
          5,
        ),
        backoff: {
          type: 'exponential',
          delay: this.configService.get<number>(
            'NOTIFICATION_JOB_BACKOFF_MS',
            3_000,
          ),
        },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 604_800, count: 10_000 },
      },
    );
  }
}
