import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { AppModule } from '../src/app.module';
import { BotService } from '../src/bot/bot.service';
import { MonitoringService } from '../src/monitoring/monitoring.service';
import {
  QueueExecution,
  QueueExecutionDocument,
} from '../src/queues/queue-execution.schema';
import {
  MONITOR_PRODUCT_JOB,
  MonitorProductJobData,
  PRODUCT_MONITORING_QUEUE,
} from '../src/queues/queues.constants';

describe('BullMQ monitoring pipeline (e2e)', () => {
  let app: INestApplication;
  let queue: Queue<MonitorProductJobData>;
  let executions: Model<QueueExecutionDocument>;
  const monitorSku = jest.fn<() => Promise<void>>();
  const jobId = `integration-monitor-${Date.now()}`;

  beforeAll(async () => {
    monitorSku.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BotService)
      .useValue({})
      .overrideProvider(MonitoringService)
      .useValue({ monitorSku })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    queue = app.get<Queue<MonitorProductJobData>>(
      getQueueToken(PRODUCT_MONITORING_QUEUE),
    );
    executions = app.get<Model<QueueExecutionDocument>>(
      getModelToken(QueueExecution.name),
    );
  });

  afterAll(async () => {
    const job = await queue.getJob(jobId);
    if (job) await job.remove();
    await executions.deleteOne({ jobId }).exec();

    const shutdownStartedAt = Date.now();
    await app.close();
    expect(Date.now() - shutdownStartedAt).toBeLessThan(3_000);
  });

  it('processes Redis job and persists completion in MongoDB', async () => {
    await queue.add(
      MONITOR_PRODUCT_JOB,
      { sku: 'INTEGRATION-SKU' },
      { jobId, removeOnComplete: false },
    );

    const execution = await waitForCompletion(executions, jobId);

    expect(monitorSku).toHaveBeenCalledWith('INTEGRATION-SKU');
    expect(execution.status).toBe('completed');
    expect(execution.attempt).toBe(1);
    expect(execution.completedAt).toBeInstanceOf(Date);
  }, 15_000);
});

async function waitForCompletion(
  executions: Model<QueueExecutionDocument>,
  jobId: string,
): Promise<QueueExecutionDocument> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const execution = await executions.findOne({ jobId }).exec();
    if (execution?.status === 'completed') return execution;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for queue execution ${jobId}`);
}
