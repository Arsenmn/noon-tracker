export const PRODUCT_MONITORING_QUEUE = 'product-monitoring';
export const MONITOR_PRODUCT_JOB = 'monitor-product';
export const TELEGRAM_NOTIFICATION_QUEUE = 'telegram-notifications';
export const SEND_NOTIFICATION_JOB = 'send-notification';

export interface MonitorProductJobData {
  sku: string;
}

export type NotificationEventPayload =
  | {
      type: 'leader-changed';
      subscriptionId: string;
      chatId: string;
      leaderOfferId: string;
      leaderSellerName: string;
      notification: {
        title: string;
        oldSellerName: string;
        newSellerName: string;
        newPriceMinor: number;
        url: string;
      };
    }
  | {
      type: 'target-price';
      subscriptionId: string;
      chatId: string;
      notification: {
        title: string;
        sellerName: string;
        offerPriceMinor: number;
        targetPriceMinor: number;
        url: string;
      };
    };

export interface SendNotificationJobData {
  eventId: string;
}
