import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { BotService } from './bot.service';

interface TestContext {
  from: { id: number };
  chat: { id: number };
  message: { text: string };
  reply: (message: string, extra?: unknown) => Promise<void>;
  answerCbQuery: (message?: string) => Promise<void>;
  match?: RegExpExecArray;
}

type Handler = (context: TestContext) => Promise<void>;

const handlers = new Map<string, Handler>();
const start = jest.fn((handler: Handler) => handlers.set('start', handler));
const command = jest.fn((name: string, handler: Handler) =>
  handlers.set(`command:${name}`, handler),
);
const action = jest.fn((name: string | RegExp, handler: Handler) => {
  const key =
    typeof name === 'string' ? `action:${name}` : `action-regex:${name.source}`;
  handlers.set(key, handler);
});
const on = jest.fn((event: string, handler: Handler) =>
  handlers.set(`on:${event}`, handler),
);
const catchError = jest.fn();
const setMyCommands = jest.fn();
const sendMessage = jest.fn();
const launch = jest.fn();
const stop = jest.fn();

jest.mock('telegraf', () => ({
  Telegraf: jest.fn().mockImplementation(() => ({
    start,
    command,
    action,
    on,
    catch: catchError,
    telegram: { setMyCommands, sendMessage },
    launch,
    stop,
  })),
  Markup: {
    inlineKeyboard: jest.fn((buttons: unknown) => ({ buttons })),
    button: {
      callback: jest.fn((label: string, data: string) => ({ label, data })),
    },
  },
}));

