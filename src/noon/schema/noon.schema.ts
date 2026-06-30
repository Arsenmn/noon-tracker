import { Prop, Schema } from '@nestjs/mongoose';

// 1. Схема Товара (Для отслеживания лидера)
@Schema()
export class Product {
  @Prop({ required: true, unique: true })
  sku: string; // Например, 'N70164930V'

  @Prop({ required: true })
  slug: string; // Например, 'edge-60-fusion-5g...'

  @Prop()
  title: string;

  @Prop({ type: Object })
  currentLeader: {
    offerId: string;
    sellerId: string | null;
    sellerName: string;
    priceMinor: number;
  };

  @Prop({ required: true, default: 'AE_DXB-S14' })
  zoneCode: string;

  @Prop()
  lastSuccessfulCheckAt?: Date;
}

// 2. Схема Подписки (Для уведомлений пользователя)
@Schema()
export class PriceAlert {
  @Prop({ required: true })
  userId: string; // ID пользователя в Telegram или вашей системе

  @Prop({ required: true })
  chatId: string;

  @Prop({ required: true })
  sku: string;

  @Prop({ min: 0 })
  targetPriceMinor?: number;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  targetPriceTriggered: boolean;
}
