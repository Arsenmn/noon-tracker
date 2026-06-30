import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import { BotService } from '../bot/bot.service';
import { TrackingSubscriptionService } from '../bot/tracking-subscription.service';
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

@Processor(TELEGRAM_NOTIFICATION_QUEUE, { concurrency: 5 })
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly bot: BotService,
    private readonly subscriptions: TrackingSubscriptionService,
    @InjectModel(NotificationEvent.name)
    private readonly events: Model<NotificationEventDocument>,
  ) {
    super();
  }

  async process(job: Job<SendNotificationJobData>): Promise<void> {
    if (job.name !== SEND_NOTIFICATION_JOB) {
      throw new Error(`Unsupported notification job ${job.name}`);
    }

    const current = await this.events
      .findOne({ eventId: job.data.eventId })
      .lean()
      .exec();
    if (!current || current.status === 'sent') {
      return;
    }
    if (current.status === 'sending') {
      await this.finalizeEvent(current.payload);
      await this.markSent(job.data.eventId);
      return;
    }

    const event = await this.events
      .findOneAndUpdate(
        {
          eventId: job.data.eventId,
          status: { $in: ['queued', 'failed'] },
        },
        {
          $set: { status: 'sending', lastError: null },
          $inc: { attempts: 1 },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!event) {
      return;
    }

    try {
      await this.send(event.payload);
      await this.finalizeEvent(event.payload);
      await this.markSent(event.eventId);
    } catch (error: unknown) {
      const reason =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown notification error';
      await this.events
        .updateOne(
          { eventId: event.eventId },
          { $set: { status: 'failed', lastError: reason.slice(0, 1_000) } },
        )
        .exec();
      throw error;
    }
  }

  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.logger.error(`Notification worker error: ${error.message}`);
  }

  private async send(payload: NotificationEventPayload): Promise<void> {
    if (payload.type === 'leader-changed') {
      await this.bot.sendLeaderChangedNotification(
        payload.chatId,
        payload.notification,
      );
      return;
    }
    await this.bot.sendTargetPriceNotification(
      payload.chatId,
      payload.notification,
    );
  }

  private async finalizeEvent(
    payload: NotificationEventPayload,
  ): Promise<void> {
    if (payload.type === 'leader-changed') {
      await this.subscriptions.advanceLeader(
        payload.subscriptionId,
        payload.leaderOfferId,
        payload.leaderSellerName,
      );
      return;
    }
    await this.subscriptions.setTargetPriceTriggered(
      payload.subscriptionId,
      true,
    );
  }

  private async markSent(eventId: string): Promise<void> {
    await this.events
      .updateOne(
        { eventId },
        {
          $set: {
            status: 'sent',
            lastError: null,
            sentAt: new Date(),
          },
        },
      )
      .exec();
  }
}
