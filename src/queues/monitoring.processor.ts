import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import { MonitoringService } from '../monitoring/monitoring.service';
import {
  MONITOR_PRODUCT_JOB,
  MonitorProductJobData,
  PRODUCT_MONITORING_QUEUE,
} from './queues.constants';
import {
  QueueExecution,
  QueueExecutionDocument,
} from './queue-execution.schema';

@Processor(PRODUCT_MONITORING_QUEUE, {
  concurrency: 2,
  limiter: { max: 10, duration: 60_000 },
})
export class MonitoringProcessor extends WorkerHost {
  private readonly logger = new Logger(MonitoringProcessor.name);

  constructor(
    private readonly monitoring: MonitoringService,
    @InjectModel(QueueExecution.name)
    private readonly executions: Model<QueueExecutionDocument>,
  ) {
    super();
  }

  async process(job: Job<MonitorProductJobData>): Promise<void> {
    if (job.name !== MONITOR_PRODUCT_JOB) {
      throw new Error(`Unsupported monitoring job ${job.name}`);
    }

    await this.recordStatus(job, 'running');
    try {
      await this.monitoring.monitorSku(job.data.sku);
      await this.recordStatus(job, 'completed');
    } catch (error: unknown) {
      await this.recordStatus(job, 'failed', error);
      throw error;
    }
  }

  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.logger.error(`Monitoring worker error: ${error.message}`);
  }

  private async recordStatus(
    job: Job<MonitorProductJobData>,
    status: 'running' | 'completed' | 'failed',
    error?: unknown,
  ): Promise<void> {
    const jobId = String(job.id);
    try {
      await this.executions
        .updateOne(
          { jobId },
          {
            $set: {
              status,
              attempt: job.attemptsMade + 1,
              lastError:
                error === undefined
                  ? null
                  : (error instanceof Error
                      ? error.message
                      : typeof error === 'string'
                        ? error
                        : 'Unknown monitoring error'
                    ).slice(0, 1_000),
              completedAt: status === 'completed' ? new Date() : null,
            },
            $setOnInsert: {
              jobId,
              queue: PRODUCT_MONITORING_QUEUE,
              jobName: job.name,
              sku: job.data.sku,
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (auditError: unknown) {
      this.logger.error(
        `Queue audit write failed jobId=${jobId} reason=${auditError instanceof Error ? auditError.message : String(auditError)}`,
      );
    }
  }
}
