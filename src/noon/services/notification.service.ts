import { Injectable, Logger } from '@nestjs/common';

export interface LeaderChangedNotificationInput {
  title: string;
  oldLeader: {
    sellerName: string;
    priceMinor: number;
    offerId: string;
  };
  newLeader: {
    sellerName: string;
    priceMinor: number;
    offerId: string;
  };
  url: string;
}

export interface TargetPriceHitNotificationInput {
  title: string;
  currentPriceMinor: number;
  targetPriceMinor: number | null;
  url: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  sendLeaderChangedNotification(
    userId: string,
    payload: LeaderChangedNotificationInput,
  ): void {
    this.logger.log(
      `Leader changed notification queued for ${userId}: ${payload.title}`,
    );
  }

  sendTargetPriceHitNotification(
    userId: string,
    payload: TargetPriceHitNotificationInput,
  ): void {
    this.logger.log(
      `Target price notification queued for ${userId}: ${payload.title}`,
    );
  }
}