describe('BotService', () => {
  const extractOffersFromUrl = jest.fn();
  const selectLeader = jest.fn();
  const upsert = jest.fn();
  const findActiveForUser = jest.fn();
  const deactivateForUser = jest.fn();
  const leader = {
    offerId: 'offer-1',
    sellerId: 'seller-1',
    sellerName: 'Example seller',
    priceMinor: 9000,
    listPriceMinor: 10000,
    available: true,
  };
  const snapshot = {
    sku: 'N70164930V',
    title: 'Example product',
    canonicalUrl: 'https://www.noon.com/uae-en/example-product/N70164930V/p/',
    fetchedAt: '2026-06-29T00:00:00.000Z',
    context: {
      country: 'ae',
      locale: 'en-ae',
      zoneCode: 'AE_DXB-S14',
      currency: 'AED',
    },
    availability: 'available',
    offers: [leader],
  };

  const createService = (token?: string): BotService =>
    new BotService(
      new ConfigService(token ? { BOT_TOKEN: token } : {}),
      { extractOffersFromUrl } as never,
      { selectLeader },
      { upsert, findActiveForUser, deactivateForUser } as never,
    );

  const context = (text: string): TestContext => ({
    from: { id: 123 },
    chat: { id: 456 },
    message: { text },
    reply: jest
      .fn<(message: string, extra?: unknown) => Promise<void>>()
      .mockResolvedValue(undefined),
    answerCbQuery: jest
      .fn<(message?: string) => Promise<void>>()
      .mockResolvedValue(undefined),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    setMyCommands.mockResolvedValue(undefined);
    sendMessage.mockResolvedValue(undefined);
    launch.mockImplementation((onLaunch?: () => void) => {
      onLaunch?.();
      return Promise.resolve();
    });
    extractOffersFromUrl.mockResolvedValue(snapshot);
    selectLeader.mockReturnValue(leader);
    upsert.mockResolvedValue(undefined);
    findActiveForUser.mockResolvedValue([]);
    deactivateForUser.mockResolvedValue(true);
  });

  it('does not create a bot without a token', async () => {
    await createService().onModuleInit();
    expect(Telegraf).not.toHaveBeenCalled();
  });

  it('registers all handlers before launching the bot', async () => {
    await createService('token').onModuleInit();

    expect(start).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('help', expect.any(Function));
    expect(command).toHaveBeenCalledWith('cancel', expect.any(Function));
    expect(command).toHaveBeenCalledWith('list', expect.any(Function));
    expect(command).toHaveBeenCalledWith('stop', expect.any(Function));
    expect(action).toHaveBeenCalledWith(
      'tracking:skip-target',
      expect.any(Function),
    );
    expect(on).toHaveBeenCalledWith('text', expect.any(Function));
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(
      launch.mock.invocationCallOrder[0],
    );
  });

  it('lists active products with their desired prices', async () => {
    findActiveForUser.mockResolvedValue([
      {
        id: '507f1f77bcf86cd799439011',
        sku: 'N70164930V',
        title: 'Example product',
        targetPriceMinor: 94900,
      },
      {
        id: '507f1f77bcf86cd799439012',
        sku: 'N00000002A',
        title: null,
        targetPriceMinor: null,
      },
    ]);
    await createService('token').onModuleInit();
    const ctx = context('/list');

    await handlers.get('command:list')?.(ctx);

    expect(findActiveForUser).toHaveBeenCalledWith('123', '456');
    expect(ctx.reply).toHaveBeenCalledWith(
      [
        'Активные отслеживания:',
        '1. Example product',
        'SKU: N70164930V',
        'Цель: AED 949.00',
        '2. N00000002A',
        'SKU: N00000002A',
        'Цель: без целевой цены',
      ].join('\n'),
    );
  });

  it('shows a product picker and stops the selected subscription', async () => {
    const trackedProduct = {
      id: '507f1f77bcf86cd799439011',
      sku: 'N70164930V',
      title: 'Example product',
      targetPriceMinor: 94900,
    };
    findActiveForUser.mockResolvedValue([trackedProduct]);
    await createService('token').onModuleInit();
    const stopContext = context('/stop');

    await handlers.get('command:stop')?.(stopContext);

    expect(stopContext.reply).toHaveBeenCalledWith(
      'Выберите товар, который больше не нужно отслеживать:',
      expect.any(Object),
    );

    const callbackContext = context('');
    callbackContext.match = [
      `tracking:stop:${trackedProduct.id}`,
      trackedProduct.id,
    ] as unknown as RegExpExecArray;
    await handlers.get('action-regex:^tracking:stop:([a-f\\d]{24})$')?.(
      callbackContext,
    );

    expect(deactivateForUser).toHaveBeenCalledWith(
      trackedProduct.id,
      '123',
      '456',
    );
    expect(callbackContext.reply).toHaveBeenCalledWith(
      'Отслеживание остановлено: Example product.',
    );
  });

  it('stops a running bot during application shutdown', async () => {
    const service = createService('token');
    await service.onModuleInit();
    service.onApplicationShutdown('SIGTERM');
    expect(stop).toHaveBeenCalledWith('SIGTERM');
  });

  it('formats and sends leader-change notifications for queue workers', async () => {
    const service = createService('token');
    await service.onModuleInit();

    await service.sendLeaderChangedNotification('456', {
      title: 'Example product',
      oldSellerName: 'Old seller',
      newSellerName: 'New seller',
      newPriceMinor: 89999,
      url: snapshot.canonicalUrl,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      '456',
      expect.stringContaining('Новая минимальная цена: AED 899.99'),
      expect.objectContaining({
        link_preview_options: { is_disabled: true },
      }),
    );
  });

  it('checks a link and asks for an optional target price', async () => {
    await createService('token').onModuleInit();
    const ctx = context(
      'https://www.noon.com/uae-en/example-product/N70164930V/p/',
    );

    await handlers.get('on:text')?.(ctx);

    expect(extractOffersFromUrl).toHaveBeenCalledWith(ctx.message.text);
    expect(selectLeader).toHaveBeenCalledWith(snapshot.offers);
    expect(ctx.reply).toHaveBeenNthCalledWith(1, 'Проверяю товар…');
    expect(ctx.reply).toHaveBeenCalledWith(
      [
        'Example product',
        'SKU: N70164930V',
        'Текущий лидер: Example seller',
        'Цена: AED 90.00',
        'Доступных предложений: 1',
      ].join('\n'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      'Все доступные предложения:\n🏆 ЛИДЕР — Example seller — AED 90.00',
    );
    expect(ctx.reply).toHaveBeenLastCalledWith(
      'Введите желаемую цену в AED или выберите «Без цены».',
      expect.any(Object),
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('renders all available offers with the leader first and highlighted', async () => {
    const secondOffer = {
      ...leader,
      offerId: 'offer-2',
      sellerId: 'seller-2',
      sellerName: 'Second seller',
      priceMinor: 9500,
    };
    const unavailableOffer = {
      ...leader,
      offerId: 'offer-3',
      sellerId: 'seller-3',
      sellerName: 'Unavailable seller',
      priceMinor: 8000,
      available: false,
    };
    extractOffersFromUrl.mockResolvedValue({
      ...snapshot,
      offers: [secondOffer, unavailableOffer, leader],
    });
    await createService('token').onModuleInit();
    const ctx = context(
      'https://www.noon.com/uae-en/example-product/N70164930V/p/',
    );

    await handlers.get('on:text')?.(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      [
        'Все доступные предложения:',
        '🏆 ЛИДЕР — Example seller — AED 90.00',
        '2. Second seller — AED 95.00',
      ].join('\n'),
    );
    expect(ctx.reply).not.toHaveBeenCalledWith(
      expect.stringContaining('Unavailable seller'),
    );
  });

  it('renders product context when no offers are available', async () => {
    const unavailableOffer = { ...leader, available: false };
    extractOffersFromUrl.mockResolvedValue({
      ...snapshot,
      offers: [unavailableOffer],
      availability: 'no_available_offers',
    });
    selectLeader.mockReturnValue(null);
    await createService('token').onModuleInit();
    const ctx = context(
      'https://www.noon.com/uae-en/example-product/N70164930V/p/',
    );

    await handlers.get('on:text')?.(ctx);

    expect(ctx.reply).toHaveBeenLastCalledWith(
      'Example product\nSKU: N70164930V\nСейчас нет доступных предложений. Попробуйте позже.',
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('uses SKU as the heading when Noon does not return a title', async () => {
    extractOffersFromUrl.mockResolvedValue({ ...snapshot, title: null });
    await createService('token').onModuleInit();
    const ctx = context(
      'https://www.noon.com/uae-en/example-product/N70164930V/p/',
    );

    await handlers.get('on:text')?.(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining(
        'SKU: N70164930V\nТекущий лидер: Example seller\nЦена: AED 90.00',
      ),
    );
  });

  it('stores an exact target price without floating point calculations', async () => {
    await createService('token').onModuleInit();
    const linkContext = context(
      'https://www.noon.com/uae-en/example-product/N70164930V/p/',
    );
    await handlers.get('on:text')?.(linkContext);

    const priceContext = context('899.99');
    await handlers.get('on:text')?.(priceContext);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramUserId: '123',
        chatId: '456',
        sku: 'N70164930V',
        targetPriceMinor: 89999,
        currentLeaderOfferId: 'offer-1',
        currentLeaderSellerName: 'Example seller',
      }),
    );
    expect(priceContext.reply).toHaveBeenCalledWith(
      expect.stringContaining('Целевая цена: AED 899.99'),
    );
  });

  it('accepts a link and target price in one message', async () => {
    await createService('token').onModuleInit();
    const ctx = context(
      'https://www.noon.com/uae-en/example-product/N70164930V/p/ 90',
    );

    await handlers.get('on:text')?.(ctx);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ targetPriceMinor: 9000 }),
    );
  });

  it('stores a leader-only subscription when target price is skipped', async () => {
    await createService('token').onModuleInit();
    await handlers.get('on:text')?.(
      context('https://www.noon.com/uae-en/example-product/N70164930V/p/'),
    );
    const callbackContext = context('');

    await handlers.get('action:tracking:skip-target')?.(callbackContext);

    expect(callbackContext.answerCbQuery).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ targetPriceMinor: null }),
    );
  });

  it('renders target-price notifications with offer and threshold prices', async () => {
    const service = createService('token');
    await service.onModuleInit();

    await service.sendTargetPriceNotification('456', {
      title: 'Example product',
      sellerName: 'Example seller',
      offerPriceMinor: 89999,
      targetPriceMinor: 90000,
      url: snapshot.canonicalUrl,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      '456',
      [
        'Цена достигнута: Example product',
        'Example seller: AED 899.99',
        'Ваш порог: AED 900.00',
        snapshot.canonicalUrl,
      ].join('\n'),
      expect.objectContaining({
        link_preview_options: { is_disabled: true },
      }),
    );
  });

  it.each([
    [new BadRequestException(), 'Ссылка не распознана'],
    [new ServiceUnavailableException(), 'Noon сейчас недоступен'],
  ])('returns a useful client error for %s', async (error, message) => {
    extractOffersFromUrl.mockRejectedValue(error);
    await createService('token').onModuleInit();
    const ctx = context('not-a-link');

    await handlers.get('on:text')?.(ctx);

    expect(ctx.reply).toHaveBeenLastCalledWith(
      expect.stringContaining(message),
    );
  });
});
