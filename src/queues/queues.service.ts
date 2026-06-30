import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { TrackingSubscriptionService } from '../bot/tracking-subscription.service';
import {
  MONITOR_PRODUCT_JOB,
  MonitorProductJobData,
  PRODUCT_MONITORING_QUEUE,
} from './queues.constants';
import {
  QueueExecution,
  QueueExecutionDocument,
} from './queue-execution.schema';

const OFFERS_CRON = process.env.OFFERS_CRON ?? '* * * * *';

@Injectable()
export class QueuesService {
  private readonly logger = new Logger(QueuesService.name);

  constructor(
    @InjectQueue(PRODUCT_MONITORING_QUEUE)
    private readonly monitoringQueue: Queue<MonitorProductJobData>,
    private readonly subscriptions: TrackingSubscriptionService,
    private readonly configService: ConfigService,
    @InjectModel(QueueExecution.name)
    private readonly executions: Model<QueueExecutionDocument>,
  ) {}

  @Cron(OFFERS_CRON, { name: 'enqueue-product-monitoring' })
  async enqueueActiveProducts(): Promise<void> {
    const activeSubscriptions = await this.subscriptions.findActive();
    const uniqueSkus = [...new Set(activeSubscriptions.map(({ sku }) => sku))];
    const minuteBucket = Math.floor(Date.now() / 60_000);

    for (const sku of uniqueSkus) {
      const jobId = `monitor-${sku}-${minuteBucket}`;
      try {
        await this.monitoringQueue.add(
          MONITOR_PRODUCT_JOB,
          { sku },
          {
            jobId,
            attempts: this.configService.get<number>(
              'MONITORING_JOB_ATTEMPTS',
              3,
            ),
            backoff: {
              type: 'exponential',
              delay: this.configService.get<number>(
                'MONITORING_JOB_BACKOFF_MS',
                5_000,
              ),
            },
            removeOnComplete: { age: 3_600, count: 1_000 },
            removeOnFail: { age: 86_400, count: 5_000 },
          },
        );
        await this.executions
          .updateOne(
            { jobId },
            {
              $setOnInsert: {
                jobId,
                queue: PRODUCT_MONITORING_QUEUE,
                jobName: MONITOR_PRODUCT_JOB,
                sku,
                status: 'queued',
                attempt: 0,
                lastError: null,
                completedAt: null,
              },
            },
            { upsert: true },
          )
          .exec();
      } catch (error: unknown) {
        this.logger.error(
          `Could not enqueue monitoring sku=${sku} reason=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(`Enqueued ${uniqueSkus.length} unique active SKUs`);
  }
}
