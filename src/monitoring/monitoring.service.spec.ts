import { MonitoringService } from './monitoring.service';

describe('MonitoringService', () => {
  const extractOffersFromUrl = jest.fn();
  const selectLeader = jest.fn();
  const selectOfferAtOrBelow = jest.fn();
  const findActive = jest.fn();
  const setLastLeader = jest.fn();
  const rearmTargetPrice = jest.fn();
  const publish = jest.fn();
  const snapshotUpdateExec = jest.fn();
  const updateOne = jest.fn(() => ({ exec: snapshotUpdateExec }));

  const leader = {
    offerId: 'offer-new',
    sellerId: 'seller-new',
    sellerName: 'New seller',
    priceMinor: 94900,
    listPriceMinor: 100000,
    available: true,
  };
  const snapshot = {
    sku: 'N70164930V',
    title: 'Example product',
    canonicalUrl: 'https://www.noon.com/uae-en/example/N70164930V/p/',
    fetchedAt: '2026-06-30T00:00:00.000Z',
    context: {
      country: 'ae',
      locale: 'en-ae',
      zoneCode: 'AE_DXB-S14',
      currency: 'AED',
    },
    availability: 'available',
    offers: [leader],
  };

  const subscription = (overrides: Record<string, unknown> = {}) => ({
    id: 'subscription-1',
    telegramUserId: '123',
    chatId: '456',
    sku: 'N70164930V',
    canonicalUrl: snapshot.canonicalUrl,
    title: snapshot.title,
    targetPriceMinor: null,
    targetPriceTriggered: false,
    lastLeaderOfferId: 'offer-old',
    lastLeaderSellerName: 'Old seller',
    leaderChangeVersion: 0,
    targetPriceCycle: 0,
    ...overrides,
  });

  const createService = (): MonitoringService =>
    new MonitoringService(
      { extractOffersFromUrl } as never,
      { selectLeader, selectOfferAtOrBelow },
      {
        findActive,
        setLastLeader,
        rearmTargetPrice,
      } as never,
      { publish } as never,
      { updateOne } as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    extractOffersFromUrl.mockResolvedValue(snapshot);
    selectLeader.mockReturnValue(leader);
    selectOfferAtOrBelow.mockReturnValue(leader);
    snapshotUpdateExec.mockResolvedValue(undefined);
    setLastLeader.mockResolvedValue(undefined);
    rearmTargetPrice.mockResolvedValue(undefined);
    publish.mockResolvedValue(undefined);
  });

  it('fetches one SKU once and evaluates leader and exact target per user', async () => {
    findActive.mockResolvedValue([
      subscription(),
      subscription({
        id: 'subscription-2',
        chatId: '789',
        targetPriceMinor: 94900,
        lastLeaderOfferId: 'offer-new',
        lastLeaderSellerName: 'New seller',
      }),
    ]);

    await createService().runCycle();

    expect(extractOffersFromUrl).toHaveBeenCalledTimes(1);
    expect(extractOffersFromUrl).toHaveBeenCalledWith(snapshot.canonicalUrl);
    expect(publish).toHaveBeenCalledWith('leader-subscription-1-1-offer-new', {
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
        url: snapshot.canonicalUrl,
      },
    });
    expect(publish).toHaveBeenCalledWith('target-subscription-2-0-94900', {
      type: 'target-price',
      subscriptionId: 'subscription-2',
      chatId: '789',
      notification: {
        title: 'Example product',
        sellerName: 'New seller',
        offerPriceMinor: 94900,
        targetPriceMinor: 94900,
        url: snapshot.canonicalUrl,
      },
    });
  });

  it('does not repeat an alert while price remains at or below target', async () => {
    findActive.mockResolvedValue([
      subscription({
        targetPriceMinor: 94900,
        targetPriceTriggered: true,
        lastLeaderOfferId: 'offer-new',
      }),
    ]);

    await createService().runCycle();

    expect(publish).not.toHaveBeenCalled();
    expect(rearmTargetPrice).not.toHaveBeenCalled();
  });

  it('rearms target notification after all offers rise above target', async () => {
    const expensiveLeader = { ...leader, priceMinor: 95000 };
    extractOffersFromUrl.mockResolvedValue({
      ...snapshot,
      offers: [expensiveLeader],
    });
    selectLeader.mockReturnValue(expensiveLeader);
    selectOfferAtOrBelow.mockReturnValue(null);
    findActive.mockResolvedValue([
      subscription({
        targetPriceMinor: 94900,
        targetPriceTriggered: true,
        lastLeaderOfferId: 'offer-new',
      }),
    ]);

    await createService().runCycle();

    expect(rearmTargetPrice).toHaveBeenCalledWith('subscription-1');
    expect(publish).not.toHaveBeenCalled();
  });

  it('stores the first leader as a baseline without notifying', async () => {
    findActive.mockResolvedValue([
      subscription({
        lastLeaderOfferId: null,
        lastLeaderSellerName: null,
      }),
    ]);

    await createService().runCycle();

    expect(publish).not.toHaveBeenCalled();
    expect(setLastLeader).toHaveBeenCalledWith(
      'subscription-1',
      'offer-new',
      'New seller',
    );
  });
});
