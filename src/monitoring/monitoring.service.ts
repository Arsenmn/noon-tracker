import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ActiveTrackingSubscription,
  TrackingSubscriptionService,
} from '../bot/tracking-subscription.service';
import { NoonClientService } from '../noon/services/noon-client.service';
import { NoonService } from '../noon/services/noon.service';
import { NoonProductSnapshot, NormalizedNoonOffer } from '../noon/noon.types';
import { NotificationQueuePublisher } from '../queues/notification-queue.publisher';
import {
  MonitoredProduct,
  MonitoredProductDocument,
} from './monitored-product.schema';

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly noonClient: NoonClientService,
    private readonly noonService: NoonService,
    private readonly subscriptions: TrackingSubscriptionService,
    private readonly notifications: NotificationQueuePublisher,
    @InjectModel(MonitoredProduct.name)
    private readonly products: Model<MonitoredProductDocument>,
  ) {}

  async runCycle(): Promise<void> {
    const activeSubscriptions = await this.subscriptions.findActive();
    const subscriptionsBySku = this.groupBySku(activeSubscriptions);

    for (const [sku, skuSubscriptions] of subscriptionsBySku) {
      try {
        await this.processSku(skuSubscriptions);
      } catch (error: unknown) {
        this.logger.error(
          `Monitoring failed sku=${sku} reason=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async monitorSku(sku: string): Promise<void> {
    const subscriptions = await this.subscriptions.findActiveBySku(sku);
    if (subscriptions.length === 0) {
      this.logger.log(`Skipping inactive SKU ${sku}`);
      return;
    }
    await this.processSku(subscriptions);
  }

  private groupBySku(
    subscriptions: ActiveTrackingSubscription[],
  ): Map<string, ActiveTrackingSubscription[]> {
    const result = new Map<string, ActiveTrackingSubscription[]>();
    for (const subscription of subscriptions) {
      const existing = result.get(subscription.sku) ?? [];
      existing.push(subscription);
      result.set(subscription.sku, existing);
    }
    return result;
  }

  private async processSku(
    subscriptions: ActiveTrackingSubscription[],
  ): Promise<void> {
    const snapshot = await this.noonClient.extractOffersFromUrl(
      subscriptions[0].canonicalUrl,
    );
    await this.saveSnapshot(snapshot);

    const leader = this.noonService.selectLeader(snapshot.offers);
    if (!leader) {
      return;
    }

    for (const subscription of subscriptions) {
      await this.compareSubscription(subscription, snapshot, leader);
    }
  }

  private async compareSubscription(
    subscription: ActiveTrackingSubscription,
    snapshot: NoonProductSnapshot,
    leader: NormalizedNoonOffer,
  ): Promise<void> {
    await this.compareLeader(subscription, snapshot, leader);
    await this.compareTargetPrice(subscription, snapshot);
  }

  private async compareLeader(
    subscription: ActiveTrackingSubscription,
    snapshot: NoonProductSnapshot,
    leader: NormalizedNoonOffer,
  ): Promise<void> {
    if (subscription.lastLeaderOfferId === null) {
      await this.subscriptions.setLastLeader(
        subscription.id,
        leader.offerId,
        leader.sellerName,
      );
      return;
    }
    if (subscription.lastLeaderOfferId === leader.offerId) {
      return;
    }

    const eventId = `leader-${subscription.id}-${subscription.leaderChangeVersion + 1}-${leader.offerId}`;
    await this.notifications.publish(eventId, {
      type: 'leader-changed',
      subscriptionId: subscription.id,
      chatId: subscription.chatId,
      leaderOfferId: leader.offerId,
      leaderSellerName: leader.sellerName,
      notification: {
        title: snapshot.title?.trim() || snapshot.sku,
        oldSellerName:
          subscription.lastLeaderSellerName ?? 'Предыдущий продавец',
        newSellerName: leader.sellerName,
        newPriceMinor: leader.priceMinor,
        url: snapshot.canonicalUrl,
      },
    });
  }

  private async compareTargetPrice(
    subscription: ActiveTrackingSubscription,
    snapshot: NoonProductSnapshot,
  ): Promise<void> {
    if (subscription.targetPriceMinor === null) {
      return;
    }

    const matchingOffer = snapshot.offers
      .filter(
        (offer) =>
          offer.available &&
          offer.priceMinor <= (subscription.targetPriceMinor as number),
      )
      .sort(
        (left, right) =>
          left.priceMinor - right.priceMinor ||
          left.offerId.localeCompare(right.offerId),
      )[0];

    if (!matchingOffer) {
      if (subscription.targetPriceTriggered) {
        await this.subscriptions.rearmTargetPrice(subscription.id);
      }
      return;
    }
    if (subscription.targetPriceTriggered) {
      return;
    }

    const eventId = `target-${subscription.id}-${subscription.targetPriceCycle}-${subscription.targetPriceMinor}`;
    await this.notifications.publish(eventId, {
      type: 'target-price',
      subscriptionId: subscription.id,
      chatId: subscription.chatId,
      notification: {
        title: snapshot.title?.trim() || snapshot.sku,
        sellerName: matchingOffer.sellerName,
        offerPriceMinor: matchingOffer.priceMinor,
        targetPriceMinor: subscription.targetPriceMinor,
        url: snapshot.canonicalUrl,
      },
    });
  }

  private async saveSnapshot(snapshot: NoonProductSnapshot): Promise<void> {
    await this.products
      .updateOne(
        { sku: snapshot.sku },
        {
          $set: {
            canonicalUrl: snapshot.canonicalUrl,
            title: snapshot.title,
            availability: snapshot.availability,
            offers: snapshot.offers,
            lastSuccessfulCheckAt: new Date(snapshot.fetchedAt),
          },
          $setOnInsert: { sku: snapshot.sku },
        },
        { upsert: true },
      )
      .exec();
  }
}
