import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, Markup, Telegraf } from 'telegraf';
import { NoonClientService } from '../noon/services/noon-client.service';
import { NoonService } from '../noon/services/noon.service';
import { NoonProductSnapshot, NormalizedNoonOffer } from '../noon/noon.types';
import {
  chunkLines,
  currentOfferSummary,
  formatPrice,
  noonErrorMessage,
  offerListMessages,
  parseTargetPriceMinor,
  productHeading,
} from './bot-presenter';
import { TrackingSubscriptionService } from './tracking-subscription.service';

const START_MESSAGE =
  'Отправьте ссылку на товар с noon.com/uae-en. После проверки я предложу указать желаемую цену — это необязательно.';
const HELP_MESSAGE = [
  '1. Отправьте ссылку на товар Noon UAE.',
  '2. Укажите желаемую цену в AED или нажмите «Без цены».',
  '3. Я сообщу о смене самого дешёвого продавца и, если задана цена, о достижении порога.',
  '',
  'Можно отправить ссылку и цену одним сообщением: <ссылка> 899.99',
  'Команда /cancel отменяет текущий ввод.',
  'Команда /list показывает активные отслеживания.',
  'Команда /stop позволяет выбрать товар и остановить отслеживание.',
].join('\n');
const SKIP_TARGET_CALLBACK = 'tracking:skip-target';
const STOP_TRACKING_CALLBACK = /^tracking:stop:([a-f\d]{24})$/i;

interface PendingProduct {
  snapshot: NoonProductSnapshot;
  leader: NormalizedNoonOffer;
}

interface ConversationState {
  pendingProduct?: PendingProduct;
  requestSequence: number;
}

interface TelegramIdentity {
  telegramUserId: string;
  chatId: string;
}

export interface LeaderChangedTelegramNotification {
  title: string;
  oldSellerName: string;
  newSellerName: string;
  newPriceMinor: number;
  url: string;
}

export interface TargetPriceTelegramNotification {
  title: string;
  sellerName: string;
  offerPriceMinor: number;
  targetPriceMinor: number;
  url: string;
}

