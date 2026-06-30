import { ConfigService } from '@nestjs/config';
import { MONITOR_PRODUCT_JOB } from '../queues.constants';
import { QueuesService } from '../queues.service';

describe('QueuesService', () => {
  const add = jest.fn();
  const findActive = jest.fn();
  const executionUpdateExec = jest.fn();
  const updateOne = jest.fn(() => ({ exec: executionUpdateExec }));

  const createService = (): QueuesService =>
    new QueuesService(
      { add } as never,
      { findActive } as never,
      new ConfigService({
        MONITORING_JOB_ATTEMPTS: 4,
        MONITORING_JOB_BACKOFF_MS: 2_000,
      }),
      { updateOne } as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(120_000);
    add.mockResolvedValue(undefined);
    executionUpdateExec.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enqueues one retryable job per unique active SKU each minute', async () => {
    findActive.mockResolvedValue([{ sku: 'N1' }, { sku: 'N1' }, { sku: 'N2' }]);

    await createService().enqueueActiveProducts();

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      MONITOR_PRODUCT_JOB,
      { sku: 'N1' },
      expect.objectContaining({
        jobId: 'monitor-N1-2',
        attempts: 4,
        backoff: { type: 'exponential', delay: 2_000 },
      }),
    );
    expect(add).toHaveBeenCalledWith(
      MONITOR_PRODUCT_JOB,
      { sku: 'N2' },
      expect.objectContaining({ jobId: 'monitor-N2-2' }),
    );
    expect(updateOne).toHaveBeenCalledTimes(2);
  });

  it('does not enqueue jobs when there are no active subscriptions', async () => {
    findActive.mockResolvedValue([]);

    await createService().enqueueActiveProducts();

    expect(add).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });
});
