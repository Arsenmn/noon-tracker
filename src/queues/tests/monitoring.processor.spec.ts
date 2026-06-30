import { Job } from 'bullmq';
import { MonitoringProcessor } from '../monitoring.processor';
import {
  MONITOR_PRODUCT_JOB,
  MonitorProductJobData,
} from '../queues.constants';

describe('MonitoringProcessor', () => {
  interface AuditUpdate {
    $set: {
      status: string;
      attempt: number;
      lastError: string | null;
    };
    $setOnInsert: Record<string, unknown>;
  }
  type UpdateOne = (
    filter: { jobId: string },
    update: AuditUpdate,
    options: { upsert: boolean },
  ) => { exec: typeof executionUpdateExec };

  const monitorSku = jest.fn();
  const executionUpdateExec = jest.fn();
  const auditUpdates: AuditUpdate[] = [];
  const updateOneCall = jest.fn();
  const updateOne: UpdateOne = (filter, update, options) => {
    updateOneCall();
    expect(filter.jobId).toBe('monitor-N1-2');
    expect(options.upsert).toBe(true);
    auditUpdates.push(update);
    return { exec: executionUpdateExec };
  };

  const job = {
    id: 'monitor-N1-2',
    name: MONITOR_PRODUCT_JOB,
    data: { sku: 'N1' },
    attemptsMade: 0,
  } as Job<MonitorProductJobData>;

  const createProcessor = (): MonitoringProcessor =>
    new MonitoringProcessor({ monitorSku } as never, { updateOne } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    auditUpdates.length = 0;
    monitorSku.mockResolvedValue(undefined);
    executionUpdateExec.mockResolvedValue(undefined);
  });

  it('runs monitoring and records completion in MongoDB', async () => {
    await createProcessor().process(job);

    expect(monitorSku).toHaveBeenCalledWith('N1');
    expect(updateOneCall).toHaveBeenCalledTimes(2);
    const auditUpdate = auditUpdates.at(-1);
    expect(auditUpdate?.$set.status).toBe('completed');
    expect(auditUpdate?.$set.attempt).toBe(1);
  });

  it('records failure and rethrows so BullMQ can retry', async () => {
    monitorSku.mockRejectedValue(new Error('Noon unavailable'));

    await expect(createProcessor().process(job)).rejects.toThrow(
      'Noon unavailable',
    );

    const auditUpdate = auditUpdates.at(-1);
    expect(auditUpdate?.$set.status).toBe('failed');
    expect(auditUpdate?.$set.lastError).toBe('Noon unavailable');
  });
});