@Injectable()
export class BotService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BotService.name);
  private readonly conversations = new Map<string, ConversationState>();
  private bot?: Telegraf<Context>;
  private isRunning = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly noonClient: NoonClientService,
    private readonly noonService: NoonService,
    private readonly subscriptions: TrackingSubscriptionService,
  ) {}

  async onModuleInit(): Promise<void> {
    const token = this.configService.get<string>('BOT_TOKEN');
    if (!token) {
      this.logger.warn('BOT_TOKEN не задан, Telegram бот не будет запущен');
      return;
    }

    this.bot = new Telegraf(token);
    this.registerHandlers(this.bot);

    try {
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: 'Начать отслеживание' },
        { command: 'help', description: 'Как пользоваться ботом' },
        { command: 'cancel', description: 'Отменить текущий ввод' },
        { command: 'list', description: 'Мои отслеживаемые товары' },
        { command: 'stop', description: 'Остановить отслеживание' },
      ]);
      void this.bot
        .launch(() => {
          this.isRunning = true;
          this.logger.log('Telegram-бот запущен');
        })
        .catch((error: unknown) => {
          this.isRunning = false;
          this.logTelegramError('launch', error);
        });
    } catch (error: unknown) {
      this.logTelegramError('configuration', error);
      throw error;
    }
  }

  onApplicationShutdown(signal?: string): void {
    if (!this.bot || !this.isRunning) {
      return;
    }
    this.bot.stop(signal ?? 'application shutdown');
    this.isRunning = false;
  }

  async sendMessage(chatId: string, message: string): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot is not configured');
    }
    try {
      await this.bot.telegram.sendMessage(chatId, message, {
        link_preview_options: { is_disabled: true },
      });
    } catch (error: unknown) {
      this.logTelegramError(`send chatId=${chatId}`, error);
      throw error;
    }
  }

  async sendLeaderChangedNotification(
    chatId: string,
    notification: LeaderChangedTelegramNotification,
  ): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        `Сменился лидер: ${notification.title}`,
        `${notification.oldSellerName} → ${notification.newSellerName}`,
        `Новая минимальная цена: ${formatPrice(notification.newPriceMinor)}`,
        notification.url,
      ].join('\n'),
    );
  }

  async sendTargetPriceNotification(
    chatId: string,
    notification: TargetPriceTelegramNotification,
  ): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        `Цена достигнута: ${notification.title}`,
        `${notification.sellerName}: ${formatPrice(notification.offerPriceMinor)}`,
        `Ваш порог: ${formatPrice(notification.targetPriceMinor)}`,
        notification.url,
      ].join('\n'),
    );
  }

  private registerHandlers(bot: Telegraf<Context>): void {
    bot.start(async (context) => {
      this.resetConversation(context);
      await context.reply(START_MESSAGE);
    });

    bot.command('help', async (context) => context.reply(HELP_MESSAGE));
    bot.command('cancel', async (context) => {
      this.resetConversation(context);
      await context.reply('Текущий ввод отменён. Отправьте ссылку на товар.');
    });
    bot.command('list', async (context) => {
      await this.showTrackedProducts(context);
    });
    bot.command('stop', async (context) => {
      await this.showStopTrackingPicker(context);
    });

    bot.action(SKIP_TARGET_CALLBACK, async (context) => {
      await context.answerCbQuery();
      const identity = this.getIdentity(context);
      if (!identity) {
        await context.reply(
          'Не удалось определить пользователя. Нажмите /start.',
        );
        return;
      }
      await this.completeSubscription(context, identity, null);
    });

    bot.action(STOP_TRACKING_CALLBACK, async (context) => {
      const identity = this.getIdentity(context);
      if (!identity) {
        await context.answerCbQuery();
        await context.reply(
          'Не удалось определить пользователя. Нажмите /start.',
        );
        return;
      }

      const subscriptionId = context.match[1];
      const activeSubscriptions = await this.subscriptions.findActiveForUser(
        identity.telegramUserId,
        identity.chatId,
      );
      const selected = activeSubscriptions.find(
        (subscription) => subscription.id === subscriptionId,
      );
      const stopped = await this.subscriptions.deactivateForUser(
        subscriptionId,
        identity.telegramUserId,
        identity.chatId,
      );
      await context.answerCbQuery();
      if (!stopped) {
        await context.reply('Это отслеживание уже остановлено.');
        return;
      }
      await context.reply(
        `Отслеживание остановлено: ${selected?.title?.trim() || selected?.sku || subscriptionId}.`,
      );
    });

    bot.on('text', async (context) => this.handleText(context));
    bot.catch((error, context) => {
      this.logTelegramError(`update=${context.update.update_id}`, error);
    });
  }

  private async handleText(
    context: Context & { message: { text: string } },
  ): Promise<void> {
    const identity = this.getIdentity(context);
    if (!identity) {
      await context.reply(
        'Не удалось определить пользователя. Нажмите /start.',
      );
      return;
    }

    const key = this.conversationKey(identity);
    const state = this.conversations.get(key);
    const text = context.message.text.trim();
    if (state?.pendingProduct) {
      const targetPriceMinor = parseTargetPriceMinor(text);
      if (targetPriceMinor === null) {
        await context.reply('Введите цену в AED, например 899 или 899.99.');
        return;
      }
      await this.completeSubscription(context, identity, targetPriceMinor);
      return;
    }

    const [productUrl, targetText, ...extra] = text.split(/\s+/);
    if (!productUrl || extra.length > 0) {
      await context.reply(
        'Отправьте ссылку и, при желании, одну цену: <ссылка> 899.99',
      );
      return;
    }
    const targetPriceMinor = targetText
      ? parseTargetPriceMinor(targetText)
      : undefined;
    if (targetText && targetPriceMinor === null) {
      await context.reply('Цена должна быть в AED, например 899 или 899.99.');
      return;
    }

    const requestSequence = (state?.requestSequence ?? 0) + 1;
    this.conversations.set(key, { requestSequence });
    await context.reply('Проверяю товар…');

    try {
      const snapshot = await this.noonClient.extractOffersFromUrl(productUrl);
      if (this.conversations.get(key)?.requestSequence !== requestSequence) {
        return;
      }
      const leader = this.noonService.selectLeader(snapshot.offers);
      if (!leader) {
        this.conversations.delete(key);
        await context.reply(
          `${productHeading(snapshot)}\nСейчас нет доступных предложений. Попробуйте позже.`,
        );
        return;
      }

      this.conversations.set(key, {
        requestSequence,
        pendingProduct: { snapshot, leader },
      });
      if (targetPriceMinor !== undefined) {
        await this.completeSubscription(context, identity, targetPriceMinor);
        return;
      }

      await context.reply(currentOfferSummary(snapshot, leader));
      for (const offerListMessage of offerListMessages(snapshot, leader)) {
        await context.reply(offerListMessage);
      }
      await context.reply(
        'Введите желаемую цену в AED или выберите «Без цены».',
        Markup.inlineKeyboard([
          Markup.button.callback('Без цены', SKIP_TARGET_CALLBACK),
        ]),
      );
    } catch (error: unknown) {
      this.conversations.delete(key);
      this.logNoonError(identity, error);
      await context.reply(noonErrorMessage(error));
    }
  }

  private async showTrackedProducts(context: Context): Promise<void> {
    const identity = this.getIdentity(context);
    if (!identity) {
      await context.reply(
        'Не удалось определить пользователя. Нажмите /start.',
      );
      return;
    }
    const subscriptions = await this.subscriptions.findActiveForUser(
      identity.telegramUserId,
      identity.chatId,
    );
    if (subscriptions.length === 0) {
      await context.reply('У вас нет активных отслеживаний.');
      return;
    }

    const lines = subscriptions.map((subscription, index) => {
      const name = subscription.title?.trim() || subscription.sku;
      const target =
        subscription.targetPriceMinor === null
          ? 'без целевой цены'
          : formatPrice(subscription.targetPriceMinor);
      return `${index + 1}. ${name}\nSKU: ${subscription.sku}\nЦель: ${target}`;
    });
    for (const message of chunkLines('Активные отслеживания:', lines)) {
      await context.reply(message);
    }
  }

  private async showStopTrackingPicker(context: Context): Promise<void> {
    const identity = this.getIdentity(context);
    if (!identity) {
      await context.reply(
        'Не удалось определить пользователя. Нажмите /start.',
      );
      return;
    }
    const subscriptions = await this.subscriptions.findActiveForUser(
      identity.telegramUserId,
      identity.chatId,
    );
    if (subscriptions.length === 0) {
      await context.reply('У вас нет активных отслеживаний.');
      return;
    }

    const rows = subscriptions.map((subscription) => {
      const name = subscription.title?.trim() || subscription.sku;
      const target =
        subscription.targetPriceMinor === null
          ? 'без цены'
          : formatPrice(subscription.targetPriceMinor);
      const label = `${name} — ${target}`;
      return [
        Markup.button.callback(
          label.length > 55 ? `${label.slice(0, 52)}…` : label,
          `tracking:stop:${subscription.id}`,
        ),
      ];
    });
    await context.reply(
      'Выберите товар, который больше не нужно отслеживать:',
      Markup.inlineKeyboard(rows),
    );
  }

  private async completeSubscription(
    context: Context,
    identity: TelegramIdentity,
    targetPriceMinor: number | null,
  ): Promise<void> {
    const key = this.conversationKey(identity);
    const pending = this.conversations.get(key)?.pendingProduct;
    if (!pending) {
      await context.reply('Сначала отправьте ссылку на товар.');
      return;
    }

    try {
      await this.subscriptions.upsert({
        ...identity,
        sku: pending.snapshot.sku,
        canonicalUrl: pending.snapshot.canonicalUrl,
        title: pending.snapshot.title,
        targetPriceMinor,
        currentLeaderOfferId: pending.leader.offerId,
        currentLeaderSellerName: pending.leader.sellerName,
      });
      this.conversations.delete(key);
      const target =
        targetPriceMinor === null
          ? 'Без целевой цены.'
          : `Целевая цена: ${formatPrice(targetPriceMinor)}.`;
      await context.reply(
        `Отслеживание включено.\n${currentOfferSummary(pending.snapshot, pending.leader)}\n${target}`,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Subscription save failed sku=${pending.snapshot.sku} chatId=${identity.chatId}`,
        error instanceof Error ? error.stack : String(error),
      );
      await context.reply(
        'Не удалось сохранить отслеживание. Повторите попытку позже.',
      );
    }
  }

  private getIdentity(context: Context): TelegramIdentity | null {
    if (!context.from || !context.chat) {
      return null;
    }
    return {
      telegramUserId: String(context.from.id),
      chatId: String(context.chat.id),
    };
  }

  private resetConversation(context: Context): void {
    const identity = this.getIdentity(context);
    if (identity) {
      this.conversations.delete(this.conversationKey(identity));
    }
  }

  private conversationKey(identity: TelegramIdentity): string {
    return `${identity.chatId}:${identity.telegramUserId}`;
  }

  private logNoonError(identity: TelegramIdentity, error: unknown): void {
    this.logger.warn(
      `Noon product check failed chatId=${identity.chatId} type=${error instanceof Error ? error.constructor.name : 'unknown'} reason=${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private logTelegramError(operation: string, error: unknown): void {
    this.logger.error(
      `Telegram ${operation} failed`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
