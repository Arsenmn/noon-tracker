import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  TrackingSubscription,
  TrackingSubscriptionDocument,
} from './tracking-subscription.schema';

export interface UpsertTrackingSubscriptionInput {
  telegramUserId: string;
  chatId: string;
  sku: string;
  canonicalUrl: string;
  title: string | null;
  targetPriceMinor: number | null;
  currentLeaderOfferId: string;
  currentLeaderSellerName: string;
}

export interface ActiveTrackingSubscription {
  id: string;
  telegramUserId: string;
  chatId: string;
  sku: string;
  canonicalUrl: string;
  title: string | null;
  targetPriceMinor: number | null;
  targetPriceTriggered: boolean;
  lastLeaderOfferId: string | null;
  lastLeaderSellerName: string | null;
  leaderChangeVersion: number;
  targetPriceCycle: number;
}

export interface UserTrackingSubscription {
  id: string;
  sku: string;
  title: string | null;
  targetPriceMinor: number | null;
}

@Injectable()
export class TrackingSubscriptionService {
  constructor(
    @InjectModel(TrackingSubscription.name)
    private readonly subscriptions: Model<TrackingSubscriptionDocument>,
  ) {}

  async upsert(input: UpsertTrackingSubscriptionInput): Promise<void> {
    const existing = await this.subscriptions
      .findOne({
        telegramUserId: input.telegramUserId,
        chatId: input.chatId,
        sku: input.sku,
      })
      .select({ targetPriceMinor: 1 })
      .lean()
      .exec();
    const targetChanged =
      !existing || existing.targetPriceMinor !== input.targetPriceMinor;

    await this.subscriptions
      .updateOne(
        {
          telegramUserId: input.telegramUserId,
          chatId: input.chatId,
          sku: input.sku,
        },
        {
          $set: {
            canonicalUrl: input.canonicalUrl,
            title: input.title,
            targetPriceMinor: input.targetPriceMinor,
            isActive: true,
            lastLeaderOfferId: input.currentLeaderOfferId,
            lastLeaderSellerName: input.currentLeaderSellerName,
            ...(targetChanged ? { targetPriceTriggered: false } : {}),
          },
          $setOnInsert: {
            telegramUserId: input.telegramUserId,
            chatId: input.chatId,
            sku: input.sku,
          },
        },
        { upsert: true },
      )
      .exec();
  }

  async findActive(): Promise<ActiveTrackingSubscription[]> {
    const subscriptions = await this.subscriptions
      .find({ isActive: true })
      .select({
        telegramUserId: 1,
        chatId: 1,
        sku: 1,
        canonicalUrl: 1,
        title: 1,
        targetPriceMinor: 1,
        targetPriceTriggered: 1,
        lastLeaderOfferId: 1,
        lastLeaderSellerName: 1,
        leaderChangeVersion: 1,
        targetPriceCycle: 1,
      })
      .lean()
      .exec();

    return subscriptions.map((subscription) => ({
      id: String(subscription._id),
      telegramUserId: subscription.telegramUserId,
      chatId: subscription.chatId,
      sku: subscription.sku,
      canonicalUrl: subscription.canonicalUrl,
      title: subscription.title,
      targetPriceMinor: subscription.targetPriceMinor,
      targetPriceTriggered: subscription.targetPriceTriggered ?? false,
      lastLeaderOfferId: subscription.lastLeaderOfferId ?? null,
      lastLeaderSellerName: subscription.lastLeaderSellerName ?? null,
      leaderChangeVersion: subscription.leaderChangeVersion ?? 0,
      targetPriceCycle: subscription.targetPriceCycle ?? 0,
    }));
  }

  async findActiveBySku(sku: string): Promise<ActiveTrackingSubscription[]> {
    const subscriptions = await this.subscriptions
      .find({ sku, isActive: true })
      .select({
        telegramUserId: 1,
        chatId: 1,
        sku: 1,
        canonicalUrl: 1,
        title: 1,
        targetPriceMinor: 1,
        targetPriceTriggered: 1,
        lastLeaderOfferId: 1,
        lastLeaderSellerName: 1,
        leaderChangeVersion: 1,
        targetPriceCycle: 1,
      })
      .lean()
      .exec();

    return subscriptions.map((subscription) => ({
      id: String(subscription._id),
      telegramUserId: subscription.telegramUserId,
      chatId: subscription.chatId,
      sku: subscription.sku,
      canonicalUrl: subscription.canonicalUrl,
      title: subscription.title,
      targetPriceMinor: subscription.targetPriceMinor,
      targetPriceTriggered: subscription.targetPriceTriggered ?? false,
      lastLeaderOfferId: subscription.lastLeaderOfferId ?? null,
      lastLeaderSellerName: subscription.lastLeaderSellerName ?? null,
      leaderChangeVersion: subscription.leaderChangeVersion ?? 0,
      targetPriceCycle: subscription.targetPriceCycle ?? 0,
    }));
  }

  async setLastLeader(
    id: string,
    offerId: string,
    sellerName: string,
  ): Promise<void> {
    await this.subscriptions
      .updateOne(
        { _id: id },
        {
          $set: {
            lastLeaderOfferId: offerId,
            lastLeaderSellerName: sellerName,
          },
        },
      )
      .exec();
  }

  async setTargetPriceTriggered(id: string, triggered: boolean): Promise<void> {
    await this.subscriptions
      .updateOne({ _id: id }, { $set: { targetPriceTriggered: triggered } })
      .exec();
  }

  async advanceLeader(
    id: string,
    offerId: string,
    sellerName: string,
  ): Promise<void> {
    await this.subscriptions
      .updateOne(
        { _id: id },
        {
          $set: {
            lastLeaderOfferId: offerId,
            lastLeaderSellerName: sellerName,
          },
          $inc: { leaderChangeVersion: 1 },
        },
      )
      .exec();
  }

  async rearmTargetPrice(id: string): Promise<void> {
    await this.subscriptions
      .updateOne(
        { _id: id, targetPriceTriggered: true },
        {
          $set: { targetPriceTriggered: false },
          $inc: { targetPriceCycle: 1 },
        },
      )
      .exec();
  }

  async findActiveForUser(
    telegramUserId: string,
    chatId: string,
  ): Promise<UserTrackingSubscription[]> {
    const subscriptions = await this.subscriptions
      .find({ telegramUserId, chatId, isActive: true })
      .select({ sku: 1, title: 1, targetPriceMinor: 1 })
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec();

    return subscriptions.map((subscription) => ({
      id: String(subscription._id),
      sku: subscription.sku,
      title: subscription.title ?? null,
      targetPriceMinor: subscription.targetPriceMinor ?? null,
    }));
  }

  async deactivateForUser(
    id: string,
    telegramUserId: string,
    chatId: string,
  ): Promise<boolean> {
    const result = await this.subscriptions
      .updateOne(
        { _id: id, telegramUserId, chatId, isActive: true },
        { $set: { isActive: false } },
      )
      .exec();
    return result.modifiedCount === 1;
  }
}
