import { Job } from 'bullmq';
import {
  NotificationEventPayload,
  SEND_NOTIFICATION_JOB,
} from '../queues.constants';
import { NotificationProcessor } from '../notification.processor';

interface StoredEvent {
  eventId: string;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  payload: NotificationEventPayload;
}

class FakeEventModel {
  constructor(public event: StoredEvent | null) {}

  findOne(): object {
    return { lean: () => ({ exec: () => Promise.resolve(this.event) }) };
  }

  findOneAndUpdate(): object {
    if (this.event) this.event.status = 'sending';
    return { lean: () => ({ exec: () => Promise.resolve(this.event) }) };
  }

  updateOne(
    ...args: [object, { $set?: { status?: StoredEvent['status'] } }]
  ): object {
    const update = args[1];
    if (this.event && update.$set?.status) {
      this.event.status = update.$set.status;
    }
    return { exec: () => Promise.resolve(undefined) };
  }
}

describe('NotificationProcessor', () => {
  const sendLeaderChangedNotification = jest.fn();
  const sendTargetPriceNotification = jest.fn();
  const advanceLeader = jest.fn();
  const setTargetPriceTriggered = jest.fn();

  const leaderPayload: NotificationEventPayload = {
    type: 'leader-changed',
    subscriptionId: 'subscription-1',
    chatId: '456',
    leaderOfferId: 'offer-new',
    leaderSellerName: 'New seller',
    notification: {
      title: 'Example product',
      oldSellerName: 'Old seller',
      newSellerName: 'New seller',
      newPriceMinor: 94900,
      url: 'https://www.noon.com/uae-en/example/N1/p/',
    },
  };
  const job = {
    id: 'leader-subscription-1-1-offer-new',
    name: SEND_NOTIFICATION_JOB,
    data: { eventId: 'leader-subscription-1-1-offer-new' },
  } as unknown as Job<{ eventId: string }>;

  const createProcessor = (model: FakeEventModel): NotificationProcessor =>
    new NotificationProcessor(
      { sendLeaderChangedNotification, sendTargetPriceNotification } as never,
      { advanceLeader, setTargetPriceTriggered } as never,
      model as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    sendLeaderChangedNotification.mockResolvedValue(undefined);
    sendTargetPriceNotification.mockResolvedValue(undefined);
    advanceLeader.mockResolvedValue(undefined);
    setTargetPriceTriggered.mockResolvedValue(undefined);
  });

  it('sends once, advances subscription state, and marks the event sent', async () => {
    const model = new FakeEventModel({
      eventId: job.data.eventId,
      status: 'queued',
      payload: leaderPayload,
    });

    await createProcessor(model).process(job);

    expect(sendLeaderChangedNotification).toHaveBeenCalledWith(
      '456',
      leaderPayload.notification,
    );
    expect(advanceLeader).toHaveBeenCalledWith(
      'subscription-1',
      'offer-new',
      'New seller',
    );
    expect(model.event?.status).toBe('sent');
  });

  it('does not send an event already marked sent', async () => {
    const model = new FakeEventModel({
      eventId: job.data.eventId,
      status: 'sent',
      payload: leaderPayload,
    });

    await createProcessor(model).process(job);

    expect(sendLeaderChangedNotification).not.toHaveBeenCalled();
    expect(advanceLeader).not.toHaveBeenCalled();
  });

  it('marks a failed send for BullMQ retry', async () => {
    const model = new FakeEventModel({
      eventId: job.data.eventId,
      status: 'queued',
      payload: leaderPayload,
    });
    sendLeaderChangedNotification.mockRejectedValue(
      new Error('Telegram unavailable'),
    );

    await expect(createProcessor(model).process(job)).rejects.toThrow(
      'Telegram unavailable',
    );

    expect(model.event?.status).toBe('failed');
    expect(advanceLeader).not.toHaveBeenCalled();
  });
});
